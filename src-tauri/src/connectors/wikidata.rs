//! Artist origin via MusicBrainz `area` (already reachable, no key), with Wikidata
//! as the fallback for country codes. Feeds scenes ("turkish", "afro"…) and,
//! later, a map of where your music comes from.

use super::musicbrainz::Mb;
use crate::db::Db;
use anyhow::Result;
use serde_json::json;

pub fn enrich_origin(db: &Db, max_artists: usize) -> Result<usize> {
    let mb = Mb::new()?;
    let rows = db.query(&format!(
        "SELECT a.artist_id, a.mbid FROM artists a JOIN (SELECT artist_id, COUNT(*) c FROM plays_resolved GROUP BY 1) p USING (artist_id)
         WHERE a.mbid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM artist_origin o WHERE o.artist_id = a.artist_id)
         ORDER BY p.c DESC LIMIT {max_artists}"), &[])?;
    let mut n = 0;
    for r in rows {
        let (Some(id), Some(mbid)) = (r.get("artist_id").and_then(|v| v.as_str()), r.get("mbid").and_then(|v| v.as_str())) else { continue };
        if origin_for(&mb, db, id, mbid).is_err() { break; }
        n += 1;
    }
    if n > 0 { db.log_activity("origin", "info", &format!("Origins for {n} artists"), None); }
    Ok(n)
}

/// One artist's origin from its MusicBrainz record. Phase 9i: `country` is MusicBrainz's country (where the artist is
/// based — US for Paul Banks); the city is the `area` when that is a city, else the begin-area marked as a birthplace;
/// country_name is only taken from an area that *is* a country. Never touches a row you corrected (source = 'owner').
pub fn origin_for(mb: &Mb, db: &Db, artist_id: &str, mbid: &str) -> Result<()> {
    let v = mb.get(db, &format!("artist/{mbid}?fmt=json"))?;
    let country = v["country"].as_str().map(str::to_string);
    let area = &v["area"]; let begin = &v["begin-area"];
    let area_type = area["type"].as_str().unwrap_or("");
    let city = if !area_type.is_empty() && area_type != "Country" { area["name"].as_str().map(str::to_string) }
               else { begin["name"].as_str().map(|b| format!("{b} (born/formed)")) };
    let country_name = if area_type == "Country" { area["name"].as_str().map(str::to_string) } else { None };
    let formed = v["life-span"]["begin"].as_str().and_then(|s| s.get(0..4)).and_then(|y| y.parse::<i64>().ok());
    db.exec("INSERT INTO artist_origin (artist_id, country, country_name, city, formed_year, source) VALUES (?, ?, ?, ?, ?, 'musicbrainz')
             ON CONFLICT (artist_id) DO UPDATE SET country = excluded.country, country_name = excluded.country_name, city = excluded.city, formed_year = excluded.formed_year, source = 'musicbrainz', fetched_at = now()
             WHERE COALESCE(artist_origin.source, '') <> 'owner'",
        &[json!(artist_id), json!(country), json!(country_name), json!(city), json!(formed)])?;
    Ok(())
}
