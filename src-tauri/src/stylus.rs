//! Phase 9m — Stylus S1: a ListenBrainz-compatible scrobble receiver (docs/STYLUS-SPEC.md).
//!
//! Endpoints (also accepted under the `/apis/listenbrainz` prefix some clients add):
//!   GET  /1/validate-token          → {"code":200,"valid":true|false,…}
//!   POST /1/submit-listens          → {"status":"ok"}   (Authorization: Token <device token>)
//! The receiver only authenticates and drops the body into `stylus_inbox`; `stylus_process.sql` parses it, applies the
//! device's privacy settings and dedupes against Spotify. New plays are folded into the record by a resolver thread at
//! most once a minute (the same entity_resolution.sql the Spotify poll runs).
//! Binds 127.0.0.1 unless the owner turns LAN on (Services → Stylus). Tokens are 32 random bytes, stored as SHA-256.

use crate::db::Db;
use anyhow::{anyhow, Result};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

pub const DEFAULT_PORT: u16 = 4749;
const MAX_BODY: u64 = 2_000_000;

static SERVER: Mutex<Option<(Arc<Server>, String)>> = Mutex::new(None);
static DIRTY: AtomicBool = AtomicBool::new(false);
static RESOLVER: AtomicBool = AtomicBool::new(false);

pub fn hash_token(token: &str) -> String { format!("{:x}", Sha256::digest(token.trim().as_bytes())) }

pub fn new_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn setting(db: &Db, key: &str) -> Option<String> {
    db.query("SELECT value FROM app_meta WHERE key = ?", &[json!(key)]).ok()
        .and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str().map(str::to_string)))
}

/// Address the receiver is listening on, if running.
pub fn running() -> Option<String> { SERVER.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|(_, a)| a.clone()) }

pub fn stop() {
    if let Some((s, addr)) = SERVER.lock().unwrap_or_else(|p| p.into_inner()).take() {
        s.unblock();
        log::info!("Stylus stopped on {addr}");
    }
}

/// (Re)start from the saved settings. Returns the bound address.
pub fn start(db: Arc<Db>) -> Result<String> {
    stop();
    let port = setting(&db, "stylus_port").and_then(|p| p.trim().parse::<u16>().ok()).unwrap_or(DEFAULT_PORT);
    let lan = setting(&db, "stylus_lan").as_deref() == Some("true");
    let addr = format!("{}:{port}", if lan { "0.0.0.0" } else { "127.0.0.1" });
    let server = Arc::new(Server::http(addr.as_str()).map_err(|e| anyhow!("Stylus could not listen on {addr}: {e}"))?);
    *SERVER.lock().unwrap_or_else(|p| p.into_inner()) = Some((server.clone(), addr.clone()));
    let d = db.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() { handle(&d, req); }
    });
    if !RESOLVER.swap(true, Ordering::SeqCst) {
        let d = db.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(60));
            if DIRTY.swap(false, Ordering::SeqCst) {
                if let Err(e) = d.exec_batch(crate::db::ENTITY_RESOLUTION_SQL) { log::warn!("Stylus resolve: {e:#}"); DIRTY.store(true, Ordering::SeqCst); }
            }
        });
    }
    db.log_activity("stylus", "info", &format!("Stylus listening on {addr}"), None);
    Ok(addr)
}

fn device_for(db: &Db, token: &str) -> Option<(String, String)> {
    db.query("SELECT device_id, name FROM stylus_devices WHERE token_hash = ?", &[json!(hash_token(token))]).ok()
        .and_then(|r| r.first().map(|m| (m.get("device_id").and_then(|v| v.as_str()).unwrap_or("").to_string(), m.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string())))
        .filter(|(id, _)| !id.is_empty())
}

fn header(name: &str, value: &str) -> Header { Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header") }

fn reply(req: Request, code: u16, body: Value) {
    let resp = Response::from_string(body.to_string())
        .with_status_code(StatusCode(code))
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Access-Control-Allow-Origin", "*"))
        .with_header(header("Access-Control-Allow-Headers", "Authorization, Content-Type"));
    let _ = req.respond(resp);
}

fn handle(db: &Db, mut req: Request) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("").trim_end_matches('/').replacen("/apis/listenbrainz", "", 1);
    let method = req.method().clone();
    if method == Method::Options { reply(req, 204, json!({})); return; }
    let token = req.headers().iter().find(|h| h.field.equiv("Authorization")).map(|h| h.value.as_str().trim().to_string())
        .and_then(|v| v.strip_prefix("Token ").or_else(|| v.strip_prefix("token ")).map(|s| s.trim().to_string()))
        .or_else(|| url.split_once("token=").map(|(_, t)| t.split('&').next().unwrap_or("").to_string()));
    let device = token.as_deref().filter(|t| !t.is_empty()).and_then(|t| device_for(db, t));
    match (method, path.as_str()) {
        (Method::Get, "/1/validate-token") => match device {
            Some((_, name)) => reply(req, 200, json!({ "code": 200, "message": "Token valid.", "valid": true, "user_name": format!("deepcuts-{name}") })),
            None => reply(req, 200, json!({ "code": 200, "message": "Token invalid.", "valid": false })),
        },
        (Method::Post, "/1/submit-listens") => {
            let Some((id, _)) = device else { return reply(req, 401, json!({ "code": 401, "error": "Invalid authorization token." })) };
            let mut body = String::new();
            if req.as_reader().take(MAX_BODY).read_to_string(&mut body).is_err() { return reply(req, 400, json!({ "code": 400, "error": "Could not read the request body." })); }
            let ok = serde_json::from_str::<Value>(&body).ok().filter(|v| v["payload"].is_array() && v["listen_type"].is_string()).is_some();
            if !ok { return reply(req, 400, json!({ "code": 400, "error": "Expected {\"listen_type\": …, \"payload\": [ … ]}." })); }
            let res = db.exec("INSERT INTO stylus_inbox (device_id, body) VALUES (?, ?)", &[json!(id), json!(body)])
                .and_then(|_| db.exec_batch(crate::db::STYLUS_PROCESS_SQL));
            match res {
                Ok(()) => { DIRTY.store(true, Ordering::SeqCst); reply(req, 200, json!({ "status": "ok" })) }
                Err(e) => { log::warn!("Stylus submit: {e:#}"); reply(req, 500, json!({ "code": 500, "error": "Could not store the listens." })) }
            }
        }
        _ => reply(req, 404, json!({ "code": 404, "error": "Not found. Stylus speaks /1/validate-token and /1/submit-listens." })),
    }
}
