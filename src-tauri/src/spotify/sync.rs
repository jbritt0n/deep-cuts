//! ING-05…08 + ENR-01: recently-played poller, liked-songs sync, playlist
//! sync and lazy enrichment. Each function is one scheduler task; all write
//! through the DB layer and log to activity_log.

use super::client::{ApiError, SpotifyClient};
use super::endpoints::{self as ep, f};
use crate::db::Db;
use anyhow::{Context, Result};
use serde_json::{json, Value};

fn s(v: &Value) -> Option<String> { v.as_str().map(str::to_string) }

fn touch(db: &Db, service: &str, status: &str, err: Option<&str>, added: i64) {
    let _ = db.exec(
        "UPDATE connector_state SET status = ?, last_sync_at = now(), last_error = ?, plays_added = plays_added + ? WHERE service = ?",
        &[json!(status), json!(err), json!(added), json!(service)],
    );
}

/// ING-05: pull the last 50 plays; insert what's new. Returns plays added.
pub fn poll_recent(client: &SpotifyClient, db: &Db) -> Result<i64> {
    let v = match client.get(db, &ep::recently_played(50), true) {
        Ok(v) => v,
        Err(ApiError::Unauthorized) => { touch(db, "spotify", "error", Some("Not connected"), 0); anyhow::bail!("Spotify is not connected"); }
        Err(e) => { touch(db, "spotify", "connected", Some(&e.to_string()), 0); return Err(anyhow::anyhow!("{e}")); }
    };
    let mut added = 0i64;
    for item in v[f::ITEMS].as_array().cloned().unwrap_or_default() {
        let t = &item[f::TRACK];
        let (Some(id), Some(played_at)) = (s(&t[f::ID]), s(&item[f::PLAYED_AT])) else { continue };
        let duration = t[f::DURATION_MS].as_i64().unwrap_or(0);
        let artist = t[f::ARTISTS].get(0).map(|a| a[f::NAME].clone()).unwrap_or(Value::Null);
        let payload = json!({
            "spotify_track_uri": s(&t[f::URI]),
            "spotify_track_id": id,
            "track_name": s(&t[f::NAME]),
            "artist_name": artist,
            "album_name": s(&t[f::ALBUM][f::NAME]),
            "ms_played": duration,
            "platform": "spotify_api",
            "end_reason": "unknown",
            "start_reason": "unknown",
            "source": "recently_played_poll"
        });
        // end-of-play epoch for the ±2 s tolerance against the export
        let start = chrono::DateTime::parse_from_rfc3339(&played_at).map(|d| d.timestamp() as f64).unwrap_or(0.0);
        let end_epoch = start + duration as f64 / 1000.0;
        let n = db.exec(crate::db::POLL_INSERT_SQL, &[json!(played_at), json!(id), json!(payload.to_string()), json!(end_epoch)])
            .with_context(|| format!("inserting poll play {id}"))?;
        added += n as i64;
        // make sure the track exists for enrichment
        upsert_track_stub(db, t)?;
    }
    touch(db, "spotify", "connected", None, added);
    if added > 0 {
        db.exec_batch(crate::db::ENTITY_RESOLUTION_SQL)?;
        db.exec_batch(crate::db::COMPUTE_SESSIONS_SQL)?;
        db.log_activity("poll", "info", &format!("Recently played: +{added} plays"), None);
    }
    Ok(added)
}

fn upsert_track_stub(db: &Db, t: &Value) -> Result<()> {
    let Some(id) = s(&t[f::ID]) else { return Ok(()) };
    db.exec(
        "UPDATE tracks SET duration_ms = COALESCE(duration_ms, ?), track_number = COALESCE(track_number, ?), explicit = COALESCE(explicit, ?) WHERE track_id = ?",
        &[json!(t[f::DURATION_MS].as_i64()), json!(t[f::TRACK_NUMBER].as_i64()), json!(t[f::EXPLICIT].as_bool()), json!(id)],
    )?;
    Ok(())
}

/// ING-07: liked songs, paginated 50 at a time.
pub fn sync_liked(client: &SpotifyClient, db: &Db) -> Result<usize> {
    let mut offset = 0u32;
    let mut total = 0usize;
    loop {
        let v = client.get(db, &ep::my_tracks(50, offset), true).map_err(|e| anyhow::anyhow!("{e}"))?;
        let items = v[f::ITEMS].as_array().cloned().unwrap_or_default();
        if items.is_empty() { break; }
        for it in &items {
            let t = &it[f::TRACK];
            if let Some(id) = s(&t[f::ID]) {
                db.exec("INSERT INTO liked_songs (track_id, added_at, synced_at) VALUES (?, CAST(? AS TIMESTAMPTZ), now()) ON CONFLICT (track_id) DO UPDATE SET synced_at = now()",
                    &[json!(id), json!(s(&it[f::ADDED_AT]))])?;
                enrich_track_from_json(db, t)?;
                total += 1;
            }
        }
        if v[f::NEXT].is_null() { break; }
        offset += 50;
    }
    db.log_activity("sync", "info", &format!("Liked songs synced: {total}"), None);
    Ok(total)
}

/// ING-08: the user's own playlists + items (read-only).
pub fn sync_playlists(client: &SpotifyClient, db: &Db, me_id: &str) -> Result<usize> {
    let mut offset = 0u32;
    let mut n = 0usize;
    loop {
        let v = client.get(db, &ep::my_playlists(50, offset), true).map_err(|e| anyhow::anyhow!("{e}"))?;
        let items = v[f::ITEMS].as_array().cloned().unwrap_or_default();
        if items.is_empty() { break; }
        for p in &items {
            let Some(id) = s(&p[f::ID]) else { continue };
            let mine = s(&p[f::OWNER][f::ID]).as_deref() == Some(me_id);
            db.exec("INSERT INTO playlists (playlist_id, name, description, owner_is_me, track_count, snapshot_id, public, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, now()) \
                     ON CONFLICT (playlist_id) DO UPDATE SET name = excluded.name, description = excluded.description, track_count = excluded.track_count, snapshot_id = excluded.snapshot_id, public = excluded.public, synced_at = now()",
                &[json!(id), json!(s(&p[f::NAME])), json!(s(&p[f::DESCRIPTION])), json!(mine), json!(p["tracks"][f::TOTAL].as_i64().or(p[f::ITEMS][f::TOTAL].as_i64())), json!(s(&p[f::SNAPSHOT_ID])), json!(p[f::PUBLIC].as_bool())])?;
            // items for your own playlists always; for followed ones up to 300 tracks each (quota-friendly)
            let item_cap = if mine { u32::MAX } else { 300 };
            {
                db.exec("DELETE FROM playlist_items WHERE playlist_id = ?", &[json!(id)])?;
                let mut off = 0u32; let mut pos = 0i64;
                loop {
                    let iv = client.get(db, &ep::playlist_items(&id, 100, off), true).map_err(|e| anyhow::anyhow!("{e}"))?;
                    let its = iv[f::ITEMS].as_array().cloned().unwrap_or_default();
                    if its.is_empty() { break; }
                    for it in &its {
                        let t = &it[f::ITEM]; // API-04
                        if let Some(tid) = s(&t[f::ID]) {
                            db.exec("INSERT INTO playlist_items (playlist_id, track_id, added_at, position) VALUES (?, ?, CAST(? AS TIMESTAMPTZ), ?)", &[json!(id), json!(tid), json!(s(&it[f::ADDED_AT])), json!(pos)])?;
                            pos += 1;
                        }
                    }
                    if iv[f::NEXT].is_null() || off + 100 >= item_cap { break; }
                    off += 100;
                }
            }
            n += 1;
        }
        if v[f::NEXT].is_null() { break; }
        offset += 50;
    }
    db.log_activity("sync", "info", &format!("Playlists synced: {n}"), None);
    Ok(n)
}

/// Write everything a full track object tells us (also used by liked-songs sync,
/// which delivers full tracks for free — API-05 says cache forever).
pub fn enrich_track_from_json(db: &Db, t: &Value) -> Result<()> {
    let Some(id) = s(&t[f::ID]) else { return Ok(()) };
    let album = &t[f::ALBUM];
    let (rd, prec) = release_date(album);
    db.exec(
        "UPDATE tracks SET duration_ms = ?, track_number = ?, isrc = ?, explicit = ?, release_date = TRY_CAST(? AS DATE), release_precision = ?, enriched_at = now() WHERE track_id = ?",
        &[json!(t[f::DURATION_MS].as_i64()), json!(t[f::TRACK_NUMBER].as_i64()), json!(s(&t[f::EXTERNAL_IDS][f::ISRC])), json!(t[f::EXPLICIT].as_bool()), json!(rd), json!(prec), json!(id)],
    )?;
    if let Some(aid) = s(&album[f::ID]) {
        let img = album[f::IMAGES].get(0).and_then(|i| s(&i[f::URL]));
        // albums are keyed by name hash in Phase 1; attach Spotify data to the row this track points at
        db.exec("UPDATE albums SET release_date = COALESCE(release_date, TRY_CAST(? AS DATE)), album_type = COALESCE(album_type, ?), total_tracks = COALESCE(total_tracks, ?), image_url = COALESCE(image_url, ?), enriched_at = now() WHERE album_id = (SELECT album_id FROM tracks WHERE track_id = ?)",
            &[json!(rd), json!(s(&album[f::ALBUM_TYPE])), json!(album[f::TOTAL_TRACKS].as_i64()), json!(img), json!(id)])?;
        let _ = aid;
    }
    Ok(())
}

fn release_date(album: &Value) -> (Option<String>, Option<String>) {
    let raw = s(&album[f::RELEASE_DATE]);
    let prec = s(&album[f::RELEASE_DATE_PRECISION]);
    let full = raw.map(|r| match r.len() { 4 => format!("{r}-01-01"), 7 => format!("{r}-01"), _ => r });
    (full, prec)
}

/// ENR-01: enrich the most-played un-enriched tracks, within the hourly budget.
pub fn enrich_batch(client: &SpotifyClient, db: &Db) -> Result<usize> {
    if client.is_paused() { return Ok(0); }
    let used = client.calls_last_hour(db);
    let room = ep::budget::enrich_per_hour(db).saturating_sub(used).min(ep::budget::ENRICH_BATCH);
    if room == 0 { return Ok(0); }
    let rows = db.query(&format!(
        "SELECT t.track_id FROM tracks t JOIN (SELECT track_id, COUNT(*) c FROM plays_resolved GROUP BY 1) p USING (track_id)
         WHERE t.enriched_at IS NULL AND t.track_id NOT LIKE 'local:%' ORDER BY p.c DESC LIMIT {room}"), &[])?;
    let mut done = 0;
    for r in rows {
        let Some(id) = r.get("track_id").and_then(|v| v.as_str()) else { continue };
        match client.get(db, &ep::track(id), false) {
            Ok(v) => { enrich_track_from_json(db, &v)?; done += 1; }
            Err(ApiError::Quota) => break,
            Err(ApiError::Unauthorized) => break,
            Err(e @ (ApiError::Other(_) | ApiError::Http { .. })) => {
                // 404s etc: mark so we don't retry forever
                db.exec("UPDATE tracks SET enriched_at = now() WHERE track_id = ?", &[json!(id)])?;
                log::warn!("enrich {id}: {e}");
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    if done > 0 { db.log_activity("enrich", "info", &format!("Enriched {done} tracks from Spotify"), None); }
    Ok(done)
}

pub fn whoami(client: &SpotifyClient, db: &Db) -> Result<(String, String)> {
    let v = client.get(db, &ep::me(), true).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok((s(&v[f::ID]).unwrap_or_default(), s(&v[f::DISPLAY_NAME]).unwrap_or_default()))
}
