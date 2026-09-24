//! Phase 9j — Wikipedia pictures and descriptions for artists. No key; polite User-Agent; ≤ 1 request/second.
//! Chain: MusicBrainz `artist/{mbid}?inc=url-rels` → Wikidata QID → sitelink in the chosen language (`wiki_lang`,
//! default en, English fallback) → `/api/rest_v1/page/summary/{title}` (extract, description, thumbnail).
//! Only artists with a verified MusicBrainz match (method isrc / albums / owner) are looked up, so a namesake's
//! article can't be attached. Not found → recorded, retried after 90 days.

use crate::connectors::musicbrainz::Mb;
use crate::db::Db;
use anyhow::Result;
use serde_json::{json, Value};
use std::time::Duration;

const UA: &str = "DeepCuts/3.0 (personal listening analytics; https://github.com/deep-cuts/deep-cuts)";

fn http() -> Result<reqwest::blocking::Client> { Ok(reqwest::blocking::Client::builder().timeout(Duration::from_secs(20)).user_agent(UA).build()?) }

fn lang(db: &Db) -> String {
    db.query("SELECT value FROM app_meta WHERE key = 'wiki_lang'", &[]).ok().and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str().map(str::to_string)))
        .filter(|l| l.len() >= 2 && l.len() <= 5 && l.chars().all(|c| c.is_ascii_lowercase() || c == '-')).unwrap_or_else(|| "en".into())
}

pub fn enrich_batch(db: &Db, max_artists: usize) -> Result<usize> {
    let mb = Mb::new()?;
    let h = http()?;
    let want = lang(db);
    let rows = db.query(&format!(
        "SELECT a.artist_id, a.mbid FROM artists a JOIN artist_mb_match m USING (artist_id)
         JOIN (SELECT artist_id, COUNT(*) c FROM plays_resolved GROUP BY 1) p USING (artist_id)
         LEFT JOIN artist_wiki w USING (artist_id)
         WHERE a.mbid IS NOT NULL AND m.method IN ('isrc', 'albums', 'owner')
           AND (w.artist_id IS NULL OR (NOT w.found AND w.fetched_at < now() - INTERVAL 90 DAY) OR (w.found AND w.fetched_at < now() - INTERVAL 180 DAY))
         ORDER BY (w.artist_id IS NULL) DESC, p.c DESC LIMIT {max_artists}"), &[])?;
    let mut n = 0;
    for r in rows {
        let (Some(id), Some(mbid)) = (r.get("artist_id").and_then(|v| v.as_str()), r.get("mbid").and_then(|v| v.as_str())) else { continue };
        let found = match lookup(&mb, &h, db, mbid, &want) {
            Ok(Some(w)) => {
                db.exec("INSERT INTO artist_wiki (artist_id, qid, lang, title, extract, description, image_url, page_url, found, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, now())
                         ON CONFLICT (artist_id) DO UPDATE SET qid = excluded.qid, lang = excluded.lang, title = excluded.title, extract = excluded.extract, description = excluded.description, image_url = excluded.image_url, page_url = excluded.page_url, found = TRUE, fetched_at = now()",
                    &[json!(id), json!(w.qid), json!(w.lang), json!(w.title), json!(w.extract), json!(w.description), json!(w.image), json!(w.url)])?;
                true
            }
            Ok(None) => { db.exec("INSERT INTO artist_wiki (artist_id, found, fetched_at) VALUES (?, FALSE, now()) ON CONFLICT (artist_id) DO UPDATE SET found = FALSE, fetched_at = now()", &[json!(id)])?; false }
            Err(e) => { log::warn!("wikipedia {id}: {e}"); break; }
        };
        if found { n += 1; }
        std::thread::sleep(Duration::from_millis(1000));
    }
    if n > 0 { db.log_activity("wikipedia", "info", &format!("Wikipedia summaries for {n} artists"), None); }
    Ok(n)
}

struct Wiki { qid: String, lang: String, title: String, extract: Option<String>, description: Option<String>, image: Option<String>, url: Option<String> }

fn lookup(mb: &Mb, h: &reqwest::blocking::Client, db: &Db, mbid: &str, want: &str) -> Result<Option<Wiki>> {
    let v = mb.get(db, &format!("artist/{mbid}?inc=url-rels&fmt=json"))?;
    let rels = v["relations"].as_array().cloned().unwrap_or_default();
    let qid = rels.iter().filter(|r| r["type"].as_str() == Some("wikidata")).filter_map(|r| r["url"]["resource"].as_str()).filter_map(|u| u.rsplit('/').next().map(str::to_string)).find(|q| q.starts_with('Q'));
    let Some(qid) = qid else { return Ok(None) };
    let wd: Value = h.get(format!("https://www.wikidata.org/wiki/Special:EntityData/{qid}.json")).send()?.json()?;
    let ent = &wd["entities"][&qid];
    let (lang, title) = [want, "en"].iter().find_map(|l| ent["sitelinks"][format!("{l}wiki")]["title"].as_str().map(|t| (l.to_string(), t.to_string()))).unzip();
    let (Some(lang), Some(title)) = (lang, title) else { return Ok(None) };
    let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('wikipedia', 'summary', 200)", &[]);
    let enc = urlencoding::encode(&title.replace(' ', "_")).into_owned();
    let s: Value = h.get(format!("https://{lang}.wikipedia.org/api/rest_v1/page/summary/{enc}")).send()?.json()?;
    if s["type"].as_str() == Some("disambiguation") { return Ok(None); }
    Ok(Some(Wiki {
        qid, lang, title,
        extract: s["extract"].as_str().map(|x| x.chars().take(1200).collect()),
        description: s["description"].as_str().map(str::to_string).or_else(|| ent["descriptions"][want]["value"].as_str().map(str::to_string)),
        image: s["thumbnail"]["source"].as_str().or(s["originalimage"]["source"].as_str()).map(str::to_string),
        url: s["content_urls"]["desktop"]["page"].as_str().map(str::to_string),
    }))
}
