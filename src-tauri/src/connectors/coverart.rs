//! Album art. Two free sources, no download — we store URLs only:
//!  1. Spotify enrichment already writes albums.image_url from track objects.
//!  2. Cover Art Archive (coverartarchive.org) by release-group MBID for the rest:
//!     we resolve the release group through MusicBrainz (album title + artist MBID),
//!     then point at CAA's `front-250` redirect, which serves the image if one exists.

use super::musicbrainz::Mb;
use super::set_state;
use crate::db::Db;
use anyhow::Result;
use serde_json::json;

pub fn enrich_batch(db: &Db, max_albums: usize) -> Result<usize> {
    let mb = Mb::new()?;
    let rows = db.query(&format!(
        "SELECT al.album_id, al.name, ar.mbid FROM albums al JOIN artists ar ON ar.artist_id = al.artist_id
         JOIN (SELECT album_id, COUNT(*) c FROM plays_resolved WHERE attended GROUP BY 1) p USING (album_id)
         WHERE al.image_url IS NULL AND ar.mbid IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM api_calls c WHERE c.service = 'musicbrainz' AND c.endpoint = 'rg:' || al.album_id)
         ORDER BY p.c DESC LIMIT {max_albums}"), &[])?;
    let http = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(15)).user_agent("DeepCuts/3.0 (local personal listening analytics)").redirect(reqwest::redirect::Policy::none()).build()?;
    let mut n = 0;
    for r in rows {
        let g = |k: &str| r.get(k).and_then(|v| v.as_str()).map(str::to_string);
        let (Some(id), Some(name), Some(arid)) = (g("album_id"), g("name"), g("mbid")) else { continue };
        let query_text = format!("releasegroup:\"{}\" AND arid:{}", name.replace('"', ""), arid);
        let q = urlencoding::encode(&query_text).into_owned();
        let v = match mb.get(db, &format!("release-group/?query={q}&limit=1&fmt=json")) { Ok(v) => v, Err(e) => { set_state(db, "musicbrainz", "error", None, Some(&e.to_string())); break; } };
        db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('musicbrainz', ?, 200)", &[json!(format!("rg:{id}"))])?;
        let Some(rgid) = v["release-groups"].get(0).and_then(|x| x["id"].as_str()) else { continue };
        // CAA answers 307 → image URL when art exists, 404 otherwise. We keep the stable redirecting URL.
        let url = format!("https://coverartarchive.org/release-group/{rgid}/front-250");
        let ok = http.get(&url).send().map(|res| res.status().is_redirection() || res.status().is_success()).unwrap_or(false);
        let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('coverart', 'front', ?)", &[json!(if ok { 200 } else { 404 })]);
        if ok {
            db.exec("UPDATE albums SET image_url = ?, enriched_at = COALESCE(enriched_at, now()) WHERE album_id = ?", &[json!(url), json!(id)])?;
            n += 1;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    if n > 0 { db.log_activity("coverart", "info", &format!("Album art for {n} albums"), None); }
    Ok(n)
}
