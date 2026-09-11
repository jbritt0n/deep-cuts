//! PLY-07 / PLY-10 / DIS-02: create playlists on Spotify through the 2026 dev-mode
//! endpoints (`POST /me/playlists`, `POST /playlists/{id}/items`, ≤100 URIs per call).
//! Private by default; the caller passes `public` from the UI toggle.

use crate::db::Db;
use crate::spotify::client::SpotifyClient;
use crate::spotify::endpoints::{self as ep, f};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Deserialize)]
pub struct NewPlaylist {
    pub name: String,
    pub description: Option<String>,
    pub public: bool,
    pub kind: String,                 // 'list_export' | 'insight' | 'radar' | 'theme'
    pub track_ids: Vec<String>,       // Spotify track ids (no 'local:' ones)
    pub source_note: Option<String>,  // what list this came from
}

#[derive(Debug, Clone, Serialize)]
pub struct CreatedPlaylist { pub spotify_playlist_id: String, pub url: String, pub added: usize, pub skipped_local: usize }

pub fn create(client: &SpotifyClient, db: &Db, p: &NewPlaylist) -> Result<CreatedPlaylist> {
    let ids: Vec<&String> = p.track_ids.iter().filter(|t| !t.starts_with("local:")).collect();
    let skipped_local = p.track_ids.len() - ids.len();
    if ids.is_empty() { return Err(anyhow!("None of these tracks have Spotify ids")); }
    let body = json!({ f::NAME: p.name, f::DESCRIPTION: p.description.clone().unwrap_or_default(), f::PUBLIC: p.public });
    let created = client.post(db, &ep::create_playlist(), body).map_err(|e| anyhow!("{e}"))?;
    let pid = created[f::ID].as_str().ok_or_else(|| anyhow!("Spotify didn't return a playlist id"))?.to_string();
    let url = created["external_urls"]["spotify"].as_str().unwrap_or("").to_string();
    let mut added = 0;
    for chunk in ids.chunks(100) {
        let uris: Vec<String> = chunk.iter().map(|id| format!("spotify:track:{id}")).collect();
        client.post(db, &ep::playlist_items(&pid, 100, 0).split('?').next().unwrap().to_string(), json!({ "uris": uris })).map_err(|e| anyhow!("{e}"))?;
        added += chunk.len();
    }
    db.exec(
        "INSERT INTO created_playlists (spotify_playlist_id, name, kind, theme_text, track_ids, is_public) VALUES (?, ?, ?, ?, CAST(? AS JSON), ?)",
        &[json!(pid), json!(p.name), json!(p.kind), json!(p.source_note), json!(serde_json::to_string(&p.track_ids)?), json!(p.public)],
    )?;
    db.log_activity("playlist", "info", &format!("Created playlist “{}” ({added} tracks, {})", p.name, if p.public { "public" } else { "private" }), Some(&url));
    Ok(CreatedPlaylist { spotify_playlist_id: pid, url, added, skipped_local })
}

/// DIS-02: add to the Deep Cuts Radar playlist (created when absent, private).
pub fn add_to_radar(client: &SpotifyClient, db: &Db, track_ids: &[String]) -> Result<CreatedPlaylist> {
    let existing = db.query("SELECT spotify_playlist_id FROM created_playlists WHERE kind = 'radar' ORDER BY created_at DESC LIMIT 1", &[])?;
    let pid = existing.first().and_then(|r| r.get("spotify_playlist_id")).and_then(|v| v.as_str().map(str::to_string));
    let ids: Vec<&String> = track_ids.iter().filter(|t| !t.starts_with("local:")).collect();
    if ids.is_empty() { return Err(anyhow!("Nothing with a Spotify id to add")); }
    let pid = match pid {
        Some(p) => p,
        None => create(client, db, &NewPlaylist { name: "Deep Cuts Radar".into(), description: Some("Things Deep Cuts thinks you'll like. Private.".into()), public: false, kind: "radar".into(), track_ids: vec![], source_note: None })
            .map(|c| c.spotify_playlist_id).or_else(|_| -> Result<String> {
                // create() refuses empty lists; make the shell directly
                let created = client.post(db, &ep::create_playlist(), json!({ f::NAME: "Deep Cuts Radar", f::DESCRIPTION: "Things Deep Cuts thinks you'll like. Private.", f::PUBLIC: false })).map_err(|e| anyhow!("{e}"))?;
                let id = created[f::ID].as_str().ok_or_else(|| anyhow!("no id"))?.to_string();
                db.exec("INSERT INTO created_playlists (spotify_playlist_id, name, kind, is_public) VALUES (?, 'Deep Cuts Radar', 'radar', FALSE)", &[json!(id)])?;
                Ok(id)
            })?,
    };
    let uris: Vec<String> = ids.iter().map(|id| format!("spotify:track:{id}")).collect();
    let base = ep::playlist_items(&pid, 100, 0);
    client.post(db, base.split('?').next().unwrap(), json!({ "uris": uris })).map_err(|e| anyhow!("{e}"))?;
    Ok(CreatedPlaylist { spotify_playlist_id: pid.clone(), url: format!("https://open.spotify.com/playlist/{pid}"), added: ids.len(), skipped_local: track_ids.len() - ids.len() })
}

/// Search Spotify for an artist's top track ids so a recommendation can be added to Radar (API-06: search limit ≤ 10).
pub fn search_track_ids(client: &SpotifyClient, db: &Db, q: &str, n: usize) -> Result<Vec<String>> {
    let url = format!("{}/search?type=track&limit=10&q={}", ep::API_BASE, urlencoding::encode(q));
    let v: Value = client.get(db, &url, true).map_err(|e| anyhow!("{e}"))?;
    Ok(v["tracks"][f::ITEMS].as_array().map(|a| a.iter().filter_map(|t| t[f::ID].as_str().map(str::to_string)).take(n).collect()).unwrap_or_default())
}
