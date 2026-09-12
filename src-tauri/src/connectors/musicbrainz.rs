//! CON-05…07 — MusicBrainz. No key; descriptive User-Agent; ≤ 1 request/second.
//! Phase 2 scope: resolve artist MBIDs (canonical identity seam) and pull tags.
//! Release-group polling and relationships land with the recommendation engines.

use super::{normalize_tag, set_state};
use crate::db::Db;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const API: &str = "https://musicbrainz.org/ws/2";
const UA: &str = "DeepCuts/3.0 ( https://github.com/deep-cuts/deep-cuts ; local personal listening analytics )";

pub struct Mb { http: reqwest::blocking::Client, last: std::sync::Mutex<Instant> }

impl Mb {
    pub fn new() -> Result<Self> {
        Ok(Self { http: reqwest::blocking::Client::builder().timeout(Duration::from_secs(20)).user_agent(UA).build()?, last: std::sync::Mutex::new(Instant::now() - Duration::from_secs(2)) })
    }
    pub fn get(&self, db: &Db, path: &str) -> Result<Value> {
        // client-side politeness: never faster than 1.1 s between calls
        {
            let mut l = self.last.lock().unwrap_or_else(|p| p.into_inner());
            let since = l.elapsed();
            if since < Duration::from_millis(1100) { std::thread::sleep(Duration::from_millis(1100) - since); }
            *l = Instant::now();
        }
        let mut delay = 2u64;
        for _ in 0..4 {
            let resp = self.http.get(format!("{API}/{path}")).header("Accept", "application/json").send()?;
            let status = resp.status().as_u16();
            let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('musicbrainz', ?, ?)", &[json!(path.split('?').next().unwrap_or(path)), json!(status)]);
            match status {
                200 => return Ok(resp.json()?),
                429 | 503 => { std::thread::sleep(Duration::from_secs(delay)); delay *= 2; }
                _ => return Err(anyhow!("MusicBrainz {status} on {path}")),
            }
        }
        Err(anyhow!("MusicBrainz kept rate-limiting"))
    }
}

/// Reachability check; nothing to store.
pub fn connect(db: &Db) -> Result<()> {
    let mb = Mb::new()?;
    mb.get(db, "artist/?query=artist:radiohead&limit=1&fmt=json")?;
    set_state(db, "musicbrainz", "connected", Some("no account needed"), None);
    db.log_activity("musicbrainz", "info", "MusicBrainz reachable", None);
    Ok(())
}

/// CON-06 + CON-07: resolve MBIDs for the most-played artists lacking one, and pull their tags.
pub fn resolve_batch(db: &Db, max_artists: usize) -> Result<usize> {
    let mb = Mb::new()?;
    let rows = db.query(&format!(
        "SELECT a.artist_id, a.name FROM artists a JOIN (SELECT artist_id, COUNT(*) c FROM plays_resolved GROUP BY 1) p USING (artist_id)
         WHERE a.mbid IS NULL AND NOT EXISTS (SELECT 1 FROM api_calls c WHERE c.service = 'musicbrainz' AND c.endpoint = 'resolve:' || a.artist_id)
         ORDER BY p.c DESC LIMIT {max_artists}"), &[])?;
    let mut n = 0;
    for r in rows {
        let (Some(id), Some(name)) = (r.get("artist_id").and_then(|v| v.as_str()), r.get("name").and_then(|v| v.as_str())) else { continue };
        let query_text = format!("artist:\"{}\"", name.replace('"', ""));
        let q = urlencoding::encode(&query_text).into_owned();
        let v = match mb.get(db, &format!("artist/?query={q}&limit=3&fmt=json")) { Ok(v) => v, Err(e) => { set_state(db, "musicbrainz", "error", None, Some(&e.to_string())); break; } };
        db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('musicbrainz', ?, 200)", &[json!(format!("resolve:{id}"))])?;
        let best = v["artists"].as_array().and_then(|a| a.iter().find(|x| x["score"].as_i64().unwrap_or(0) >= 90 && x["name"].as_str().map(|s| s.eq_ignore_ascii_case(name)).unwrap_or(false)).or(a.iter().find(|x| x["score"].as_i64().unwrap_or(0) >= 95)));
        let Some(b) = best else { continue };
        let Some(mbid) = b["id"].as_str() else { continue };
        // enriched_at marks the row so entity_resolution keeps mbid across rebuilds
        db.exec("UPDATE artists SET mbid = ?, enriched_at = now() WHERE artist_id = ?", &[json!(mbid), json!(id)])?;
        for t in b["tags"].as_array().cloned().unwrap_or_default() {
            let Some(tag) = t["name"].as_str().and_then(normalize_tag) else { continue };
            let w = (t["count"].as_f64().unwrap_or(1.0) / 10.0).min(1.0).max(0.1);
            db.exec("INSERT INTO artist_tags (artist_id, tag, weight, source) VALUES (?, ?, ?, 'musicbrainz') ON CONFLICT (artist_id, tag, source) DO UPDATE SET weight = GREATEST(artist_tags.weight, excluded.weight), fetched_at = now()",
                &[json!(id), json!(tag), json!(w)])?;
        }
        n += 1;
    }
    if n > 0 { set_state(db, "musicbrainz", "connected", None, None); db.log_activity("musicbrainz", "info", &format!("Resolved {n} artists"), None); }
    Ok(n)
}

/// CON-07 / REC-04 / REC-05: relationships (side projects) and recent release groups
/// for resolved artists, most-played first. Stored in artist_relations.
pub fn enrich_relations(db: &Db, max_artists: usize) -> Result<usize> {
    let mb = Mb::new()?;
    let rows = db.query(&format!(
        "SELECT a.artist_id, a.mbid FROM artists a JOIN (SELECT artist_id, COUNT(*) c FROM plays_resolved GROUP BY 1) p USING (artist_id)
         WHERE a.mbid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM api_calls c WHERE c.service = 'musicbrainz' AND c.endpoint = 'rels:' || a.mbid AND c.called_at >= now() - INTERVAL 7 DAY)
         ORDER BY p.c DESC LIMIT {max_artists}"), &[])?;
    let mut n = 0;
    for r in rows {
        let Some(mbid) = r.get("mbid").and_then(|v| v.as_str()) else { continue };
        let v = match mb.get(db, &format!("artist/{mbid}?inc=artist-rels+release-groups&fmt=json")) { Ok(v) => v, Err(e) => { set_state(db, "musicbrainz", "error", None, Some(&e.to_string())); break; } };
        db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('musicbrainz', ?, 200)", &[json!(format!("rels:{mbid}"))])?;
        db.exec("DELETE FROM artist_relations WHERE artist_mbid = ? AND relation_type NOT IN ('similar')", &[json!(mbid)])?;
        for rel in v["relations"].as_array().cloned().unwrap_or_default() {
            let (Some(kind), Some(other)) = (rel["type"].as_str(), rel["artist"].as_object()) else { continue };
            let (Some(oid), Some(oname)) = (other.get("id").and_then(|x| x.as_str()), other.get("name").and_then(|x| x.as_str())) else { continue };
            db.exec("INSERT INTO artist_relations (artist_mbid, relation_type, related_mbid, related_name) VALUES (?, ?, ?, ?)", &[json!(mbid), json!(kind), json!(format!("{oid}|")), json!(oname)])?;
        }
        for rg in v["release-groups"].as_array().cloned().unwrap_or_default() {
            let (Some(rid), Some(title)) = (rg["id"].as_str(), rg["title"].as_str()) else { continue };
            let date = rg["first-release-date"].as_str().unwrap_or("");
            if date.len() < 4 { continue; }
            let full = match date.len() { 4 => format!("{date}-01-01"), 7 => format!("{date}-01"), _ => date.to_string() };
            db.exec("INSERT INTO artist_relations (artist_mbid, relation_type, related_mbid, related_name) VALUES (?, 'release', ?, ?)", &[json!(mbid), json!(format!("{rid}|{full}")), json!(title)])?;
        }
        n += 1;
    }
    if n > 0 { db.log_activity("musicbrainz", "info", &format!("Relationships and releases for {n} artists"), None); }
    Ok(n)
}

/// Phase 9d — catalogue size per artist (summary §3.4): MusicBrainz's `recording-count` for the artist, from a
/// single `recording?artist=<mbid>&limit=1` browse call. A proxy — it counts live takes and remixes as separate
/// recordings — so the UI says "of roughly N". Most-played resolved artists first; refreshed after 180 days.
pub fn enrich_catalogue(db: &Db, max_artists: usize) -> Result<usize> {
    let mb = Mb::new()?;
    let rows = db.query(&format!(
        "SELECT a.artist_id, a.mbid FROM artists a JOIN (SELECT artist_id, COUNT(*) c FROM plays_resolved GROUP BY 1) p USING (artist_id)
         WHERE a.mbid IS NOT NULL AND (a.catalogue_fetched_at IS NULL OR a.catalogue_fetched_at < now() - INTERVAL 180 DAY)
           AND NOT EXISTS (SELECT 1 FROM api_calls c WHERE c.service = 'musicbrainz' AND c.endpoint = 'cat:' || a.mbid AND c.called_at >= now() - INTERVAL 7 DAY)
         ORDER BY (a.catalogue_fetched_at IS NULL) DESC, p.c DESC LIMIT {max_artists}"), &[])?;
    let mut n = 0;
    for r in rows {
        let (Some(id), Some(mbid)) = (r.get("artist_id").and_then(|v| v.as_str()), r.get("mbid").and_then(|v| v.as_str())) else { continue };
        let v = match mb.get(db, &format!("recording?artist={mbid}&limit=1&fmt=json")) { Ok(v) => v, Err(e) => { set_state(db, "musicbrainz", "error", None, Some(&e.to_string())); break; } };
        db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('musicbrainz', ?, 200)", &[json!(format!("cat:{mbid}"))])?;
        let Some(count) = v["recording-count"].as_i64() else { continue };
        db.exec("UPDATE artists SET catalogue_tracks = ?, catalogue_fetched_at = now() WHERE artist_id = ?", &[json!(count), json!(id)])?;
        n += 1;
    }
    if n > 0 { db.log_activity("musicbrainz", "info", &format!("Catalogue sizes for {n} artists"), None); }
    Ok(n)
}

/// Phase 9d — multi-artist credits (design brief §2): look a recording up by ISRC and write one `track_credits`
/// row per credited artist, in credit order. `tracks.artist_id` is untouched — this is additive. Names are resolved
/// to a known `artist_id` by lower-cased name / alias where possible; the rest keep the MusicBrainz name + MBID.
/// Coverage caveat: not every recording has an ISRC in MusicBrainz, and some joint acts are credited as one artist.
pub fn enrich_credits(db: &Db, max_tracks: usize) -> Result<usize> {
    let mb = Mb::new()?;
    let rows = db.query(&format!(
        "SELECT t.track_id, t.isrc FROM tracks t JOIN (SELECT track_id, COUNT(*) c FROM plays_resolved GROUP BY 1) p USING (track_id)
         WHERE t.isrc IS NOT NULL AND t.track_id NOT LIKE 'local:%'
           AND NOT EXISTS (SELECT 1 FROM track_credits tc WHERE tc.track_id = t.track_id)
           AND NOT EXISTS (SELECT 1 FROM api_calls c WHERE c.service = 'musicbrainz' AND c.endpoint = 'isrc:' || t.isrc)
         ORDER BY p.c DESC LIMIT {max_tracks}"), &[])?;
    let mut n = 0;
    for r in rows {
        let (Some(id), Some(isrc)) = (r.get("track_id").and_then(|v| v.as_str()), r.get("isrc").and_then(|v| v.as_str())) else { continue };
        let v = match mb.get(db, &format!("recording?query=isrc:{isrc}&limit=1&fmt=json")) { Ok(v) => v, Err(e) => { set_state(db, "musicbrainz", "error", None, Some(&e.to_string())); break; } };
        // remember we looked, so an ISRC MusicBrainz doesn't know can't be retried forever
        db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('musicbrainz', ?, 200)", &[json!(format!("isrc:{isrc}"))])?;
        let Some(rec) = v["recordings"].as_array().and_then(|a| a.first()) else { continue };
        let credits = rec["artist-credit"].as_array().cloned().unwrap_or_default();
        if credits.is_empty() { continue; }
        for (i, c) in credits.iter().enumerate() {
            let name = c["name"].as_str().or(c["artist"]["name"].as_str()).unwrap_or("").to_string();
            if name.is_empty() { continue; }
            let cmbid = c["artist"]["id"].as_str().map(str::to_string);
            let resolved = db.query("SELECT artist_id FROM artists WHERE lower(name) = lower(?) OR (mbid IS NOT NULL AND mbid = ?) UNION SELECT artist_id FROM artist_aliases WHERE lower(alias_name) = lower(?) LIMIT 1",
                &[json!(name), json!(cmbid.clone().unwrap_or_default()), json!(name)]).ok()
                .and_then(|rs| rs.first().and_then(|m| m.get("artist_id")).and_then(|x| x.as_str().map(str::to_string)));
            db.exec("INSERT INTO track_credits (track_id, artist_id, artist_name, artist_mbid, credit_order) VALUES (?, ?, ?, ?, ?) ON CONFLICT (track_id, credit_order) DO UPDATE SET artist_id = excluded.artist_id, artist_name = excluded.artist_name, artist_mbid = excluded.artist_mbid, fetched_at = now()",
                &[json!(id), json!(resolved), json!(name), json!(cmbid), json!(i as i64)])?;
        }
        n += 1;
    }
    if n > 0 { db.log_activity("musicbrainz", "info", &format!("Artist credits for {n} tracks"), None); }
    Ok(n)
}
