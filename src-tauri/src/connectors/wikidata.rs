//! Artist origin via MusicBrainz `area` (already reachable, no key), with Wikidata
//! as the fallback for country codes. Feeds scenes ("turkish", "afro"…) and,
//! later, a map of where your music comes from.

use super::musicbrainz::Mb;
use crate::db::Db;
use anyhow::Result;
use serde_json::{json, Value};

pub fn enrich_origin(db: &Db, max_artists: usize) -> Result<usize> {
    let mb = Mb::new()?;
    let rows = db.query(&format!(
        "SELECT a.artist_id, a.mbid FROM artists a JOIN (SELECT artist_id, COUNT(*) c FROM plays_resolved GROUP BY 1) p USING (artist_id)
         WHERE a.mbid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM artist_origin o WHERE o.artist_id = a.artist_id)
         ORDER BY p.c DESC LIMIT {max_artists}"), &[])?;
    let mut n = 0;
    for r in rows {
        let (Some(id), Some(mbid)) = (r.get("artist_id").and_then(|v| v.as_str()), r.get("mbid").and_then(|v| v.as_str())) else { continue };
        let Ok(v) = mb.get(db, &format!("artist/{mbid}?inc=area-rels&fmt=json")) else { break };
        let country = v["country"].as_str().map(str::to_string);
        let area: &Value = &v["area"];
        let begin = &v["begin-area"];
        let city = begin["name"].as_str().or(area["name"].as_str()).map(str::to_string);
        let formed = v["life-span"]["begin"].as_str().and_then(|s| s.get(0..4)).and_then(|y| y.parse::<i64>().ok());
        let country_name = area["name"].as_str().map(str::to_string);
        db.exec("INSERT INTO artist_origin (artist_id, country, country_name, city, formed_year, source) VALUES (?, ?, ?, ?, ?, 'musicbrainz') ON CONFLICT (artist_id) DO NOTHING",
            &[json!(id), json!(country), json!(country_name), json!(city), json!(formed)])?;
        n += 1;
    }
    if n > 0 { db.log_activity("origin", "info", &format!("Origins for {n} artists"), None); }
    Ok(n)
}
