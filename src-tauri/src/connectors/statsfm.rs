//! CON-08…10 — stats.fm import. Best-effort against the public API
//! (https://api.stats.fm/api/v1); field names are read defensively because the
//! API is not formally versioned. Rows become events with source='statsfm_import'
//! and are deduped through the same tolerance rule as the poller (CON-11).

use super::set_state;
use crate::db::Db;
use crate::secrets;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

const API: &str = "https://api.stats.fm/api/v1";

fn http(key: &str) -> Result<reqwest::blocking::Client> {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert(reqwest::header::AUTHORIZATION, format!("Bearer {key}").parse()?);
    Ok(reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).user_agent("DeepCuts/3.0").default_headers(h).build()?)
}

fn s(v: &Value) -> Option<String> { v.as_str().map(str::to_string) }

pub fn connect(db: &Db, key: &str) -> Result<String> {
    let v: Value = http(key)?.get(format!("{API}/users/me")).send()?.error_for_status().context("stats.fm rejected the key")?.json()?;
    let item = if v["item"].is_object() { &v["item"] } else { &v };
    let name = s(&item["displayName"]).or(s(&item["customId"])).or(s(&item["id"])).ok_or_else(|| anyhow!("stats.fm response had no user"))?;
    let id = s(&item["customId"]).or(s(&item["id"])).unwrap_or_else(|| name.clone());
    secrets::set(secrets::STATSFM_KEY, key)?;
    set_state(db, "statsfm", "connected", Some(&name), None);
    let _ = db.exec("UPDATE connector_state SET detail = CAST(? AS JSON) WHERE service = 'statsfm'", &[json!(json!({ "userId": id }).to_string())]);
    db.log_activity("statsfm", "info", &format!("Connected as {name}"), None);
    Ok(name)
}

pub fn disconnect(db: &Db) -> Result<()> { secrets::delete(secrets::STATSFM_KEY)?; set_state(db, "statsfm", "disconnected", None, None); Ok(()) }

/// Pull streams newest-first until we hit ones we already have, max `max_pages` × 1000.
pub fn import(db: &Db, max_pages: usize) -> Result<i64> {
    let Some(key) = secrets::get(secrets::STATSFM_KEY)? else { anyhow::bail!("stats.fm is not connected") };
    let user = db.query("SELECT detail FROM connector_state WHERE service = 'statsfm'", &[])?.first()
        .and_then(|r| r.get("detail")).and_then(|v| v.as_str().map(str::to_string)).and_then(|d| serde_json::from_str::<Value>(&d).ok())
        .and_then(|d| s(&d["userId"])).unwrap_or_else(|| "me".into());
    let h = http(&key)?;
    let mut before: Option<i64> = None;
    let mut added = 0i64;
    for _ in 0..max_pages {
        let mut url = format!("{API}/users/{user}/streams?limit=1000");
        if let Some(b) = before { url.push_str(&format!("&before={b}")); }
        let v: Value = h.get(&url).send()?.error_for_status().context("stats.fm streams request failed")?.json()?;
        let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('statsfm', 'streams', 200)", &[]);
        let items = v["items"].as_array().cloned().unwrap_or_default();
        if items.is_empty() { break; }
        let mut page_new = 0i64;
        for it in &items {
            let Some(end) = s(&it["endTime"]) else { continue };
            let dur = it["durationMs"].as_i64().or(it["playedMs"].as_i64()).unwrap_or(0);
            let end_dt = chrono::DateTime::parse_from_rfc3339(&end).context("stats.fm endTime")?;
            let start = end_dt - chrono::Duration::milliseconds(dur);
            let track = &it["track"];
            let tid = s(&it["trackId"]).or(track["id"].as_i64().map(|x| x.to_string()));
            let spotify_id = track["externalIds"]["spotify"].get(0).and_then(|x| x.as_str()).map(str::to_string);
            let payload = json!({
                "spotify_track_uri": spotify_id.as_ref().map(|i| format!("spotify:track:{i}")),
                "spotify_track_id": spotify_id,
                "track_name": s(&track["name"]).or(s(&it["trackName"])),
                "artist_name": track["artists"].get(0).and_then(|a| s(&a["name"])).or(s(&it["artistName"])),
                "album_name": s(&track["albums"][0]["name"]).or(s(&it["albumName"])),
                "ms_played": dur, "platform": "statsfm", "end_reason": "unknown", "start_reason": "unknown",
                "source": "statsfm_import", "statsfm_track_id": tid
            });
            let end_epoch = end_dt.timestamp() as f64 + (end_dt.timestamp_subsec_millis() as f64) / 1000.0;
            let n = if let Some(sid) = payload["spotify_track_id"].as_str() {
                db.exec(crate::db::POLL_INSERT_SQL, &[json!(start.to_rfc3339()), json!(sid), json!(payload.to_string()), json!(end_epoch)])?
            } else {
                db.exec("INSERT INTO events (event_type, occurred_at, payload, source_file) SELECT 'play', CAST(?1 AS TIMESTAMPTZ), CAST(?2 AS JSON), 'statsfm_import'
                         WHERE NOT EXISTS (SELECT 1 FROM plays_normalized p WHERE lower(p.track_name) = lower(?3) AND abs(epoch(p.played_at_utc) - ?4) <= 2.0)",
                    &[json!(start.to_rfc3339()), json!(payload.to_string()), json!(payload["track_name"].as_str().unwrap_or("")), json!(end_epoch)])?
            };
            page_new += n as i64;
            before = Some(end_dt.timestamp_millis());
        }
        added += page_new;
        // stop when a whole page was already known — we've reached history we have
        if page_new == 0 { break; }
    }
    if added > 0 {
        db.exec("UPDATE connector_state SET plays_added = plays_added + ?, last_sync_at = now(), status = 'connected', last_error = NULL WHERE service = 'statsfm'", &[json!(added)])?;
        db.exec_batch(crate::db::ENTITY_RESOLUTION_SQL)?; db.exec_batch(crate::db::COMPUTE_SESSIONS_SQL)?;
    } else { set_state(db, "statsfm", "connected", None, None); }
    db.log_activity("statsfm", "info", &format!("stats.fm import: +{added} plays"), None);
    Ok(added)
}
