//! API-01: Authorization Code with PKCE. A one-shot HTTP listener on
//! 127.0.0.1:8888 catches the redirect; the system browser handles consent.
//! Tokens live in the OS keyring only.

use super::endpoints as ep;
use crate::secrets;
use anyhow::{anyhow, Context, Result};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64, // epoch seconds
    pub scope: String,
}

impl Tokens {
    pub fn is_expired(&self) -> bool {
        now_secs() + 60 >= self.expires_at
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_string(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    b64url(&buf)
}

pub fn load_tokens() -> Result<Option<Tokens>> {
    Ok(match secrets::get(secrets::SPOTIFY_TOKENS)? {
        Some(raw) => Some(serde_json::from_str(&raw).context("stored Spotify tokens are unreadable")?),
        None => None,
    })
}

pub fn save_tokens(t: &Tokens) -> Result<()> {
    secrets::set(secrets::SPOTIFY_TOKENS, &serde_json::to_string(t)?)
}

pub fn clear_tokens() -> Result<()> {
    secrets::delete(secrets::SPOTIFY_TOKENS)
}

/// Full interactive login. Blocks until the browser redirects back (or 5 min).
/// `open_url` is injected so this module has no Tauri dependency.
pub fn login(client_id: &str, open_url: &dyn Fn(&str) -> Result<()>) -> Result<Tokens> {
    let verifier = random_string(64);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = random_string(16);

    let listener = TcpListener::bind(ep::LOOPBACK_BIND)
        .with_context(|| format!("binding {} — is another Deep Cuts login in progress?", ep::LOOPBACK_BIND))?;
    listener.set_nonblocking(false)?;

    let url = format!(
        "{}?client_id={}&response_type=code&redirect_uri={}&scope={}&code_challenge_method=S256&code_challenge={}&state={}",
        ep::ACCOUNTS_AUTHORIZE,
        urlencoding::encode(client_id),
        urlencoding::encode(ep::REDIRECT_URI),
        urlencoding::encode(ep::SCOPES),
        challenge,
        state
    );
    open_url(&url)?;

    // Wait for exactly one redirect. Browsers may also request /favicon.ico; ignore those.
    let deadline = std::time::Instant::now() + Duration::from_secs(300);
    let code = loop {
        if std::time::Instant::now() > deadline {
            return Err(anyhow!("Login timed out after 5 minutes"));
        }
        let (mut stream, _) = listener.accept()?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let first = req.lines().next().unwrap_or("").to_string();
        let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
        if !path.starts_with("/callback") {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        }
        let parsed = url::Url::parse(&format!("http://127.0.0.1{path}"))?;
        let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        let body: &str;
        let result = if q.get("state").map(String::as_str) != Some(state.as_str()) {
            body = PAGE_ERR;
            Err(anyhow!("Login state mismatch — please try again"))
        } else if let Some(err) = q.get("error") {
            body = PAGE_ERR;
            Err(anyhow!("Spotify said: {err}"))
        } else if let Some(code) = q.get("code") {
            body = PAGE_OK;
            Ok(code.clone())
        } else {
            body = PAGE_ERR;
            Err(anyhow!("No code in the redirect"))
        };
        let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes());
        let _ = stream.flush();
        break result?;
    };
    drop(listener);

    let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build()?;
    let resp = http
        .post(ep::ACCOUNTS_TOKEN)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", ep::REDIRECT_URI),
            ("client_id", client_id),
            ("code_verifier", verifier.as_str()),
        ])
        .send()?;
    let status = resp.status();
    let json: serde_json::Value = resp.json().context("token response was not JSON")?;
    if !status.is_success() {
        return Err(anyhow!("Token exchange failed ({status}): {}", json["error_description"].as_str().unwrap_or("unknown")));
    }
    let t = Tokens {
        access_token: json["access_token"].as_str().ok_or_else(|| anyhow!("no access_token"))?.to_string(),
        refresh_token: json["refresh_token"].as_str().ok_or_else(|| anyhow!("no refresh_token"))?.to_string(),
        expires_at: now_secs() + json["expires_in"].as_u64().unwrap_or(3600),
        scope: json["scope"].as_str().unwrap_or(ep::SCOPES).to_string(),
    };
    save_tokens(&t)?;
    Ok(t)
}

pub fn refresh(client_id: &str, t: &Tokens) -> Result<Tokens> {
    let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build()?;
    let resp = http
        .post(ep::ACCOUNTS_TOKEN)
        .form(&[("grant_type", "refresh_token"), ("refresh_token", t.refresh_token.as_str()), ("client_id", client_id)])
        .send()?;
    let status = resp.status();
    let json: serde_json::Value = resp.json()?;
    if !status.is_success() {
        return Err(anyhow!("Token refresh failed ({status}): {}", json["error_description"].as_str().unwrap_or("unknown")));
    }
    let nt = Tokens {
        access_token: json["access_token"].as_str().ok_or_else(|| anyhow!("no access_token"))?.to_string(),
        // Spotify may or may not rotate the refresh token.
        refresh_token: json["refresh_token"].as_str().map(str::to_string).unwrap_or_else(|| t.refresh_token.clone()),
        expires_at: now_secs() + json["expires_in"].as_u64().unwrap_or(3600),
        scope: json["scope"].as_str().unwrap_or(&t.scope).to_string(),
    };
    save_tokens(&nt)?;
    Ok(nt)
}

const PAGE_OK: &str = r#"<!doctype html><html><body style="background:#141118;color:#EFE9F4;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="width:56px;height:56px;border-radius:50%;border:2px solid #F2A93B;margin:0 auto 20px;position:relative"><div style="position:absolute;inset:18px;border-radius:50%;background:#F2A93B"></div></div><h1 style="font-weight:400">Deep Cuts is connected to Spotify</h1><p style="color:#9C93AD">You can close this tab and go back to the app.</p></div></body></html>"#;
const PAGE_ERR: &str = r#"<!doctype html><html><body style="background:#141118;color:#EFE9F4;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-weight:400">That didn't work</h1><p style="color:#9C93AD">Go back to Deep Cuts and try connecting again.</p></div></body></html>"#;
