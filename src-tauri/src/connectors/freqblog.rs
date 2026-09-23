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
//! The response shape is parsed defensively (see `parse_items`): FreqBlog's docs were read but a real `/bulk`
//! response was not recorded in 9b — the first compile should fix any field name against a live reply and add
//! it to `docs/` as a fixture (Kimi T5).

use super::set_state;
use crate::db::Db;
use crate::secrets;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

const API: &str = "https://api.freqblog.com";
pub const MONTHLY_CAP: i64 = 900;
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

fn bump_usage(db: &Db, by: i64) -> Result<()> {
    let used = used_this_month(db) + by;
    db.exec("UPDATE connector_state SET detail = CAST(? AS JSON), last_sync_at = now() WHERE service = 'freqblog'", &[json!(json!({ "month": month_key(), "requests": used }).to_string())])?;
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

/// Accept the feature object flat or nested under `features` / `audio_features` / `analysis`.
fn parse_feat(item: &Value) -> Feat {
    let f = ["features", "audio_features", "analysis", "data"].iter().map(|k| &item[*k]).find(|v| v.is_object()).unwrap_or(item);
    let key_name = str_of(&f["key_name"]).or_else(|| str_of(&f["key"]).filter(|s| s.chars().any(|c| c.is_alphabetic())));
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
        if used_this_month(db) >= MONTHLY_CAP { break; }
        let g = |r: &serde_json::Map<String, Value>, k: &str| r.get(k).and_then(|v| v.as_str()).map(str::to_string);
        let body: Vec<Value> = chunk.iter().map(|r| match g(r, "isrc") { Some(i) => json!({ "isrc": i, "track": g(r, "name"), "artist": g(r, "artist") }), None => json!({ "track": g(r, "name"), "artist": g(r, "artist") }) }).collect();
        let mut attempt = 0;
        let v: Value = loop {
            let resp = h.post(format!("{API}/bulk")).header("X-Api-Key", &key).query(&[("wait", "20")]).json(&json!({ "tracks": body })).send().context("FreqBlog /bulk")?;
            let status = resp.status().as_u16();
            let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('freqblog', 'bulk', ?)", &[json!(status as i64)]);
            bump_usage(db, 1)?;
            match status {
                200 => break resp.json().unwrap_or(Value::Null),
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
            let item = items.iter().find(|it| want_isrc.is_some() && (str_of(&it["isrc"]).as_deref() == want_isrc.as_deref() || str_of(&it["query"]["isrc"]).as_deref() == want_isrc.as_deref()))
                .or_else(|| items.get(i));
            let found = item.map(|it| !it["error"].is_string() && it["found"] != Value::Bool(false) && it["status"].as_str() != Some("not_found")).unwrap_or(false);
            let ft = item.map(parse_feat).unwrap_or_default();
            let found = found && (ft.bpm.is_some() || ft.key_name.is_some() || ft.energy.is_some());
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
