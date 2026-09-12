//! Phase 9b — add-to-queue (design brief §5). One `POST /me/player/queue?uri=…` per click.
//!
//! Two constraints the UI has to speak to, so the result is a structured outcome rather than
//! an error string:
//!   - `needs_reauth`: the stored consent predates the `user-modify-playback-state` scope.
//!     Scopes are fixed at consent time; the fix is a one-time reconnect on the Services page.
//!   - `no_device`: Spotify 404s when nothing is in a playback session anywhere (phone, desktop,
//!     web player). This is the common failure, not an edge case, and needs its own message.
//! Tracks without a real Spotify id (`local:`) can't be queued — the button is disabled for them
//! upstream and this refuses them too.

use super::client::{ApiError, SpotifyClient};
use super::endpoints as ep;
use crate::db::Db;
use serde::Serialize;
use serde_json::json;

#[derive(Debug, Clone, Serialize)]
pub struct QueueOutcome {
    /// 'queued' | 'no_device' | 'needs_reauth' | 'not_connected' | 'quota' | 'unqueueable' | 'error'
    pub status: &'static str,
    pub message: String,
}

fn out(status: &'static str, message: impl Into<String>) -> QueueOutcome { QueueOutcome { status, message: message.into() } }

pub fn queue_track(client: &SpotifyClient, db: &Db, track_id: &str) -> QueueOutcome {
    if track_id.is_empty() || track_id.starts_with("local:") { return out("unqueueable", "This track has no Spotify id, so it can't be queued."); }
    if !client.is_connected() { return out("not_connected", "Connect Spotify in Services first."); }
    if !client.has_scope(ep::SCOPE_QUEUE) { return out("needs_reauth", "Queueing needs a permission your Spotify connection predates — reconnect Spotify once in Services."); }
    let name = db.query("SELECT t.name, a.name AS artist FROM tracks t LEFT JOIN artists a ON a.artist_id = t.artist_id WHERE t.track_id = ?", &[json!(track_id)])
        .ok().and_then(|r| r.first().map(|m| format!("{}{}", m.get("name").and_then(|v| v.as_str()).unwrap_or("track"), m.get("artist").and_then(|v| v.as_str()).map(|a| format!(" — {a}")).unwrap_or_default())))
        .unwrap_or_else(|| track_id.to_string());
    let uri = format!("spotify:track:{track_id}");
    // No payload on this endpoint; `post()` always sends a body, and `{}` is safer than a literal `null`.
    match client.post(db, &ep::queue(&uri), json!({})) {
        Ok(_) => { db.log_activity("queue", "info", &format!("Queued {name}"), None); out("queued", format!("Queued {name}.")) }
        Err(ApiError::Http { status: 404, body }) if body.contains("NO_ACTIVE_DEVICE") || body.to_lowercase().contains("device") => out("no_device", "Nothing is playing. Open Spotify on a device and start something, then try again."),
        Err(ApiError::Http { status: 403, .. }) => out("needs_reauth", "Spotify refused: reconnect Spotify in Services to grant playback control."),
        Err(ApiError::Http { status, body }) => { db.log_activity("queue", "warn", &format!("Queue failed ({status})"), Some(&body.chars().take(300).collect::<String>())); out("error", format!("Spotify said {status}.")) }
        Err(ApiError::Quota) => out("quota", "Spotify's daily quota is exhausted for today."),
        Err(ApiError::Unauthorized) => out("not_connected", "Spotify is not connected."),
        Err(ApiError::Other(e)) => { db.log_activity("queue", "warn", "Queue failed", Some(&format!("{e:#}"))); out("error", format!("{e:#}")) }
    }
}
