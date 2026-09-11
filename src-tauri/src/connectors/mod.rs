//! CON-01…13: external services. Each connector is a plain module with
//! `validate` (before a key is saved) and one or more sync steps the
//! scheduler calls. Keys live in the keyring; state in `connector_state`.

pub mod lastfm;
pub mod musicbrainz;
pub mod statsfm;
pub mod lyrics;
pub mod coverart;
pub mod listenbrainz;
pub mod wikidata;

use crate::db::Db;
use serde_json::json;

pub fn set_state(db: &Db, service: &str, status: &str, account: Option<&str>, err: Option<&str>) {
    let _ = db.exec(
        "UPDATE connector_state SET status = ?, account = COALESCE(?, account), last_error = ?, last_sync_at = CASE WHEN ? = 'connected' THEN now() ELSE last_sync_at END WHERE service = ?",
        &[json!(status), json!(account), json!(err), json!(status), json!(service)],
    );
}

/// Tag normalisation shared by Last.fm and MusicBrainz (ENR-02, CON-12).
pub fn normalize_tag(raw: &str) -> Option<String> {
    let t = raw.trim().to_lowercase().replace('_', " ").replace('-', " ");
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() || t.len() > 40 { return None; }
    // drop non-descriptive folksonomy noise
    const NOISE: &[&str] = &["seen live", "favorites", "favourites", "favorite", "albums i own", "under 2000 listeners", "all", "spotify", "my music", "beautiful", "awesome", "love", "check out", "usa", "uk", "american", "british", "english", "german", "french", "male vocalists", "female vocalists", "male vocalist", "female vocalist", "00s", "10s", "90s", "80s", "70s", "60s"];
    if NOISE.contains(&t.as_str()) || t.chars().all(|c| c.is_ascii_digit()) { return None; }
    let t = match t.as_str() {
        "hip hop" | "hiphop" | "rap" => "hip-hop".to_string(),
        "r&b" | "rnb" | "r and b" => "r&b".to_string(),
        "post punk" => "post-punk".to_string(),
        "post rock" => "post-rock".to_string(),
        "synth pop" | "synthpop" => "synth-pop".to_string(),
        "dream pop" | "dreampop" => "dream pop".to_string(),
        "trip hop" | "triphop" => "trip-hop".to_string(),
        "lo fi" | "lofi" => "lo-fi".to_string(),
        "alternative" => "alternative rock".to_string(),
        "electronica" => "electronic".to_string(),
        "indie" => "indie rock".to_string(),
        other => other.to_string(),
    };
    Some(t)
}
