//! ListenBrainz (open, free, no key for reads). Two things we take:
//!  * similar artists from their collaborative-filtering dataset (per artist MBID) → artist_relations 'lb_similar'
//!  * per-artist "listener" popularity is skipped (not needed)
//! Politeness: ≤ 2 req/s, descriptive UA.

use super::set_state;
use crate::db::Db;
use anyhow::Result;
use serde_json::{json, Value};
use std::time::Duration;

const UA: &str = "DeepCuts/3.0 (local personal listening analytics)";

pub fn connect(db: &Db) -> Result<()> {
    let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(15)).user_agent(UA).build()?;
    let ok = http.get("https://api.listenbrainz.org/1/stats/sitewide/artists?range=week&count=1").send().map(|r| r.status().is_success()).unwrap_or(false);
    if !ok { anyhow::bail!("ListenBrainz isn't reachable right now"); }
    set_state(db, "listenbrainz", "connected", Some("no account needed"), None);
    db.log_activity("listenbrainz", "info", "ListenBrainz reachable", None);
    Ok(())
}

/// Similar artists for resolved MBIDs, most-played first. Uses the labs "similar-artists" endpoint.
pub fn enrich_similar(db: &Db, max_seeds: usize) -> Result<usize> {
    let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(20)).user_agent(UA).build()?;
    let rows = db.query(&format!(
        "SELECT a.artist_id, a.mbid FROM artists a JOIN (SELECT artist_id, SUM(ms_played) h FROM plays_resolved WHERE attended GROUP BY 1) p USING (artist_id)
         WHERE a.mbid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM api_calls c WHERE c.service = 'listenbrainz' AND c.endpoint = 'similar:' || a.mbid AND c.called_at >= now() - INTERVAL 30 DAY)
         ORDER BY p.h DESC LIMIT {max_seeds}"), &[])?;
    let mut n = 0;
    for r in rows {
        let (Some(id), Some(mbid)) = (r.get("artist_id").and_then(|v| v.as_str()), r.get("mbid").and_then(|v| v.as_str())) else { continue };
        let url = format!("https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids={mbid}&algorithm=session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30");
        let resp = http.get(&url).send();
        let status = resp.as_ref().map(|r| r.status().as_u16()).unwrap_or(0);
        db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('listenbrainz', ?, ?)", &[json!(format!("similar:{mbid}")), json!(status)])?;
        let Ok(res) = resp else { break };
        if status == 429 { std::thread::sleep(Duration::from_secs(20)); break; }
        if status != 200 { continue; }
        let v: Value = res.json().unwrap_or(Value::Null);
        db.exec("DELETE FROM artist_relations WHERE artist_mbid = ? AND relation_type = 'lb_similar'", &[json!(id)])?;
        for sa in v.as_array().cloned().unwrap_or_default().iter().take(40) {
            let (Some(smbid), Some(name)) = (sa["artist_mbid"].as_str(), sa["name"].as_str()) else { continue };
            let score = sa["score"].as_f64().unwrap_or(0.0);
            db.exec("INSERT INTO artist_relations (artist_mbid, relation_type, related_mbid, related_name) VALUES (?, 'lb_similar', ?, ?)",
                &[json!(id), json!(format!("{smbid}|{:.3}", (score / 100000.0).min(1.0))), json!(name)])?;
        }
        n += 1;
        std::thread::sleep(Duration::from_millis(600));
    }
    if n > 0 { db.log_activity("listenbrainz", "info", &format!("Similar artists for {n} seeds"), None); }
    Ok(n)
}

pub fn disconnect(db: &Db) -> Result<()> { set_state(db, "listenbrainz", "disconnected", None, None); Ok(()) }
