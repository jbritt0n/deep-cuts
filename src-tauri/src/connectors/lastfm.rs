//! CON-01…04 — Last.fm. Free key, per-key rate limit: sequential calls,
//! ~4/s max, backoff on 29 (rate limit) / 8 (operation failed).

use super::{normalize_tag, set_state};
use crate::db::Db;
use crate::secrets;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

const API: &str = "https://ws.audioscrobbler.com/2.0/";

fn http() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder().timeout(Duration::from_secs(20)).user_agent("DeepCuts/3.0 (personal listening analytics)").build()?)
}

/// Shared with `lastfm_wild` (Phase 8) so both connectors honour one rate limit and one api_calls log.
pub(crate) fn call(db: &Db, key: &str, method: &str, params: &[(&str, &str)]) -> Result<Value> {
    let h = http()?;
    let mut delay = 1u64;
    for _ in 0..4 {
        let mut q: Vec<(&str, &str)> = vec![("method", method), ("api_key", key), ("format", "json")];
        q.extend_from_slice(params);
        let resp = h.get(API).query(&q).send()?;
        let status = resp.status().as_u16();
        let v: Value = resp.json().unwrap_or(Value::Null);
        let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('lastfm', ?, ?)", &[json!(method), json!(status)]);
        match v["error"].as_i64() {
            None if status == 200 => { std::thread::sleep(Duration::from_millis(260)); return Ok(v); }
            Some(29) | Some(8) | Some(16) => { std::thread::sleep(Duration::from_secs(delay)); delay *= 2; }
            Some(code) => return Err(anyhow!("Last.fm error {code}: {}", v["message"].as_str().unwrap_or(""))),
            None => { std::thread::sleep(Duration::from_secs(delay)); delay *= 2; }
        }
    }
    Err(anyhow!("Last.fm kept rate-limiting {method}"))
}

/// CON-01: validate a key + username before saving them.
pub fn connect(db: &Db, key: &str, user: &str) -> Result<String> {
    let v = call(db, key, "user.getInfo", &[("user", user)]).context("checking the Last.fm key")?;
    let name = v["user"]["name"].as_str().ok_or_else(|| anyhow!("Last.fm didn't recognise that username"))?.to_string();
    secrets::set(secrets::LASTFM_KEY, key)?;
    secrets::set(secrets::LASTFM_USER, &name)?;
    set_state(db, "lastfm", "connected", Some(&name), None);
    db.log_activity("lastfm", "info", &format!("Connected as {name}"), None);
    Ok(name)
}

pub fn disconnect(db: &Db) -> Result<()> {
    secrets::delete(secrets::LASTFM_KEY)?;
    secrets::delete(secrets::LASTFM_USER)?;
    set_state(db, "lastfm", "disconnected", None, None);
    Ok(())
}

/// CON-02: tags for artists that don't have Last.fm tags yet, most-played first.
pub fn enrich_tags(db: &Db, max_artists: usize) -> Result<usize> {
    let Some(key) = secrets::get(secrets::LASTFM_KEY)? else { return Ok(0) };
    let rows = db.query(&format!(
        "SELECT a.artist_id, a.name FROM artists a
         JOIN (SELECT artist_id, COUNT(*) c FROM plays_resolved GROUP BY 1) p USING (artist_id)
         WHERE NOT EXISTS (SELECT 1 FROM artist_tags t WHERE t.artist_id = a.artist_id AND t.source = 'lastfm')
           AND NOT EXISTS (SELECT 1 FROM api_calls c WHERE c.service = 'lastfm' AND c.endpoint = 'tags:' || a.artist_id)
         ORDER BY p.c DESC LIMIT {max_artists}"), &[])?;
    let mut n = 0;
    for r in rows {
        let (Some(id), Some(name)) = (r.get("artist_id").and_then(|v| v.as_str()), r.get("name").and_then(|v| v.as_str())) else { continue };
        let v = match call(db, &key, "artist.getTopTags", &[("artist", name), ("autocorrect", "1")]) {
            Ok(v) => v, Err(e) => { set_state(db, "lastfm", "connected", None, Some(&e.to_string())); break; }
        };
        // remember we looked, even if there were no tags
        db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('lastfm', ?, 200)", &[json!(format!("tags:{id}"))])?;
        for t in v["toptags"]["tag"].as_array().cloned().unwrap_or_default() {
            let Some(tag) = t["name"].as_str().and_then(normalize_tag) else { continue };
            let w = t["count"].as_f64().unwrap_or(0.0) / 100.0;
            if w < 0.05 { continue; }
            db.exec("INSERT INTO artist_tags (artist_id, tag, weight, source) VALUES (?, ?, ?, 'lastfm') ON CONFLICT (artist_id, tag, source) DO UPDATE SET weight = GREATEST(artist_tags.weight, excluded.weight), fetched_at = now()",
                &[json!(id), json!(tag), json!(w)])?;
        }
        n += 1;
    }
    if n > 0 { set_state(db, "lastfm", "connected", None, None); db.log_activity("lastfm", "info", &format!("Tagged {n} artists"), None); }
    Ok(n)
}

/// CON-03: similar-artist graph, seeded from the owner's top artists by hours. Cached in artist_relations
/// with relation_type 'similar' (related_mbid holds the Last.fm mbid when present, else the name).
pub fn enrich_similar(db: &Db, max_seeds: usize) -> Result<usize> {
    let Some(key) = secrets::get(secrets::LASTFM_KEY)? else { return Ok(0) };
    let rows = db.query(&format!(
        "SELECT a.artist_id, a.name FROM artists a JOIN (SELECT artist_id, SUM(ms_played) h FROM plays_resolved WHERE attended GROUP BY 1) p USING (artist_id)
         WHERE NOT EXISTS (SELECT 1 FROM api_calls c WHERE c.service = 'lastfm' AND c.endpoint = 'similar:' || a.artist_id)
         ORDER BY p.h DESC LIMIT {max_seeds}"), &[])?;
    let mut n = 0;
    for r in rows {
        let (Some(id), Some(name)) = (r.get("artist_id").and_then(|v| v.as_str()), r.get("name").and_then(|v| v.as_str())) else { continue };
        let v = match call(db, &key, "artist.getSimilar", &[("artist", name), ("autocorrect", "1"), ("limit", "30")]) {
            Ok(v) => v, Err(e) => { set_state(db, "lastfm", "connected", None, Some(&e.to_string())); break; }
        };
        db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('lastfm', ?, 200)", &[json!(format!("similar:{id}"))])?;
        db.exec("DELETE FROM artist_relations WHERE artist_mbid = ? AND relation_type = 'similar'", &[json!(id)])?;
        for sa in v["similarartists"]["artist"].as_array().cloned().unwrap_or_default() {
            let Some(sname) = sa["name"].as_str() else { continue };
            let m = sa["match"].as_str().and_then(|x| x.parse::<f64>().ok()).or(sa["match"].as_f64()).unwrap_or(0.0);
            let key_id = sa["mbid"].as_str().filter(|x| !x.is_empty()).map(str::to_string).unwrap_or_else(|| format!("name:{}", sname.to_lowercase()));
            db.exec("INSERT INTO artist_relations (artist_mbid, relation_type, related_mbid, related_name, fetched_at) VALUES (?, 'similar', ?, ?, now())",
                &[json!(id), json!(format!("{key_id}|{m:.3}")), json!(sname)])?;
        }
        n += 1;
    }
    if n > 0 { db.log_activity("lastfm", "info", &format!("Similar-artist graph: {n} seeds"), None); }
    Ok(n)
}

/// Phase 9b — obscurity metrics: Last.fm listener counts per artist (`artist.getInfo` → `stats.listeners`).
/// Artists with no snapshot yet come first (most-played first); once everyone has one, rows older than
/// 90 days are refreshed. Every fetch appends to `artist_popularity_history` so trajectories accumulate
/// ("you found them at 5,000 listeners") — the latest snapshot lives in `artist_popularity`.
pub fn enrich_popularity(db: &Db, max_artists: usize) -> Result<usize> {
    let Some(key) = secrets::get(secrets::LASTFM_KEY)? else { return Ok(0) };
    let rows = db.query(&format!(
        "SELECT a.artist_id, a.name FROM artists a
         JOIN (SELECT artist_id, COUNT(*) c FROM plays_resolved GROUP BY 1) p USING (artist_id)
         LEFT JOIN artist_popularity ap USING (artist_id)
         WHERE (ap.artist_id IS NULL OR ap.fetched_at < now() - INTERVAL 30 DAY)   -- Phase 9h: was 90; the history needs a monthly snapshot for Rising & fading
           AND NOT EXISTS (SELECT 1 FROM api_calls c WHERE c.service = 'lastfm' AND c.endpoint = 'pop:' || a.artist_id AND c.called_at >= now() - INTERVAL 7 DAY)
         ORDER BY (ap.artist_id IS NULL) DESC, p.c DESC LIMIT {max_artists}"), &[])?;
    let mut n = 0;
    for r in rows {
        let (Some(id), Some(name)) = (r.get("artist_id").and_then(|v| v.as_str()), r.get("name").and_then(|v| v.as_str())) else { continue };
        let v = match call(db, &key, "artist.getInfo", &[("artist", name), ("autocorrect", "1")]) {
            Ok(v) => v, Err(e) => { set_state(db, "lastfm", "connected", None, Some(&e.to_string())); break; }
        };
        // remember we looked, even when Last.fm has no stats, so one unknown artist can't block the queue for a week
        db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('lastfm', ?, 200)", &[json!(format!("pop:{id}"))])?;
        let stats = &v["artist"]["stats"];
        let parse = |k: &str| stats[k].as_str().and_then(|x| x.parse::<i64>().ok()).or(stats[k].as_i64());
        let (Some(listeners), playcount) = (parse("listeners"), parse("playcount")) else { continue };
        db.exec("INSERT INTO artist_popularity (artist_id, listeners, playcount, source, fetched_at) VALUES (?, ?, ?, 'lastfm', now()) ON CONFLICT (artist_id) DO UPDATE SET listeners = excluded.listeners, playcount = excluded.playcount, fetched_at = now()",
            &[json!(id), json!(listeners), json!(playcount)])?;
        db.exec("INSERT INTO artist_popularity_history (artist_id, listeners, playcount) VALUES (?, ?, ?)", &[json!(id), json!(listeners), json!(playcount)])?;
        n += 1;
    }
    if n > 0 { db.log_activity("lastfm", "info", &format!("Listener counts for {n} artists"), None); }
    Ok(n)
}
