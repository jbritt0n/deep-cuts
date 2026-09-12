//! Phase 8 — Heard in the Wild. Imports Last.fm scrobbles written by a
//! phone-side scrobbler (Pano Scrobbler → Google Now Playing + Shazam) as
//! `wild_play` events: a separate class the core pipeline never reads.
//!
//! Reuses the Last.fm API key already in the keyring. The account can be the
//! owner's main one or — the cleanest setup — a second Last.fm account that
//! only the phone scrobbles to. Either way, every capture is checked against
//! the owner's primary plays at ingest (sql/wild_insert.sql) so overheard
//! Spotify playback is dropped rather than double-counted.
//!
//! Only scrobbles on/after `wild_since` (app_meta, default = the moment the
//! connector was set up) are imported: an older main-account history is the
//! owner's *chosen* listening and belongs to the export, not to this class.

use super::set_state;
use crate::connectors::lastfm;
use crate::db::Db;
use crate::secrets;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

const PAGE: usize = 200;

fn s(v: &Value) -> Option<String> { v.as_str().map(str::to_string).filter(|x| !x.is_empty()) }

fn meta(db: &Db, key: &str) -> Option<String> {
    db.query("SELECT value FROM app_meta WHERE key = ?", &[json!(key)]).ok()
        .and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str().map(str::to_string)))
}

fn set_meta(db: &Db, key: &str, value: &str) -> Result<()> {
    db.exec("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", &[json!(key), json!(value)])?;
    Ok(())
}

/// Validate the account and remember it. `username` may be empty to reuse the
/// Last.fm connector's username. `since` is an ISO date (YYYY-MM-DD) or empty
/// for "from now on".
pub fn connect(db: &Db, username: &str, since: &str) -> Result<String> {
    let Some(key) = secrets::get(secrets::LASTFM_KEY)? else { anyhow::bail!("Connect Last.fm first — Heard in the Wild reuses its API key") };
    let user = if username.trim().is_empty() {
        secrets::get(secrets::LASTFM_USER)?.ok_or_else(|| anyhow!("No Last.fm username saved; enter the account Pano scrobbles to"))?
    } else { username.trim().to_string() };
    let v = lastfm::call(db, &key, "user.getInfo", &[("user", &user)]).context("checking the Last.fm account")?;
    let name = v["user"]["name"].as_str().ok_or_else(|| anyhow!("Last.fm didn't recognise that username"))?.to_string();
    let since_uts: i64 = if since.trim().is_empty() { chrono::Utc::now().timestamp() } else {
        let d = chrono::NaiveDate::parse_from_str(since.trim(), "%Y-%m-%d").map_err(|_| anyhow!("Since must be a date like 2026-09-11"))?;
        d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp()
    };
    set_meta(db, "wild_lastfm_user", &name)?;
    set_meta(db, "wild_since", &since_uts.to_string())?;
    set_state(db, "lastfm_wild", "connected", Some(&name), None);
    db.exec("UPDATE connector_state SET detail = CAST(? AS JSON) WHERE service = 'lastfm_wild'", &[json!(json!({ "backfillDone": false, "dropped": 0 }).to_string())])?;
    db.log_activity("wild", "info", &format!("Heard in the Wild connected as {name}"), None);
    Ok(name)
}

/// Phase 9: the owner's first import pulled their own Spotify history because Pano was scrobbling to a
/// Last.fm account Spotify also wrote to. Wipe every capture and point at a new (Pano-only) account.
/// Captures are the only `wild_play` rows, so this touches nothing in the core record. Returns rows purged.
pub fn reset_and_repoint(db: &Db, username: &str, since: &str) -> Result<(i64, String)> {
    let purged = db.scalar_i64("SELECT COUNT(*) FROM events WHERE event_type = 'wild_play'")?;
    db.exec("DELETE FROM events WHERE event_type = 'wild_play'", &[])?;
    db.exec("DELETE FROM recommendation_feedback WHERE engine = 'wild'", &[])?;
    db.exec("UPDATE connector_state SET plays_added = 0, last_sync_at = NULL, last_error = NULL WHERE service = 'lastfm_wild'", &[])?;
    db.log_activity("wild", "warn", &format!("Heard in the Wild reset: {purged} captures purged (they were the owner's own Spotify playback)"), None);
    let name = connect(db, username, since)?;
    Ok((purged, name))
}

pub fn disconnect(db: &Db) -> Result<()> {
    set_state(db, "lastfm_wild", "disconnected", None, None);
    db.log_activity("wild", "info", "Heard in the Wild disconnected (captures already imported are kept)", None);
    Ok(())
}

fn detail(db: &Db) -> Value {
    db.query("SELECT detail FROM connector_state WHERE service = 'lastfm_wild'", &[]).ok()
        .and_then(|r| r.first().and_then(|m| m.get("detail")).and_then(|v| v.as_str().map(str::to_string)))
        .and_then(|d| serde_json::from_str::<Value>(&d).ok()).unwrap_or_else(|| json!({}))
}

/// One capture → one `wild_insert.sql` attempt. Returns 1 if inserted, 0 if deduplicated.
fn insert_one(db: &Db, t: &Value) -> Result<usize> {
    let Some(uts) = t["date"]["uts"].as_str().and_then(|x| x.parse::<i64>().ok()).or(t["date"]["uts"].as_i64()) else { return Ok(0) }; // "now playing" rows have no date
    let track = s(&t["name"]).unwrap_or_default();
    let artist = s(&t["artist"]["#text"]).or(s(&t["artist"]["name"])).unwrap_or_default();
    if track.is_empty() || artist.is_empty() { return Ok(0); }
    let album = s(&t["album"]["#text"]);
    let mbid = s(&t["mbid"]);
    let at = chrono::DateTime::<chrono::Utc>::from_timestamp(uts, 0).ok_or_else(|| anyhow!("bad scrobble timestamp {uts}"))?;
    let payload = json!({ "track_name": track, "artist_name": artist, "album_name": album, "lastfm_uts": uts, "mbid": mbid, "source": "lastfm_wild", "platform": "pano" });
    db.exec(crate::db::WILD_INSERT_SQL, &[json!(at.to_rfc3339()), json!(payload.to_string()), json!(track), json!(artist), json!(uts)])
}

/// Pull new scrobbles since the newest one we have (bounded below by `wild_since`),
/// then keep back-filling the window [wild_since, oldest-seen) a few pages per
/// tick until it is exhausted. Returns captures added (after dedup).
pub fn import(db: &Db, max_pages: usize) -> Result<i64> {
    let Some(key) = secrets::get(secrets::LASTFM_KEY)? else { anyhow::bail!("Last.fm is not connected") };
    let user = meta(db, "wild_lastfm_user").ok_or_else(|| anyhow!("Heard in the Wild is not set up"))?;
    let since: i64 = meta(db, "wild_since").and_then(|v| v.parse().ok()).unwrap_or(0);
    let newest: Option<i64> = db.query("SELECT MAX(lastfm_uts) AS m FROM wild_plays", &[])?.first().and_then(|r| r.get("m")).and_then(|v| v.as_i64());
    let mut d = detail(db);
    let mut added = 0i64;
    let mut dropped = 0i64;
    let mut pages_left = max_pages.max(1);

    // 1) Incremental: everything newer than what we hold.
    let from = newest.map(|n| (n + 1).max(since)).unwrap_or(since);
    let mut page = 1usize;
    loop {
        if pages_left == 0 { break; }
        let v = lastfm::call(db, &key, "user.getRecentTracks", &[("user", &user), ("limit", &PAGE.to_string()), ("page", &page.to_string()), ("from", &from.to_string())])?;
        pages_left -= 1;
        let items = v["recenttracks"]["track"].as_array().cloned().unwrap_or_default();
        let total_pages = v["recenttracks"]["@attr"]["totalPages"].as_str().and_then(|x| x.parse::<usize>().ok()).unwrap_or(1);
        for t in &items { let n = insert_one(db, t)?; if n == 1 { added += 1 } else if t["date"]["uts"].is_string() || t["date"]["uts"].is_number() { dropped += 1 } }
        if page >= total_pages || items.is_empty() { break; }
        page += 1;
    }

    // 2) Backfill the gap below the oldest capture, down to `wild_since`.
    let backfill_done = d["backfillDone"].as_bool().unwrap_or(false);
    if !backfill_done && pages_left > 0 {
        let oldest: Option<i64> = db.query("SELECT MIN(lastfm_uts) AS m FROM wild_plays", &[])?.first().and_then(|r| r.get("m")).and_then(|v| v.as_i64());
        match oldest {
            Some(o) if o > since + 1 => {
                let to = o - 1;
                let mut page = 1usize;
                let mut finished = false;
                loop {
                    if pages_left == 0 { break; }
                    let v = lastfm::call(db, &key, "user.getRecentTracks", &[("user", &user), ("limit", &PAGE.to_string()), ("page", &page.to_string()), ("from", &since.to_string()), ("to", &to.to_string())])?;
                    pages_left -= 1;
                    let items = v["recenttracks"]["track"].as_array().cloned().unwrap_or_default();
                    let total_pages = v["recenttracks"]["@attr"]["totalPages"].as_str().and_then(|x| x.parse::<usize>().ok()).unwrap_or(1);
                    for t in &items { let n = insert_one(db, t)?; if n == 1 { added += 1 } else if t["date"]["uts"].is_string() || t["date"]["uts"].is_number() { dropped += 1 } }
                    if page >= total_pages || items.is_empty() { finished = true; break; }
                    page += 1;
                }
                if finished { d["backfillDone"] = json!(true); }
            }
            _ => { d["backfillDone"] = json!(true); } // nothing below, or nothing at all yet
        }
    }

    d["dropped"] = json!(d["dropped"].as_i64().unwrap_or(0) + dropped);
    db.exec("UPDATE connector_state SET plays_added = plays_added + ?, last_sync_at = now(), status = 'connected', last_error = NULL, detail = CAST(? AS JSON) WHERE service = 'lastfm_wild'",
        &[json!(added), json!(d.to_string())])?;
    if added > 0 || dropped > 0 {
        db.log_activity("wild", "info", &format!("Heard in the Wild: +{added} captures, {dropped} were your own Spotify playback"), None);
    }
    Ok(added)
}
