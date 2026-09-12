//! API-09: the ONLY place Spotify paths, query parameters and JSON field
//! names appear. Watch developer.spotify.com/documentation/web-api/references/changes/*.

pub const ACCOUNTS_AUTHORIZE: &str = "https://accounts.spotify.com/authorize";
pub const ACCOUNTS_TOKEN: &str = "https://accounts.spotify.com/api/token";
pub const API_BASE: &str = "https://api.spotify.com/v1";

/// API-01: loopback IP, never `localhost`.
pub const REDIRECT_URI: &str = "http://127.0.0.1:8888/callback";
pub const LOOPBACK_BIND: &str = "127.0.0.1:8888";

/// API-02
/// Phase 9b added `user-modify-playback-state` for add-to-queue. Scopes are fixed at consent time, so
/// users who connected before 9b must reconnect once; `SpotifyClient::has_scope` drives that prompt.
pub const SCOPES: &str = "user-read-recently-played user-library-read playlist-read-private playlist-modify-private playlist-modify-public user-modify-playback-state";
pub const SCOPE_QUEUE: &str = "user-modify-playback-state";

pub fn me() -> String { format!("{API_BASE}/me") }
/// ING-05: max 50 per call.
pub fn recently_played(limit: u32) -> String { format!("{API_BASE}/me/player/recently-played?limit={limit}") }
/// ING-07: paginated, limit 50.
pub fn my_tracks(limit: u32, offset: u32) -> String { format!("{API_BASE}/me/tracks?limit={limit}&offset={offset}") }
/// ING-08
pub fn my_playlists(limit: u32, offset: u32) -> String { format!("{API_BASE}/me/playlists?limit={limit}&offset={offset}") }
/// API-04: `/playlists/{id}/items`, fields `items` / `item`.
pub fn playlist_items(id: &str, limit: u32, offset: u32) -> String { format!("{API_BASE}/playlists/{id}/items?limit={limit}&offset={offset}") }
/// API-03: playlist creation is `POST /me/playlists`.
pub fn create_playlist() -> String { format!("{API_BASE}/me/playlists") }
/// API-05: individual metadata calls only (no batch endpoints).
pub fn track(id: &str) -> String { format!("{API_BASE}/tracks/{id}") }
pub fn album(id: &str) -> String { format!("{API_BASE}/albums/{id}") }
pub fn artist(id: &str) -> String { format!("{API_BASE}/artists/{id}") }
/// Phase 9b: add one track to the end of the active playback queue. 404 NO_ACTIVE_DEVICE when nothing is playing anywhere.
pub fn queue(uri: &str) -> String { format!("{API_BASE}/me/player/queue?uri={}", urlencoding::encode(uri)) }

/// Field names, so `sync.rs` never spells them.
pub mod f {
    pub const ITEMS: &str = "items";             // list wrapper everywhere
    pub const ITEM: &str = "item";               // playlist item wrapper (API-04)
    pub const TRACK: &str = "track";             // recently-played / liked wrapper
    pub const PLAYED_AT: &str = "played_at";
    pub const ADDED_AT: &str = "added_at";
    pub const ID: &str = "id";
    pub const NAME: &str = "name";
    pub const URI: &str = "uri";
    pub const DURATION_MS: &str = "duration_ms";
    pub const ARTISTS: &str = "artists";
    pub const ALBUM: &str = "album";
    pub const ALBUM_TYPE: &str = "album_type";
    pub const TOTAL_TRACKS: &str = "total_tracks";
    pub const TRACK_NUMBER: &str = "track_number";
    pub const EXPLICIT: &str = "explicit";
    pub const EXTERNAL_IDS: &str = "external_ids";
    pub const ISRC: &str = "isrc";
    pub const RELEASE_DATE: &str = "release_date";
    pub const RELEASE_DATE_PRECISION: &str = "release_date_precision";
    pub const IMAGES: &str = "images";
    pub const URL: &str = "url";
    pub const DISPLAY_NAME: &str = "display_name";
    pub const NEXT: &str = "next";
    pub const TOTAL: &str = "total";
    pub const SNAPSHOT_ID: &str = "snapshot_id";
    pub const PUBLIC: &str = "public";
    pub const OWNER: &str = "owner";
    pub const DESCRIPTION: &str = "description";
    // API-07
    pub const ERROR: &str = "error";
    pub const REASON: &str = "reason";
    pub const QUOTA_EXCEEDED: &str = "QUOTA_EXCEEDED";
}

/// API-07 budget.
pub mod budget {
    pub const POLL_EVERY_SECS: u64 = 20 * 60;          // 3/hour
    pub const LIBRARY_SYNC_EVERY_SECS: u64 = 24 * 3600; // daily
    /// Default adaptive ceiling. Phase 9b lowered 200 → 100 for daily-quota headroom and made it
    /// owner-tunable (app_meta `enrich_per_hour`, read by `enrich_per_hour()` below).
    pub const ENRICH_PER_HOUR: usize = 100;
    pub const ENRICH_PER_HOUR_MIN: usize = 25;
    pub const ENRICH_PER_HOUR_MAX: usize = 300;
    /// The effective hourly ceiling: the stored setting clamped into [MIN, MAX], else the default.
    pub fn enrich_per_hour(db: &crate::db::Db) -> usize {
        db.query("SELECT value FROM app_meta WHERE key = 'enrich_per_hour'", &[]).ok()
            .and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str()).and_then(|v| v.trim().parse::<usize>().ok()))
            .map(|v| v.clamp(ENRICH_PER_HOUR_MIN, ENRICH_PER_HOUR_MAX)).unwrap_or(ENRICH_PER_HOUR)
    }
    pub const ENRICH_BATCH: usize = 25;                // per scheduler tick
}
