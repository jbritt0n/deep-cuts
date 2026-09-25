//! Phase 9g — FreqBlog audio features (owner chose audio features over Setlist.fm in the 9b menu).
//!
//! Contract as verified 2026-09-11 (`https://api.freqblog.com/docs`): free tier 1,000 requests/month, no card;
//! header `X-Api-Key`; `GET /lookup?track=&artist=` or `?isrc=`; `POST /bulk` with up to 50 tracks per call
//! (quota counts one request); `202` = queued backfill (retry, or `?wait=N` seconds); `429` carries
//! `Retry-After`. CORS is blocked, so this is server-side only — fine, it's Rust.
//!
//! Budget: ISRC-first lookups (Spotify enrichment fills `tracks.isrc`), batches of 25 (the site's own advice for
//! miss-heavy batches), one tick per 6 h, and a hard stop at 900 requests in a calendar month so the owner keeps
//! headroom. The monthly counter lives in `connector_state.detail` = {"month": "2026-09", "requests": 41}.
//!
//! Phase 9i fix (owner saw HTTP 422): `/bulk` takes a **bare JSON array** `[{track, artist, isrc}, …]` — 9g sent
//! `{"tracks": [...]}`, which FastAPI rejects as 422. Verified against the official MCP client
//! (github.com/stevebirring-star/music-metadata-mcp, index.js `apiPost("/bulk", tracks)`). Also from that source:
//!   * billing is per *item* that returns features or queues an ingest (no-match items are free), not per request;
//!   * lookup endpoints return `RateLimit-Remaining` — the real budget, which we now read instead of guessing;
//!   * a track not yet analysed comes back queued (`backfill_status`), and collecting it later is free — so queued
//!     items are left unwritten and picked up on the next tick rather than recorded as misses.
//! The first successful reply is saved to `<data>/logs/freqblog-sample.json` so field names can be pinned exactly.

use super::set_state;
use crate::db::Db;
use crate::secrets;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

const API: &str = "https://api.freqblog.com";
pub const MONTHLY_CAP: i64 = 900;       // units (items billed), keeps 100 of the free 1,000 in reserve
const RESERVE: i64 = 100;               // stop when the server says fewer than this remain
const BATCH: usize = 25;

fn http() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).user_agent("DeepCuts/3.0 (personal listening analytics)").build()?)
}

fn month_key() -> String { chrono::Utc::now().format("%Y-%m").to_string() }

/// (requests used this month) — resets when the month key changes.
pub fn used_this_month(db: &Db) -> i64 {
    let detail = db.query("SELECT detail FROM connector_state WHERE service = 'freqblog'", &[]).ok()
        .and_then(|r| r.first().and_then(|m| m.get("detail")).cloned()).unwrap_or(Value::Null);
    let d: Value = match &detail { Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null), v => v.clone() };
    if d["month"].as_str() == Some(month_key().as_str()) { d["requests"].as_i64().unwrap_or(0) } else { 0 }
}

/// Server-reported units left this month (RateLimit-Remaining), if seen this month.
pub fn remaining(db: &Db) -> Option<i64> {
    let d = detail(db);
    if d["month"].as_str() == Some(month_key().as_str()) { d["remaining"].as_i64() } else { None }
}
fn detail(db: &Db) -> Value {
    let raw = db.query("SELECT detail FROM connector_state WHERE service = 'freqblog'", &[]).ok().and_then(|r| r.first().and_then(|m| m.get("detail")).cloned()).unwrap_or(Value::Null);
    match &raw { Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null), v => v.clone() }
}
fn set_remaining(db: &Db, rem: i64) -> Result<()> {
    let mut d = detail(db);
    if d["month"].as_str() != Some(month_key().as_str()) { d = json!({ "month": month_key(), "requests": 0 }); }
    d["remaining"] = json!(rem);
    db.exec("UPDATE connector_state SET detail = CAST(? AS JSON) WHERE service = 'freqblog'", &[json!(d.to_string())])?;
    Ok(())
}
/// Keep the first real /bulk reply (≤ 64 KB) for pinning field names; never overwritten once written.
fn save_sample(v: &Value) {
    if let Ok(p) = crate::paths::resolve() {
        let f = p.logs_dir.join("freqblog-sample.json");
        if !f.exists() { let s = serde_json::to_string_pretty(v).unwrap_or_default(); let _ = std::fs::write(&f, &s[..s.len().min(65_536)]); }
    }
}

fn bump_usage(db: &Db, by: i64) -> Result<()> {
    let used = used_this_month(db) + by;
    let mut d = detail(db);
    if d["month"].as_str() != Some(month_key().as_str()) { d = json!({ "month": month_key() }); }
    d["requests"] = json!(used);
    db.exec("UPDATE connector_state SET detail = CAST(? AS JSON), last_sync_at = now() WHERE service = 'freqblog'", &[json!(d.to_string())])?;
    Ok(())
}

/// Validate a key with one cheap lookup, then save it.
pub fn connect(db: &Db, key: &str) -> Result<String> {
    let h = http()?;
    let resp = h.get(format!("{API}/lookup")).header("X-Api-Key", key).query(&[("track", "Bohemian Rhapsody"), ("artist", "Queen")]).send().context("reaching FreqBlog")?;
    let status = resp.status().as_u16();
    let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('freqblog', 'lookup', ?)", &[json!(status as i64)]);
    match status {
        200 | 202 => {}
        401 | 403 => return Err(anyhow!("FreqBlog rejected that key")),
        s => return Err(anyhow!("FreqBlog answered {s} while checking the key")),
    }
    secrets::set(secrets::FREQBLOG_KEY, key)?;
    set_state(db, "freqblog", "connected", Some("free tier"), None);
    bump_usage(db, 1)?;
    db.log_activity("freqblog", "info", "Connected — audio features will fill in a batch every six hours", None);
    Ok("free tier".into())
}

pub fn disconnect(db: &Db) -> Result<()> {
    secrets::delete(secrets::FREQBLOG_KEY)?;
    set_state(db, "freqblog", "disconnected", None, None);
    Ok(())
}

#[derive(Default, Debug)]
struct Feat { isrc: Option<String>, bpm: Option<f64>, bpm_alt: Option<f64>, bpm_conf: Option<f64>, key_name: Option<String>, key_int: Option<i64>, mode: Option<i64>, camelot: Option<String>, energy: Option<f64>, loudness: Option<f64>, dance: Option<f64>, valence: Option<f64>, mood: Option<String>, time_sig: Option<i64>, acoustic: Option<f64>, instrumental: Option<f64>, live: Option<f64>, speech: Option<f64>, genre: Option<String> }

fn f64_of(v: &Value) -> Option<f64> { v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())) }
fn i64_of(v: &Value) -> Option<i64> { v.as_i64().or_else(|| v.as_f64().map(|f| f.round() as i64)).or_else(|| v.as_str().and_then(|s| s.parse().ok())) }
fn str_of(v: &Value) -> Option<String> { v.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) }

/// Phase 9n: find the object that carries the features wherever the reply nests it. FreqBlog's single lookup returns
/// them top-level (`bpm`, `key` "B", `camelot` "1A", `mode` "minor", `energy` …); a /bulk result wraps each track in an
/// object whose key 9g guessed wrong, so every billed hit was recorded as a miss (owner: 0 found, 115 units used).
/// Depth-first search for the first object with a `bpm`, `camelot` or numeric `tempo`, up to 4 levels.
fn feature_obj(v: &Value, depth: u8) -> Option<&Value> {
    if !v.is_object() { return None; }
    if v.get("bpm").map(|b| !b.is_null()).unwrap_or(false) || v.get("camelot").map(|b| !b.is_null()).unwrap_or(false) || v.get("tempo").map(|b| b.is_number()).unwrap_or(false) { return Some(v); }
    if depth == 0 { return None; }
    v.as_object()?.values().find_map(|c| feature_obj(c, depth - 1))
}

fn parse_feat(item: &Value) -> Feat {
    let f = feature_obj(item, 4).unwrap_or(item);
    // "key": "B" + "mode": "minor" → "B minor"
    let mode_word = str_of(&f["mode"]).filter(|m| m.chars().any(|c| c.is_alphabetic()));
    let key_name = str_of(&f["key_name"]).or_else(|| str_of(&f["key"]).filter(|s| s.chars().any(|c| c.is_alphabetic())).map(|k| {
        let kl = k.to_lowercase();
        match &mode_word { Some(m) if !kl.contains("major") && !kl.contains("minor") => format!("{k} {}", m.to_lowercase()), _ => k }
    }));
    let mode = i64_of(&f["mode"]).or_else(|| str_of(&f["mode"]).map(|m| if m.to_lowercase().starts_with("maj") { 1 } else { 0 }))
        .or_else(|| key_name.as_ref().map(|k| if k.to_lowercase().contains("minor") || k.ends_with('m') { 0 } else { 1 }));
    Feat {
        isrc: str_of(&item["isrc"]).or_else(|| str_of(&f["isrc"])),
        bpm: f64_of(&f["bpm"]).or_else(|| f64_of(&f["tempo"])), bpm_alt: f64_of(&f["bpm_alt"]).or_else(|| f64_of(&f["tempo_alt"])), bpm_conf: f64_of(&f["bpm_confidence"]).or_else(|| f64_of(&f["tempo_confidence"])),
        key_int: i64_of(&f["key_int"]).or_else(|| i64_of(&f["key"])), key_name, mode, camelot: str_of(&f["camelot"]),
        energy: f64_of(&f["energy"]), loudness: f64_of(&f["loudness_db"]).or_else(|| f64_of(&f["loudness"])), dance: f64_of(&f["danceability"]), valence: f64_of(&f["valence"]),
        mood: str_of(&f["mood"]), time_sig: i64_of(&f["time_signature"]), acoustic: f64_of(&f["acousticness"]), instrumental: f64_of(&f["instrumentalness"]), live: f64_of(&f["liveness"]), speech: f64_of(&f["speechiness"]), genre: str_of(&f["genre"]),
    }
}

/// A bulk reply may be an array, or an object holding one under results / tracks / items / data.
fn parse_items(v: &Value) -> Vec<Value> {
    if let Some(a) = v.as_array() { return a.clone(); }
    for k in ["results", "tracks", "items", "data"] { if let Some(a) = v[k].as_array() { return a.clone(); } }
    Vec::new()
}

/// Most-played tracks without features (or with a 90-day-old miss), ISRC first. Returns tracks featured this call.
pub fn enrich(db: &Db, max_tracks: usize) -> Result<usize> {
    let Some(key) = secrets::get(secrets::FREQBLOG_KEY)? else { return Ok(0) };
    if used_this_month(db) >= MONTHLY_CAP { return Ok(0); }
    let rows = db.query(&format!(
        "SELECT t.track_id, t.name, a.name AS artist, t.isrc FROM tracks t JOIN artists a USING (artist_id)
         JOIN (SELECT track_id, COUNT(*) c FROM plays_resolved WHERE attended GROUP BY 1) p USING (track_id)
         LEFT JOIN track_features f USING (track_id)
         WHERE t.name IS NOT NULL AND (f.track_id IS NULL OR (NOT f.found AND f.fetched_at < now() - INTERVAL 90 DAY))
         ORDER BY (t.isrc IS NOT NULL) DESC, p.c DESC LIMIT {max_tracks}"), &[])?;
    if rows.is_empty() { return Ok(0); }
    let h = http()?;
    let mut done = 0usize;
    for chunk in rows.chunks(BATCH) {
        if used_this_month(db) >= MONTHLY_CAP || remaining(db).map(|r| r < RESERVE).unwrap_or(false) { break; }
        let g = |r: &serde_json::Map<String, Value>, k: &str| r.get(k).and_then(|v| v.as_str()).map(str::to_string);
        // FreqBlog matches ISRC first and falls back to the name, so send both when we have them
        let body: Vec<Value> = chunk.iter().map(|r| { let mut o = serde_json::Map::new(); if let Some(i) = g(r, "isrc") { o.insert("isrc".into(), json!(i)); } if let Some(t) = g(r, "name") { o.insert("track".into(), json!(t.chars().take(200).collect::<String>())); } if let Some(a) = g(r, "artist") { o.insert("artist".into(), json!(a.chars().take(200).collect::<String>())); } Value::Object(o) }).collect();
        let mut attempt = 0;
        let v: Value = loop {
            let resp = h.post(format!("{API}/bulk")).header("X-Api-Key", &key).json(&Value::Array(body.clone())).send().context("FreqBlog /bulk")?;
            let status = resp.status().as_u16();
            let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('freqblog', 'bulk', ?)", &[json!(status as i64)]);
            if let Some(rem) = resp.headers().get("ratelimit-remaining").and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<i64>().ok()) {
                set_remaining(db, rem)?;
                if rem < RESERVE { set_state(db, "freqblog", "connected", None, Some(&format!("{rem} units left this month — pausing until the reset"))); }
            }
            match status {
                200 => {
                    let v: Value = resp.json().unwrap_or(Value::Null);
                    let units = v["found"].as_i64().or_else(|| v["billed"].as_i64()).unwrap_or(chunk.len() as i64);
                    bump_usage(db, units)?;
                    save_sample(&v);
                    break v;
                }
                422 | 400 => {
                    let detail = resp.text().unwrap_or_default();
                    log::warn!("FreqBlog /bulk rejected the request ({status}): {detail}");
                    set_state(db, "freqblog", "error", None, Some(&format!("HTTP {status}: {}", detail.chars().take(160).collect::<String>())));
                    return Ok(done);
                }
                202 if attempt < 2 => { attempt += 1; std::thread::sleep(Duration::from_secs(15)); continue; }   // still analysing; costs a request each time, so twice only
                202 => break Value::Null,
                429 => { let wait = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<u64>().ok()).unwrap_or(60).min(600); set_state(db, "freqblog", "connected", None, Some(&format!("rate limited, retrying in {wait}s"))); std::thread::sleep(Duration::from_secs(wait)); if attempt < 1 { attempt += 1; continue; } return Ok(done); }
                401 | 403 => { set_state(db, "freqblog", "error", None, Some("key rejected")); return Err(anyhow!("FreqBlog rejected the key")); }
                s => { set_state(db, "freqblog", "connected", None, Some(&format!("HTTP {s}"))); return Ok(done); }
            }
        };
        let items = parse_items(&v);
        // match replies to our tracks: by isrc when both sides have one, else by position
        for (i, r) in chunk.iter().enumerate() {
            let Some(id) = g(r, "track_id") else { continue };
            let want_isrc = g(r, "isrc");
            // match the reply to this request: ISRC anywhere in the item, then track + artist names, then position
            let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
            let (want_t, want_a) = (g(r, "name").map(|x| norm(&x)), g(r, "artist").map(|x| norm(&x)));
            let want_i = want_isrc.as_deref().map(|x| x.replace('-', "").to_uppercase());
            let isrc_of = |it: &Value| -> Option<String> { str_of(&it["isrc"]).or_else(|| str_of(&it["query"]["isrc"])).or_else(|| feature_obj(it, 4).and_then(|f| str_of(&f["isrc"]))).map(|x| x.replace('-', "").to_uppercase()) };
            let names_of = |it: &Value| -> (Option<String>, Option<String>) {
                let f = feature_obj(it, 4).unwrap_or(it);
                let t = str_of(&f["track_name"]).or_else(|| str_of(&it["query"]["track"])).or_else(|| it["track"].as_str().map(str::to_string));
                let a = str_of(&f["artist_name"]).or_else(|| str_of(&it["query"]["artist"])).or_else(|| it["artist"].as_str().map(str::to_string));
                (t.map(|x| norm(&x)), a.map(|x| norm(&x)))
            };
            let item = items.iter().find(|it| want_i.is_some() && isrc_of(it) == want_i)
                .or_else(|| items.iter().find(|it| { let (t, a) = names_of(it); want_t.is_some() && t == want_t && (a == want_a || a.is_none()) }))
                .or_else(|| items.get(i));
            // queued for on-demand analysis → leave unwritten; the next tick collects it for free
            let backfill = item.and_then(|it| it["backfill_status"].as_str()).unwrap_or("").to_lowercase();
            if ["queue", "pending", "processing", "ingest", "running"].iter().any(|k| backfill.contains(k)) || backfill == "over_limit" { continue; }
            // the features themselves are the proof of a hit (the item's own flags were read wrongly in 9g)
            let ft = item.map(parse_feat).unwrap_or_default();
            let found = ft.bpm.is_some() || ft.key_name.is_some() || ft.camelot.is_some() || ft.energy.is_some();
            db.exec("INSERT OR REPLACE INTO track_features (track_id, isrc, bpm, bpm_alt, bpm_confidence, key_name, key_int, mode, camelot, energy, loudness_db, danceability, valence, mood, time_signature, acousticness, instrumentalness, liveness, speechiness, genre, feature_source, found, fetched_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())",
                &[json!(id), json!(ft.isrc.or(want_isrc.clone())), json!(ft.bpm), json!(ft.bpm_alt), json!(ft.bpm_conf), json!(ft.key_name), json!(ft.key_int), json!(ft.mode), json!(ft.camelot), json!(ft.energy), json!(ft.loudness), json!(ft.dance), json!(ft.valence), json!(ft.mood), json!(ft.time_sig), json!(ft.acoustic), json!(ft.instrumental), json!(ft.live), json!(ft.speech), json!(ft.genre), json!(if want_isrc.is_some() { "isrc" } else { "name" }), json!(found)])?;
            if found { done += 1; }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    set_state(db, "freqblog", "connected", None, None);
    if done > 0 { db.log_activity("freqblog", "info", &format!("Audio features for {done} tracks ({} of {MONTHLY_CAP} requests used this month)", used_this_month(db)), None); }
    Ok(done)
}
