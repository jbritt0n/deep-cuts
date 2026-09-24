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
// ============================================================================ Phase 9i — matching you can trust
// 9h resolved artists by name alone (first exact-name hit of three), so shared names picked the wrong entity:
// Paul Banks (Interpol, New York) got a Danish namesake, Rodriguez (Detroit) a Cuban one — and every origin, tag and
// relation fetched through that id inherited the mistake. Evidence now comes first:
//   1. ISRC — the MusicBrainz recording behind one of your tracks credits exactly one artist id. Authoritative.
//   2. several exact-name namesakes → the one whose release groups match your album titles.
//   3. a single exact-name hit → accepted, marked 'name' (weakest; verify_batch re-checks it when ISRC evidence arrives).
//   4. several namesakes and no evidence → left unresolved ('ambiguous'); the artist page offers the candidates.

fn norm(s: &str) -> String { s.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ") }

fn record_match(db: &Db, id: &str, mbid: Option<&str>, method: &str, evidence: &str, candidates: i64) -> Result<()> {
    db.exec("INSERT INTO artist_mb_match (artist_id, mbid, method, evidence, candidates, checked_at) VALUES (?, ?, ?, ?, ?, now())
             ON CONFLICT (artist_id) DO UPDATE SET mbid = excluded.mbid, method = excluded.method, evidence = excluded.evidence, candidates = excluded.candidates, checked_at = now()",
        &[json!(id), json!(mbid), json!(method), json!(evidence), json!(candidates)])?;
    Ok(())
}

/// The artist id MusicBrainz credits on the recording behind one of this artist's ISRCs (credit name must match).
fn mbid_from_isrc(mb: &Mb, db: &Db, artist_id: &str, name: &str) -> Result<Option<(String, String)>> {
    // already looked up by enrich_credits?
    if let Some(r) = db.query("SELECT artist_mbid, COUNT(*) AS n FROM track_credits WHERE artist_id = ? AND artist_mbid IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1", &[json!(artist_id)])?.first() {
        if let Some(m) = r.get("artist_mbid").and_then(|v| v.as_str()) { return Ok(Some((m.to_string(), "track credits".into()))); }
    }
    let isrcs = db.query("SELECT t.isrc FROM tracks t JOIN (SELECT track_id, COUNT(*) c FROM plays_resolved WHERE artist_id = ? GROUP BY 1) p USING (track_id) WHERE t.isrc IS NOT NULL ORDER BY p.c DESC LIMIT 2", &[json!(artist_id)])?;
    let want = norm(name);
    for r in isrcs {
        let Some(isrc) = r.get("isrc").and_then(|v| v.as_str()) else { continue };
        let v = mb.get(db, &format!("recording?query=isrc:{isrc}&limit=3&fmt=json"))?;
        for rec in v["recordings"].as_array().cloned().unwrap_or_default() {
            for c in rec["artist-credit"].as_array().cloned().unwrap_or_default() {
                let cname = c["name"].as_str().or(c["artist"]["name"].as_str()).unwrap_or("");
                if norm(cname) == want || norm(c["artist"]["name"].as_str().unwrap_or("")) == want {
                    if let Some(m) = c["artist"]["id"].as_str() { return Ok(Some((m.to_string(), format!("ISRC {isrc}")))); }
                }
            }
        }
    }
    Ok(None)
}

/// Exact-name namesakes from a name search (score ≥ 80), as returned by MusicBrainz.
fn namesakes(mb: &Mb, db: &Db, name: &str) -> Result<Vec<Value>> {
    let q = urlencoding::encode(&format!("artist:\"{}\"", name.replace('"', ""))).into_owned();
    let v = mb.get(db, &format!("artist/?query={q}&limit=10&fmt=json"))?;
    let want = norm(name);
    Ok(v["artists"].as_array().cloned().unwrap_or_default().into_iter()
        .filter(|x| x["score"].as_i64().unwrap_or(0) >= 80 && (norm(x["name"].as_str().unwrap_or("")) == want || x["aliases"].as_array().map(|a| a.iter().any(|al| norm(al["name"].as_str().unwrap_or("")) == want)).unwrap_or(false)))
        .collect())
}

/// Among namesakes, the one whose release groups share the most titles with your albums by this artist.
fn pick_by_albums(mb: &Mb, db: &Db, artist_id: &str, cands: &[Value]) -> Result<Option<(String, String)>> {
    let mine: std::collections::HashSet<String> = db.query("SELECT DISTINCT album_name FROM plays_resolved WHERE artist_id = ? AND album_name IS NOT NULL", &[json!(artist_id)])?
        .into_iter().filter_map(|r| r.get("album_name").and_then(|v| v.as_str()).map(norm)).collect();
    if mine.is_empty() { return Ok(None); }
    let mut best: Option<(String, usize)> = None;
    for c in cands.iter().take(5) {
        let Some(id) = c["id"].as_str() else { continue };
        let v = mb.get(db, &format!("release-group?artist={id}&limit=100&fmt=json"))?;
        let hits = v["release-groups"].as_array().map(|a| a.iter().filter(|rg| mine.contains(&norm(rg["title"].as_str().unwrap_or("")))).count()).unwrap_or(0);
        if hits > 0 && best.as_ref().map(|b| hits > b.1).unwrap_or(true) { best = Some((id.to_string(), hits)); }
    }
    Ok(best.map(|(id, n)| (id, format!("{n} of your {} album titles", mine.len()))))
}

/// MusicBrainz tags for one artist id → artist_tags (source 'musicbrainz').
fn fetch_tags(mb: &Mb, db: &Db, artist_id: &str, mbid: &str) -> Result<()> {
    let v = mb.get(db, &format!("artist/{mbid}?inc=tags&fmt=json"))?;
    for t in v["tags"].as_array().cloned().unwrap_or_default() {
        let Some(tag) = t["name"].as_str().and_then(normalize_tag) else { continue };
        let w = (t["count"].as_f64().unwrap_or(1.0) / 10.0).min(1.0).max(0.1);
        db.exec("INSERT INTO artist_tags (artist_id, tag, weight, source) VALUES (?, ?, ?, 'musicbrainz') ON CONFLICT (artist_id, tag, source) DO UPDATE SET weight = GREATEST(artist_tags.weight, excluded.weight), fetched_at = now()", &[json!(artist_id), json!(tag), json!(w)])?;
    }
    Ok(())
}

/// Point an artist at a different MusicBrainz id and discard everything fetched through the old one
/// (non-owner origin, MusicBrainz tags, relations, catalogue). Origin and tags are re-fetched right away.
pub fn apply_mbid(mb: &Mb, db: &Db, artist_id: &str, mbid: &str) -> Result<()> {
    db.exec("UPDATE artists SET mbid = ?, enriched_at = COALESCE(enriched_at, now()) WHERE artist_id = ?", &[json!(mbid), json!(artist_id)])?;
    db.exec("DELETE FROM artist_origin WHERE artist_id = ? AND COALESCE(source, '') <> 'owner'", &[json!(artist_id)])?;
    db.exec("DELETE FROM artist_tags WHERE artist_id = ? AND source = 'musicbrainz'", &[json!(artist_id)])?;
    let _ = db.exec("DELETE FROM artist_relations WHERE artist_id = ?", &[json!(artist_id)]);
    let _ = db.exec("UPDATE artists SET catalogue_fetched_at = NULL WHERE artist_id = ?", &[json!(artist_id)]);   // recount under the new id
    let _ = fetch_tags(mb, db, artist_id, mbid);
    let _ = crate::connectors::wikidata::origin_for(mb, db, artist_id, mbid);
    Ok(())
}

pub fn resolve_batch(db: &Db, max_artists: usize) -> Result<usize> {
    let mb = Mb::new()?;
    let rows = db.query(&format!(
        "SELECT a.artist_id, a.name FROM artists a JOIN (SELECT artist_id, COUNT(*) c FROM plays_resolved GROUP BY 1) p USING (artist_id)
         WHERE a.mbid IS NULL AND NOT EXISTS (SELECT 1 FROM artist_mb_match m WHERE m.artist_id = a.artist_id AND m.checked_at > now() - INTERVAL 60 DAY)
           AND NOT EXISTS (SELECT 1 FROM api_calls c WHERE c.service = 'musicbrainz' AND c.endpoint = 'resolve:' || a.artist_id AND c.called_at > now() - INTERVAL 60 DAY)
         ORDER BY p.c DESC LIMIT {max_artists}"), &[])?;
    let mut n = 0;
    for r in rows {
        let (Some(id), Some(name)) = (r.get("artist_id").and_then(|v| v.as_str()), r.get("name").and_then(|v| v.as_str())) else { continue };
        let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('musicbrainz', ?, 200)", &[json!(format!("resolve:{id}"))]);
        let res: Result<()> = (|| {
            if let Some((mbid, ev)) = mbid_from_isrc(&mb, db, id, name)? {
                record_match(db, id, Some(&mbid), "isrc", &ev, 0)?;
                db.exec("UPDATE artists SET mbid = ?, enriched_at = now() WHERE artist_id = ?", &[json!(mbid), json!(id)])?;
                fetch_tags(&mb, db, id, &mbid)?; n += 1; return Ok(());
            }
            let c = namesakes(&mb, db, name)?;
            let (pick, method, ev) = match c.len() {
                0 => { record_match(db, id, None, "none", "no exact-name match", 0)?; return Ok(()); }
                1 => (c[0]["id"].as_str().map(str::to_string), "name", "the only exact-name match".to_string()),
                k => match pick_by_albums(&mb, db, id, &c)? {
                    Some((m, ev)) => (Some(m), "albums", ev),
                    None => { record_match(db, id, None, "ambiguous", &format!("{k} artists share this name"), k as i64)?; return Ok(()); }
                },
            };
            let Some(mbid) = pick else { return Ok(()) };
            record_match(db, id, Some(&mbid), method, &ev, c.len() as i64)?;
            db.exec("UPDATE artists SET mbid = ?, enriched_at = now() WHERE artist_id = ?", &[json!(mbid), json!(id)])?;
            fetch_tags(&mb, db, id, &mbid)?; n += 1; Ok(())
        })();
        if let Err(e) = res { set_state(db, "musicbrainz", "error", None, Some(&e.to_string())); break; }
    }
    if n > 0 { set_state(db, "musicbrainz", "connected", None, None); db.log_activity("musicbrainz", "info", &format!("Resolved {n} artists"), None); }
    Ok(n)
}

/// Re-check matches made before 9i (or by name only) against ISRC evidence; correct the wrong ones.
pub fn verify_batch(db: &Db, max_artists: usize) -> Result<usize> {
    let mb = Mb::new()?;
    let rows = db.query(&format!(
        "SELECT a.artist_id, a.name, a.mbid FROM artists a JOIN (SELECT artist_id, COUNT(*) c FROM plays_resolved GROUP BY 1) p USING (artist_id)
         LEFT JOIN artist_mb_match m USING (artist_id)
         WHERE a.mbid IS NOT NULL AND (m.artist_id IS NULL OR (m.method = 'name' AND m.checked_at < now() - INTERVAL 30 DAY))
         ORDER BY p.c DESC LIMIT {max_artists}"), &[])?;
    let mut fixed = 0; let mut names: Vec<String> = Vec::new();
    for r in rows {
        let g = |k: &str| r.get(k).and_then(|v| v.as_str()).map(str::to_string);
        let (Some(id), Some(name), Some(cur)) = (g("artist_id"), g("name"), g("mbid")) else { continue };
        match mbid_from_isrc(&mb, db, &id, &name) {
            Ok(Some((mbid, ev))) if mbid != cur => {
                record_match(db, &id, Some(&mbid), "isrc", &format!("{ev} — replaced a name-only match"), 0)?;
                apply_mbid(&mb, db, &id, &mbid)?;
                fixed += 1; if names.len() < 6 { names.push(name.clone()); }
            }
            Ok(Some((mbid, ev))) => record_match(db, &id, Some(&mbid), "isrc", &ev, 0)?,
            Ok(None) => record_match(db, &id, Some(&cur), "name", "no ISRC evidence yet", 0)?,
            Err(e) => { set_state(db, "musicbrainz", "error", None, Some(&e.to_string())); break; }
        }
    }
    if fixed > 0 { db.log_activity("musicbrainz", "info", &format!("Corrected {fixed} MusicBrainz matches against your tracks' ISRCs: {}", names.join(", ")), None); }
    Ok(fixed)
}

/// For the artist page's "wrong artist?" picker: every exact-name namesake with where/when it's from.
pub fn candidates(db: &Db, artist_id: &str) -> Result<Vec<Value>> {
    let mb = Mb::new()?;
    let name = db.query("SELECT name FROM artists WHERE artist_id = ?", &[json!(artist_id)])?.first().and_then(|r| r.get("name")).and_then(|v| v.as_str()).map(str::to_string).ok_or_else(|| anyhow::anyhow!("unknown artist"))?;
    let q = urlencoding::encode(&format!("artist:\"{}\"", name.replace('"', ""))).into_owned();
    let v = mb.get(db, &format!("artist/?query={q}&limit=12&fmt=json"))?;
    Ok(v["artists"].as_array().cloned().unwrap_or_default().into_iter().map(|a| json!({
        "mbid": a["id"], "name": a["name"], "disambiguation": a["disambiguation"], "type": a["type"], "country": a["country"],
        "area": a["area"]["name"], "beginArea": a["begin-area"]["name"], "begin": a["life-span"]["begin"], "end": a["life-span"]["end"], "score": a["score"],
    })).collect())
}

pub fn set_owner_mbid(db: &Db, artist_id: &str, mbid: &str) -> Result<()> {
    let mbid = mbid.trim().trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();   // accept a pasted musicbrainz.org URL
    if mbid.len() != 36 || mbid.chars().filter(|c| *c == '-').count() != 4 { anyhow::bail!("That doesn't look like a MusicBrainz artist id or URL"); }
    let mb = Mb::new()?;
    record_match(db, artist_id, Some(&mbid), "owner", "chosen by you", 0)?;
    apply_mbid(&mb, db, artist_id, &mbid)
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
