//! Typed Tauri commands — the whole surface the UI can call. Anything that
//! writes goes through here; the UI's own SQL is read-only (`query`).

use crate::db::{self, Db};
use crate::events;
use crate::importer;
use crate::AppState;
use serde::Serialize;
use serde_json::Value as Json;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub version: String,
    pub has_data: bool,
    pub demo: bool,
    pub play_count: i64,
    pub total_hours: f64,
    pub first_play: Option<String>,
    pub last_play: Option<String>,
    pub importing: bool,
    pub portable: bool,
    pub data_dir: String,
    pub db_path: String,
    pub timezone: String,
    pub last_import: Option<String>,
}

fn opt_str(rows: &[db::Row], key: &str) -> Option<String> {
    rows.first()
        .and_then(|r| r.get(key))
        .and_then(|v| v.as_str().map(str::to_string))
}

#[tauri::command]
pub fn get_status(state: State<'_, AppState>, app: AppHandle) -> CmdResult<Status> {
    let real = &state.real;
    let play_count = real.scalar_i64("SELECT COUNT(*) FROM plays_resolved").map_err(err)?;
    let has_data = play_count > 0;
    let active = state.active();
    let total_hours = active.scalar_f64("SELECT COALESCE(ROUND(SUM(ms_played)/3600000.0, 1), 0) FROM plays_resolved").map_err(err)?;
    let range = active
        .query("SELECT CAST(MIN(played_at) AS VARCHAR) AS first, CAST(MAX(played_at) AS VARCHAR) AS last FROM plays_resolved", &[])
        .map_err(err)?;
    let last_import = real
        .query("SELECT CAST(MAX(imported_at) AS VARCHAR) AS at FROM import_files", &[])
        .map_err(err)?;
    Ok(Status {
        version: app.package_info().version.to_string(),
        has_data,
        demo: !has_data,
        play_count: if has_data { play_count } else { active.scalar_i64("SELECT COUNT(*) FROM plays_resolved").map_err(err)? },
        total_hours,
        first_play: opt_str(&range, "first"),
        last_play: opt_str(&range, "last"),
        importing: state.importing.load(Ordering::SeqCst),
        portable: state.paths.portable,
        data_dir: state.paths.data_dir.to_string_lossy().to_string(),
        db_path: state.paths.db_path.to_string_lossy().to_string(),
        timezone: state.zone.lock().map(|z| z.clone()).unwrap_or_default(),
        last_import: opt_str(&last_import, "at"),
    })
}

/// Read-only query bridge for `src/lib/queries.ts`. Runs against the active
/// database (real when it has plays, otherwise the demo record — NFR-06).
#[tauri::command]
pub fn query(state: State<'_, AppState>, sql: String, params: Option<Vec<Json>>) -> CmdResult<Vec<db::Row>> {
    Db::assert_read_only(&sql).map_err(err)?;
    state.active().query(&sql, &params.unwrap_or_default()).map_err(err)
}

/// ING-01: inspect a dropped/picked zip, folder or file before importing.
#[tauri::command]
pub async fn inspect_import(state: State<'_, AppState>, path: String) -> CmdResult<importer::ImportPreview> {
    let real = state.real.clone();
    let p = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || importer::preview(&real, &p))
        .await
        .map_err(err)?
        .map_err(err)
}

/// Start an import in the background. Progress arrives as `import:*` events.
#[tauri::command]
pub fn start_import(state: State<'_, AppState>, app: AppHandle, path: String) -> CmdResult<String> {
    if state.importing.swap(true, Ordering::SeqCst) {
        return Err("An import is already running".into());
    }
    let import_id = uuid_v4();
    let id = import_id.clone();
    let real = state.real.clone();
    let p = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        match importer::run(&app, &real, &p, &id) {
            Ok(done) => {
                events::emit(&app, events::IMPORT_DONE, done);
                events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "import" }));
            }
            Err(e) => importer::report_error(&app, &real, &e),
        }
        st.importing.store(false, Ordering::SeqCst);
    });
    Ok(import_id)
}

/// DM-02: rebuild every derived table from `events`.
#[tauri::command]
pub async fn rebuild(state: State<'_, AppState>, app: AppHandle) -> CmdResult<()> {
    let active = state.active();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        active.rebuild_all()?;
        active.log_activity("rebuild", "info", "Rebuilt entities, sessions and milestones", None);
        Ok(())
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "rebuild" }));
    Ok(())
}

#[tauri::command]
pub fn get_activity(state: State<'_, AppState>, limit: Option<i64>) -> CmdResult<Vec<db::Row>> {
    state
        .real
        .query(
            "SELECT CAST(logged_at AS VARCHAR) AS at, task, level, message, detail FROM activity_log ORDER BY logged_at DESC LIMIT ?",
            &[serde_json::json!(limit.unwrap_or(100))],
        )
        .map_err(err)
}

#[tauri::command]
pub fn get_import_history(state: State<'_, AppState>) -> CmdResult<Vec<db::Row>> {
    state
        .real
        .query(
            "SELECT CAST(import_id AS VARCHAR) AS import_id, CAST(MIN(imported_at) AS VARCHAR) AS at, COUNT(*) AS files, \
             SUM(rows_inserted) AS inserted, SUM(rows_duplicate) AS duplicate, SUM(rows_skipped) AS skipped \
             FROM import_files GROUP BY import_id ORDER BY MIN(imported_at) DESC LIMIT 20",
            &[],
        )
        .map_err(err)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<Vec<db::Row>> {
    state.real.query("SELECT key, value FROM app_meta", &[]).map_err(err)
}

/// Whitelisted user settings live in app_meta on both records.
#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    const ALLOWED: &[&str] = &["attention_gap_min", "theme", "lyrics_enabled", "album_threshold",
        // Phase 9b: weekly-era tuning (design brief §3.5) and the Spotify enrichment ceiling
        "era_similarity", "era_min_weeks", "era_floor_h", "era_max_gap_weeks", "enrich_per_hour",
        // Phase 9c: Settings → Tuning (see src/lib/settings.ts TUNING for defaults and bounds)
        "short_play_seconds", "shape_loop_repeat", "shape_discovery_novelty", "shape_restless_skip", "shape_wander_entropy",
        "feedback_memory_days", "forgotten_days", "tag_floor", "lyrics_batch", "playlist_default_public", "mixtape_last_mix",
        // Phase 9c: The Crate — per-album skip (90 days) / keep decisions are recommendation_feedback rows; this is the crate's own toggle store
        "crate_show_related",
        // Phase 9e: local LLM
        "ollama_url", "ollama_model",
        // Phase 9f: lyrics v2 — let the local model name themes from the transient text
        "lyrics_llm_enabled",
        // Phase 9g: Settings → Tuning → threads / Not for me
        "thread_min_weeks", "thread_share_floor", "thread_max", "thread_per_year", "thread_max_coverage", "thread_scenes", "skiphall_min_shown", "skiphall_min_rate",
        // Phase 9h: Atlas → Listening abroad
        "home_country"];
    if !ALLOWED.contains(&key.as_str()) {
        return Err(format!("Unknown setting: {key}"));
    }
    for d in [&state.real, &state.demo] {
        d.exec(
            "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            &[serde_json::json!(key.as_str()), serde_json::json!(value.as_str())],
        ).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_timezones() -> Vec<String> {
    chrono_tz::TZ_VARIANTS.iter().map(|z| z.name().to_string()).collect()
}

/// Change the display time zone: reload offsets and rebuild derived tables.
#[tauri::command]
pub async fn set_timezone(state: State<'_, AppState>, app: AppHandle, zone: String) -> CmdResult<()> {
    if zone.parse::<chrono_tz::Tz>().is_err() {
        return Err(format!("Unknown time zone: {zone}"));
    }
    let real = state.real.clone();
    let demo = state.demo.clone();
    let z = zone.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        for d in [&real, &demo] {
            d.load_tz_offsets(&z)?;
            d.exec_batch(db::ENTITY_RESOLUTION_SQL)?;
            d.exec_batch(db::COMPUTE_SESSIONS_SQL)?;
            d.checkpoint()?;
        }
        real.log_activity("settings", "info", &format!("Time zone set to {z}"), None);
        Ok(())
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    if let Ok(mut g) = state.zone.lock() {
        *g = zone;
    }
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "timezone" }));
    Ok(())
}

#[tauri::command]
pub fn open_data_folder(state: State<'_, AppState>, app: AppHandle) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    // reveal_item_in_dir needs no path scope; it opens the folder with the DB selected.
    app.opener()
        .reveal_item_in_dir(&state.paths.db_path)
        .map_err(err)
}

/// NFR-03: one-click export of the raw event log as Parquet.
#[tauri::command]
/// Phase 9i — Settings → Record → Export everything (CSV or Parquet, every table + plays_enriched).
#[tauri::command]
pub async fn export_record(state: State<'_, AppState>, dest_dir: Option<String>, format: Option<String>) -> CmdResult<String> {
    let real = state.real.clone(); let paths = state.paths.clone();
    let dest = dest_dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| paths.backups_dir.clone());
    let fmt = format.unwrap_or_else(|| "csv".into());
    tauri::async_runtime::spawn_blocking(move || crate::migrate::export_record(&real, &dest, &fmt).map(|p| p.to_string_lossy().to_string())).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub async fn export_events(state: State<'_, AppState>) -> CmdResult<String> {
    let real = state.real.clone();
    let dir = state.paths.backups_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<String> {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let out = dir.join(format!("events-{stamp}.parquet"));
        real.exec_batch(&format!(
            "COPY (SELECT * FROM events ORDER BY occurred_at) TO '{}' (FORMAT PARQUET)",
            out.to_string_lossy().replace('\'', "''")
        ))?;
        real.log_activity("backup", "info", "Exported events", Some(&out.to_string_lossy()));
        Ok(out.to_string_lossy().to_string())
    })
    .await
    .map_err(err)?
    .map_err(err)
}

/// Phase 9f — Move to another computer. Writes deep-cuts-move-<stamp>.zip into `dest_dir` (Parquet per table +
/// manifest; connector secrets only when a passphrase is given, encrypted with it).
#[tauri::command]
pub async fn export_move_bundle(state: State<'_, AppState>, dest_dir: Option<String>, passphrase: Option<String>) -> CmdResult<String> {
    let real = state.real.clone(); let paths = state.paths.clone();
    let version = env!("CARGO_PKG_VERSION").to_string();
    let dest = dest_dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| paths.backups_dir.clone());
    tauri::async_runtime::spawn_blocking(move || crate::migrate::export_bundle(&real, &paths, &dest, passphrase.as_deref(), &version, crate::PIPELINE_REV).map(|p| p.to_string_lossy().to_string()))
        .await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub fn inspect_move_bundle(path: String) -> CmdResult<crate::migrate::Manifest> {
    crate::migrate::inspect_bundle(&PathBuf::from(path)).map_err(err)
}

/// Replaces this record with the bundle's, rebuilds every derived table, restores secrets when the passphrase opens them.
#[tauri::command]
pub async fn restore_move_bundle(state: State<'_, AppState>, app: AppHandle, path: String, passphrase: Option<String>) -> CmdResult<crate::migrate::RestoreReport> {
    if state.importing.swap(true, Ordering::SeqCst) { return Err("An import is already running".into()); }
    let real = state.real.clone(); let paths = state.paths.clone();
    let version = env!("CARGO_PKG_VERSION").to_string() + "+" + crate::PIPELINE_REV;
    let out = tauri::async_runtime::spawn_blocking(move || crate::migrate::restore_bundle(&real, &paths, &PathBuf::from(path), passphrase.as_deref(), &version)).await;
    state.importing.store(false, Ordering::SeqCst);
    let report = out.map_err(err)?.map_err(err)?;
    if let Ok(mut g) = state.zone.lock() { *g = report.manifest.zone.clone(); }
    // fresh Spotify client so restored tokens are picked up
    if report.secrets_restored > 0 { if let Ok(c) = crate::spotify::client::SpotifyClient::new() { state.spotify.replace(c); } }
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "restore" }));
    Ok(report)
}

fn uuid_v4() -> String {
    // Small dependency-free v4: random bytes from the OS via getrandom-less approach.
    let mut bytes = [0u8; 16];
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut x = nanos as u64 ^ 0x9E37_79B9_7F4A_7C15;
    for chunk in bytes.chunks_mut(8) {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        for (i, b) in chunk.iter_mut().enumerate() {
            *b = (x >> (i * 8)) as u8;
        }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h: Vec<String> = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}{}{}{}-{}{}-{}{}-{}{}-{}{}{}{}{}{}", h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8], h[9], h[10], h[11], h[12], h[13], h[14], h[15])
}

// ---------------------------------------------------------------------------
// Phase 2 — services
// ---------------------------------------------------------------------------
use crate::connectors::{lastfm, musicbrainz};
use crate::secrets;
use crate::spotify::{auth, sync};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorRow {
    pub service: String,
    pub status: String,
    pub account: Option<String>,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    pub plays_added: i64,
    pub extra: serde_json::Value,
}

#[tauri::command]
pub fn get_connectors(state: State<'_, AppState>) -> CmdResult<Vec<ConnectorRow>> {
    let rows = state.real.query("SELECT service, status, account, CAST(last_sync_at AS VARCHAR) AS last_sync_at, last_error, plays_added, CAST(detail AS VARCHAR) AS detail FROM connector_state ORDER BY service", &[]).map_err(err)?;
    let has_client = secrets::get(secrets::SPOTIFY_CLIENT_ID).ok().flatten().map(|s| !s.is_empty()).unwrap_or(false);
    let enriched = state.real.query("SELECT COUNT(*) FILTER (WHERE enriched_at IS NOT NULL) AS e, COUNT(*) AS n FROM tracks WHERE track_id NOT LIKE 'local:%'", &[]).map_err(err)?;
    let tags = state.real.query("SELECT source, COUNT(DISTINCT artist_id) AS artists FROM artist_tags GROUP BY 1", &[]).map_err(err)?;
    let mbids = state.real.scalar_i64("SELECT COUNT(*) FROM artists WHERE mbid IS NOT NULL").map_err(err)?;
    let liked = state.real.scalar_i64("SELECT COUNT(*) FROM liked_songs").map_err(err)?;
    let tag_of = |src: &str| tags.iter().find(|r| r.get("source").and_then(|v| v.as_str()) == Some(src)).and_then(|r| r.get("artists")).and_then(|v| v.as_i64()).unwrap_or(0);
    // Phase 8 — Heard in the Wild card facts
    let has_lastfm_key = secrets::get(secrets::LASTFM_KEY).ok().flatten().map(|s| !s.is_empty()).unwrap_or(false);
    let wild_meta = state.real.query("SELECT key, value FROM app_meta WHERE key IN ('wild_since', 'wild_lastfm_user')", &[]).map_err(err)?;
    let wild_count = state.real.scalar_i64("SELECT COUNT(*) FROM wild_plays").map_err(err)?;
    let wild_songs = state.real.scalar_i64("SELECT COUNT(DISTINCT track_key || '|' || artist_key) FROM wild_plays").map_err(err)?;
    let wild_new = state.real.scalar_i64("SELECT COUNT(DISTINCT w.track_key || '|' || w.artist_key) FROM wild_plays w WHERE NOT EXISTS (SELECT 1 FROM plays_resolved p WHERE lower(trim(p.artist_name)) = w.artist_key AND lower(trim(regexp_replace(regexp_replace(p.track_name, '\\s*[\\(\\[].*$', ''), '\\s+-\\s+.*$', ''))) = w.track_key)").map_err(err)?;
    Ok(rows.into_iter().map(|r| {
        let g = |k: &str| r.get(k).and_then(|v| v.as_str().map(str::to_string));
        let service = g("service").unwrap_or_default();
        let extra = match service.as_str() {
            "spotify" => serde_json::json!({ "hasClientId": has_client, "connected": state.spotify.is_connected(), "paused": state.spotify.is_paused(),
                // Phase 9b: queueing needs a scope older consents lack; the Services card asks for a one-time reconnect when this is false.
                "canQueue": state.spotify_ref().has_scope(crate::spotify::endpoints::SCOPE_QUEUE),
                "callsLastHour": state.spotify_ref().calls_last_hour(&state.real), "enrichPerHour": crate::spotify::endpoints::budget::enrich_per_hour(&state.real),
                "enrichedTracks": enriched.first().and_then(|x| x.get("e")).and_then(|v| v.as_i64()).unwrap_or(0), "totalTracks": enriched.first().and_then(|x| x.get("n")).and_then(|v| v.as_i64()).unwrap_or(0), "likedSongs": liked }),
            "freqblog" => serde_json::json!({ "featuredTracks": state.real.scalar_i64("SELECT COUNT(*) FROM track_features WHERE found").unwrap_or(0), "missedTracks": state.real.scalar_i64("SELECT COUNT(*) FROM track_features WHERE NOT found").unwrap_or(0), "playedTracks": state.real.scalar_i64("SELECT COUNT(DISTINCT track_id) FROM plays_resolved WHERE attended AND track_id IS NOT NULL").unwrap_or(0), "requestsThisMonth": crate::connectors::freqblog::used_this_month(&state.real), "monthlyCap": crate::connectors::freqblog::MONTHLY_CAP, "remaining": crate::connectors::freqblog::remaining(&state.real) }),
            "lastfm" => serde_json::json!({ "taggedArtists": tag_of("lastfm"), "popularityArtists": state.real.scalar_i64("SELECT COUNT(*) FROM artist_popularity").unwrap_or(0) }),
            "musicbrainz" => serde_json::json!({ "taggedArtists": tag_of("musicbrainz"), "resolvedArtists": mbids, "catalogueArtists": state.real.scalar_i64("SELECT COUNT(*) FROM artists WHERE catalogue_tracks IS NOT NULL").unwrap_or(0), "creditedTracks": state.real.scalar_i64("SELECT COUNT(DISTINCT track_id) FROM track_credits").unwrap_or(0) }),
            "lastfm_wild" => {
                let d = r.get("detail").and_then(|v| v.as_str()).and_then(|x| serde_json::from_str::<serde_json::Value>(x).ok()).unwrap_or(serde_json::json!({}));
                let since = wild_meta.iter().find(|m| m.get("key").and_then(|v| v.as_str()) == Some("wild_since")).and_then(|m| m.get("value")).and_then(|v| v.as_str()).and_then(|v| v.parse::<i64>().ok())
                    .and_then(|u| chrono::DateTime::<chrono::Utc>::from_timestamp(u, 0)).map(|d| d.format("%Y-%m-%d").to_string());
                serde_json::json!({ "lastfmConnected": has_lastfm_key, "dropped": d["dropped"].as_i64().unwrap_or(0), "backfillDone": d["backfillDone"].as_bool().unwrap_or(false),
                    "since": since, "captures": wild_count, "neverStreamed": wild_new, "account": wild_meta.iter().find(|m| m.get("key").and_then(|v| v.as_str()) == Some("wild_lastfm_user")).and_then(|m| m.get("value")).cloned(),
                    // Phase 9 guard: captures that match songs already in the record. A high share means the phone is still scrobbling Spotify.
                    "matchedSongs": wild_songs - wild_new, "songs": wild_songs })
            }
            _ => serde_json::json!({}),
        };
        ConnectorRow { service, status: g("status").unwrap_or_default(), account: g("account"), last_sync_at: g("last_sync_at"), last_error: g("last_error"),
            plays_added: r.get("plays_added").and_then(|v| v.as_i64()).unwrap_or(0), extra }
    }).collect())
}

#[tauri::command]
pub fn spotify_set_client_id(client_id: String) -> CmdResult<()> {
    let c = client_id.trim();
    if c.len() != 32 || !c.chars().all(|ch| ch.is_ascii_hexdigit()) { return Err("A Spotify client ID is 32 hex characters — copy it from the app's page on developer.spotify.com".into()); }
    secrets::set(secrets::SPOTIFY_CLIENT_ID, c).map_err(err)
}

/// API-01: opens the browser, waits for the loopback redirect, stores tokens.
#[tauri::command]
pub async fn spotify_connect(state: State<'_, AppState>, app: AppHandle) -> CmdResult<String> {
    let client_id = secrets::get(secrets::SPOTIFY_CLIENT_ID).map_err(err)?.filter(|s| !s.is_empty()).ok_or("Add your Spotify client ID first")?;
    let real = state.real.clone();
    let a = app.clone();
    let tokens = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_opener::OpenerExt;
        auth::login(&client_id, &|url| a.opener().open_url(url, None::<&str>).map_err(|e| anyhow::anyhow!("{e}")))
    }).await.map_err(err)?.map_err(err)?;
    // rebuild the client so it picks up the client id + tokens
    let fresh = crate::spotify::client::SpotifyClient::new().map_err(err)?;
    fresh.set_tokens(Some(tokens));
    let name = {
        let (id, display) = sync::whoami(&fresh, &real).map_err(err)?;
        crate::connectors::set_state(&real, "spotify", "connected", Some(&display), None);
        real.log_activity("spotify", "info", &format!("Connected as {display} ({id})"), None);
        display
    };
    state.spotify.replace(fresh);
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "spotify_connected" }));
    Ok(name)
}

#[tauri::command]
pub fn spotify_disconnect(state: State<'_, AppState>) -> CmdResult<()> {
    auth::clear_tokens().map_err(err)?;
    state.spotify.set_tokens(None);
    crate::connectors::set_state(&state.real, "spotify", "disconnected", None, None);
    Ok(())
}

/// One-click "Sync now" per service (CON: per-service cards).
#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>, app: AppHandle, service: String) -> CmdResult<String> {
    let real = state.real.clone();
    let client = state.spotify_ref();
    let msg = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<String> {
        Ok(match service.as_str() {
            "spotify" => {
                let added = sync::poll_recent(&client, &real)?;
                let liked = sync::sync_liked(&client, &real)?;
                let (me, _) = sync::whoami(&client, &real)?;
                // Phase 9f: a playlist failure must not cost the enrichment step (or the message); it is logged and reported.
                let pls = match sync::sync_playlists_detailed(&client, &real, &me) { Ok((seen, items)) => format!("{seen} playlists ({items} refreshed)"), Err(e) => { real.log_activity("sync", "warn", &format!("Playlist sync: {e}"), None); format!("playlists failed: {e}") } };
                let enriched = sync::enrich_batch(&client, &real)?;
                format!("Spotify: +{added} plays, {liked} liked songs, {pls}, {enriched} tracks enriched")
            }
            "lastfm" => { let t = lastfm::enrich_tags(&real, 60)?; let s = lastfm::enrich_similar(&real, 15)?; let l = lastfm::enrich_popularity(&real, 30)?; let al = lastfm::enrich_album_popularity(&real, 30)?; format!("Last.fm: tagged {t} artists, {s} similar-artist seeds, listener counts for {l} artists and {al} albums") }
            "musicbrainz" => { let n = musicbrainz::resolve_batch(&real, 40)?; let r = musicbrainz::enrich_relations(&real, 15)?; let c = musicbrainz::enrich_catalogue(&real, 15)?; let k = musicbrainz::enrich_credits(&real, 20)?; format!("MusicBrainz: resolved {n} artists, relationships for {r}, catalogue sizes for {c}, credits for {k} tracks") }
            "statsfm" => { let n = crate::connectors::statsfm::import(&real, 10)?; format!("stats.fm: +{n} plays") }
            "freqblog" => { let n = crate::connectors::freqblog::enrich(&real, 50)?; format!("FreqBlog: audio features for {n} tracks ({} requests used this month)", crate::connectors::freqblog::used_this_month(&real)) }
            "listenbrainz" => { let n = crate::connectors::listenbrainz::enrich_similar(&real, 20)?; format!("ListenBrainz: similar artists for {n} seeds") }
            "lastfm_wild" => { let n = crate::connectors::lastfm_wild::import(&real, 10)?; format!("Heard in the Wild: +{n} captures") }
            other => anyhow::bail!("{other} isn't connectable yet"),
        })
    }).await.map_err(err)?.map_err(err)?;
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "sync" }));
    Ok(msg)
}

#[tauri::command]
pub async fn lastfm_connect(state: State<'_, AppState>, api_key: String, username: String) -> CmdResult<String> {
    let real = state.real.clone();
    tauri::async_runtime::spawn_blocking(move || lastfm::connect(&real, api_key.trim(), username.trim())).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub fn lastfm_disconnect(state: State<'_, AppState>) -> CmdResult<()> { lastfm::disconnect(&state.real).map_err(err) }

#[tauri::command]
pub async fn musicbrainz_connect(state: State<'_, AppState>) -> CmdResult<()> {
    let real = state.real.clone();
    tauri::async_runtime::spawn_blocking(move || musicbrainz::connect(&real)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub fn musicbrainz_disconnect(state: State<'_, AppState>) -> CmdResult<()> {
    crate::connectors::set_state(&state.real, "musicbrainz", "disconnected", None, None);
    Ok(())
}

#[tauri::command]
pub async fn statsfm_connect(state: State<'_, AppState>, api_key: String) -> CmdResult<String> {
    let real = state.real.clone();
    tauri::async_runtime::spawn_blocking(move || crate::connectors::statsfm::connect(&real, api_key.trim())).await.map_err(err)?.map_err(err)
}
#[tauri::command]
pub fn statsfm_disconnect(state: State<'_, AppState>) -> CmdResult<()> { crate::connectors::statsfm::disconnect(&state.real).map_err(err) }

/// Phase 9g — FreqBlog audio features.
#[tauri::command]
pub async fn freqblog_connect(state: State<'_, AppState>, api_key: String) -> CmdResult<String> {
    let real = state.real.clone();
    tauri::async_runtime::spawn_blocking(move || crate::connectors::freqblog::connect(&real, api_key.trim())).await.map_err(err)?.map_err(err)
}
#[tauri::command]
pub fn freqblog_disconnect(state: State<'_, AppState>) -> CmdResult<()> { crate::connectors::freqblog::disconnect(&state.real).map_err(err) }

/// Phase 8 — Heard in the Wild: reuse the Last.fm key; `username` may be blank (= Last.fm connector's user); `since` = YYYY-MM-DD or blank (= now).
#[tauri::command]
pub async fn lastfm_wild_connect(state: State<'_, AppState>, app: AppHandle, username: Option<String>, since: Option<String>) -> CmdResult<String> {
    let real = state.real.clone();
    let name = tauri::async_runtime::spawn_blocking(move || crate::connectors::lastfm_wild::connect(&real, username.as_deref().unwrap_or(""), since.as_deref().unwrap_or(""))).await.map_err(err)?.map_err(err)?;
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "wild_connected" }));
    Ok(name)
}
#[tauri::command]
pub fn lastfm_wild_disconnect(state: State<'_, AppState>) -> CmdResult<()> { crate::connectors::lastfm_wild::disconnect(&state.real).map_err(err) }
/// Phase 9: purge every capture and re-point at a Pano-only Last.fm account. Returns {purged, account}.
#[tauri::command]
pub async fn lastfm_wild_reset(state: State<'_, AppState>, app: AppHandle, username: Option<String>, since: Option<String>) -> CmdResult<serde_json::Value> {
    let real = state.real.clone();
    let (purged, name) = tauri::async_runtime::spawn_blocking(move || crate::connectors::lastfm_wild::reset_and_repoint(&real, username.as_deref().unwrap_or(""), since.as_deref().unwrap_or(""))).await.map_err(err)?.map_err(err)?;
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "wild_reset" }));
    Ok(serde_json::json!({ "purged": purged, "account": name }))
}

/// DIS-03: the feedback loop. Verdict 'accepted' | 'dismissed'.
#[tauri::command]
pub fn rec_feedback(state: State<'_, AppState>, subject_type: String, subject_key: String, engine: String, verdict: String) -> CmdResult<()> {
    if !["accepted", "dismissed"].contains(&verdict.as_str()) { return Err("verdict must be accepted or dismissed".into()); }
    state.real.exec("INSERT INTO recommendation_feedback (subject_type, subject_key, engine, verdict) VALUES (?, ?, ?, ?)",
        &[serde_json::json!(subject_type), serde_json::json!(subject_key), serde_json::json!(engine), serde_json::json!(verdict)]).map_err(err)?;
    Ok(())
}

/// PLY-10: any list → a Spotify playlist. Private unless `public` is set.
#[tauri::command]
pub async fn create_playlist(state: State<'_, AppState>, playlist: crate::playlists::NewPlaylist) -> CmdResult<crate::playlists::CreatedPlaylist> {
    let real = state.real.clone(); let client = state.spotify_ref();
    tauri::async_runtime::spawn_blocking(move || crate::playlists::create(&client, &real, &playlist)).await.map_err(err)?.map_err(err)
}

/// Phase 9e: is Ollama reachable, and which models does it have?
#[tauri::command]
pub async fn llm_status(state: State<'_, AppState>) -> CmdResult<crate::llm::LlmStatus> {
    let real = state.real.clone();
    tauri::async_runtime::spawn_blocking(move || crate::llm::status(&real)).await.map_err(err)
}

/// Phase 9e: one chat completion against the local model. The frontend owns the prompts; SQL the model writes goes back through `query`.
#[tauri::command]
pub async fn llm_chat(state: State<'_, AppState>, model: String, messages: Vec<crate::llm::ChatMsg>, json_mode: Option<bool>, temperature: Option<f32>) -> CmdResult<String> {
    let real = state.real.clone();
    tauri::async_runtime::spawn_blocking(move || crate::llm::chat(&real, &model, &messages, json_mode.unwrap_or(false), temperature.unwrap_or(0.2))).await.map_err(err)?.map_err(err)
}

/// Phase 9e: file an artist under a scene family for The Crate / Scenes (NULL = unsorted). Applied now and kept across rebuilds via scene_overrides.
#[tauri::command]
pub fn set_artist_scene(state: State<'_, AppState>, artist_id: String, scene: Option<String>) -> CmdResult<()> {
    let db = &state.real;
    db.exec("INSERT INTO scene_overrides (artist_id, scene, decided_at) VALUES (?, ?, now()) ON CONFLICT (artist_id) DO UPDATE SET scene = excluded.scene, decided_at = now()", &[serde_json::json!(artist_id), serde_json::json!(scene)]).map_err(err)?;
    db.exec("DELETE FROM artist_scene WHERE artist_id = ?", &[serde_json::json!(artist_id)]).map_err(err)?;
    if let Some(sc) = scene { db.exec("INSERT INTO artist_scene VALUES (?, ?, 9.0)", &[serde_json::json!(artist_id), serde_json::json!(sc)]).map_err(err)?; }
    Ok(())
}

// ---- Phase 9i: view and correct metadata from the Artist / Album / Song pages (src/components/MetadataPanel.tsx)
const META_FIELDS: &[(&str, &str)] = &[("artist", "image_url"), ("album", "release_date"), ("album", "image_url"), ("track", "isrc"), ("track", "release_date")];

/// Set (or with value = None, clear) one owner correction and apply it right away; the rebuild re-applies it forever after.
#[tauri::command]
pub fn meta_set(state: State<'_, AppState>, entity_type: String, entity_id: String, field: String, value: Option<String>) -> CmdResult<()> {
    if !META_FIELDS.iter().any(|(t, f)| *t == entity_type && *f == field) { return Err(format!("{entity_type}.{field} can't be edited")); }
    let db = &state.real;
    let v = value.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if field == "release_date" { if let Some(d) = &v { if chrono::NaiveDate::parse_from_str(if d.len() == 4 { format!("{d}-01-01") } else { d.clone() }.as_str(), "%Y-%m-%d").is_err() { return Err("Use a year (1972) or a date (1972-03-01)".into()); } } }
    let v = v.map(|d| if field == "release_date" && d.len() == 4 { format!("{d}-01-01") } else if field == "isrc" { d.replace('-', "").to_uppercase() } else { d });
    match &v {
        Some(val) => db.exec("INSERT INTO metadata_overrides (entity_type, entity_id, field, value) VALUES (?, ?, ?, ?) ON CONFLICT (entity_type, entity_id, field) DO UPDATE SET value = excluded.value, updated_at = now()", &[serde_json::json!(entity_type), serde_json::json!(entity_id), serde_json::json!(field), serde_json::json!(val)]).map_err(err)?,
        None => db.exec("DELETE FROM metadata_overrides WHERE entity_type = ? AND entity_id = ? AND field = ?", &[serde_json::json!(entity_type), serde_json::json!(entity_id), serde_json::json!(field)]).map_err(err)?,
    };
    // apply now (table names and columns come from the whitelist above, never from input)
    let (table, key) = match entity_type.as_str() { "artist" => ("artists", "artist_id"), "album" => ("albums", "album_id"), _ => ("tracks", "track_id") };
    if let Some(val) = &v {
        let cast = if field == "release_date" { "TRY_CAST(? AS DATE)" } else { "?" };
        db.exec(&format!("UPDATE {table} SET {field} = {cast} WHERE {key} = ?"), &[serde_json::json!(val), serde_json::json!(entity_id)]).map_err(err)?;
    }
    // a corrected ISRC invalidates what was looked up through the old one
    if field == "isrc" {
        for sql in ["DELETE FROM track_features WHERE track_id = ?", "DELETE FROM track_credits WHERE track_id = ?"] { let _ = db.exec(sql, &[serde_json::json!(entity_id)]); }
    }
    db.log_activity("metadata", "info", &format!("You corrected {entity_type} {field}"), Some(&entity_id));
    Ok(())
}

/// Correct where an artist is from (kept as source = 'owner'; enrichment never overwrites it). All None = back to automatic.
#[tauri::command]
pub fn artist_set_origin(state: State<'_, AppState>, artist_id: String, country: Option<String>, city: Option<String>, formed_year: Option<i64>) -> CmdResult<()> {
    let db = &state.real;
    let cc = country.map(|c| c.trim().to_uppercase()).filter(|c| !c.is_empty());
    if let Some(c) = &cc { if c.len() != 2 || !c.chars().all(|x| x.is_ascii_uppercase()) { return Err("Country must be a two-letter code (US, GB, TR…)".into()); } }
    if cc.is_none() && city.as_deref().map(str::trim).unwrap_or("").is_empty() && formed_year.is_none() {
        db.exec("DELETE FROM artist_origin WHERE artist_id = ? AND source = 'owner'", &[serde_json::json!(artist_id)]).map_err(err)?;   // re-fetched automatically on the next tick
        return Ok(());
    }
    db.exec("INSERT INTO artist_origin (artist_id, country, country_name, city, formed_year, source) VALUES (?, ?, NULL, ?, ?, 'owner')
             ON CONFLICT (artist_id) DO UPDATE SET country = excluded.country, country_name = NULL, city = excluded.city, formed_year = excluded.formed_year, source = 'owner', fetched_at = now()",
        &[serde_json::json!(artist_id), serde_json::json!(cc), serde_json::json!(city.map(|c| c.trim().to_string()).filter(|c| !c.is_empty())), serde_json::json!(formed_year)]).map_err(err)?;
    db.log_activity("metadata", "info", "You corrected an artist's origin", Some(&artist_id));
    Ok(())
}

#[tauri::command]
pub async fn artist_mb_candidates(state: State<'_, AppState>, artist_id: String) -> CmdResult<Vec<serde_json::Value>> {
    let real = state.real.clone();
    tauri::async_runtime::spawn_blocking(move || crate::connectors::musicbrainz::candidates(&real, &artist_id)).await.map_err(err)?.map_err(err)
}

/// Pick the right MusicBrainz artist (id or pasted URL). Origin, tags and relations from the old id are discarded and re-fetched.
#[tauri::command]
pub async fn artist_set_mbid(state: State<'_, AppState>, app: AppHandle, artist_id: String, mbid: String) -> CmdResult<()> {
    let real = state.real.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        crate::connectors::musicbrainz::set_owner_mbid(&real, &artist_id, &mbid)?;
        real.exec_batch(crate::db::COMPUTE_SCENES_SQL)?;   // re-file the artist under its real tags
        Ok(())
    }).await.map_err(err)?.map_err(err)?;
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "metadata" }));
    Ok(())
}

/// Phase 9g: log today's forecast once (summary §3.2). Idempotent: a second call for the same date is a no-op,
/// so the accuracy line is never rewritten after the fact.
#[tauri::command]
pub fn forecast_log_write(state: State<'_, AppState>, date: String, weekday: i64, payload: String) -> CmdResult<bool> {
    if date.len() != 10 || !date.chars().all(|c| c.is_ascii_digit() || c == '-') { return Err("date must be YYYY-MM-DD".into()); }
    let before = state.real.scalar_i64("SELECT COUNT(*) FROM forecast_log").map_err(err)?;
    state.real.exec("INSERT INTO forecast_log (forecast_date, weekday, payload) VALUES (CAST(? AS DATE), ?, CAST(? AS JSON)) ON CONFLICT (forecast_date) DO NOTHING", &[serde_json::json!(date), serde_json::json!(weekday), serde_json::json!(payload)]).map_err(err)?;
    let after = state.real.scalar_i64("SELECT COUNT(*) FROM forecast_log").map_err(err)?;
    Ok(after > before)
}

/// Phase 9f: progress of the lyric v2 re-analysis, for the Settings card.
#[tauri::command]
pub fn lyrics_status(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    let (old, current, never) = crate::connectors::lyrics::pending(&state.real);
    let llm = state.real.query("SELECT value FROM app_meta WHERE key = 'lyrics_llm_enabled'", &[]).ok().and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str().map(|s| s == "true"))).unwrap_or(false);
    Ok(serde_json::json!({ "oldRules": old, "current": current, "never": never, "llmEnabled": llm }))
}

// ---- Phase 9f: the scene vocabulary as data (mirrors dev-server.mjs). See src/lib/sceneQueries.ts.
fn valid_scene_key(k: &str) -> bool { !k.is_empty() && k.len() <= 40 && k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') }

#[tauri::command]
pub fn scene_family_upsert(state: State<'_, AppState>, scene: String, label: String, kind: String, blurb: Option<String>, hidden: Option<bool>) -> CmdResult<()> {
    if !valid_scene_key(&scene) { return Err("scene key must be lowercase letters, digits and hyphens".into()); }
    let kind = if kind == "region" { "region" } else { "style" };
    state.real.exec("INSERT INTO scene_families (scene, label, kind, blurb, builtin, hidden) VALUES (?, ?, ?, ?, FALSE, ?) \
                     ON CONFLICT (scene) DO UPDATE SET label = excluded.label, kind = excluded.kind, blurb = excluded.blurb, hidden = excluded.hidden",
        &[serde_json::json!(scene), serde_json::json!(label), serde_json::json!(kind), serde_json::json!(blurb), serde_json::json!(hidden.unwrap_or(false))]).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn scene_family_delete(state: State<'_, AppState>, scene: String) -> CmdResult<()> {
    let db = &state.real;
    let builtin = db.query("SELECT builtin FROM scene_families WHERE scene = ?", &[serde_json::json!(scene)]).map_err(err)?.first().and_then(|r| r.get("builtin")).and_then(|v| v.as_bool());
    match builtin { None => return Ok(()), Some(true) => return Err("Built-in families can be hidden, not deleted.".into()), Some(false) => {} }
    for sql in ["DELETE FROM scene_tag_map WHERE scene = ?", "DELETE FROM scene_origin_map WHERE scene = ?", "DELETE FROM scene_overrides WHERE scene = ?", "DELETE FROM artist_scene WHERE scene = ?", "DELETE FROM scene_families WHERE scene = ?"] {
        db.exec(sql, &[serde_json::json!(scene)]).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn scene_tag_set(state: State<'_, AppState>, tag: String, scene: Option<String>) -> CmdResult<()> {
    let tag = tag.trim().to_lowercase();
    if tag.is_empty() { return Err("tag required".into()); }
    match scene {
        None => state.real.exec("DELETE FROM scene_tag_map WHERE tag = ?", &[serde_json::json!(tag)]).map_err(err)?,
        Some(sc) => state.real.exec("INSERT INTO scene_tag_map (tag, scene, builtin) VALUES (?, ?, FALSE) ON CONFLICT (tag) DO UPDATE SET scene = excluded.scene, builtin = FALSE", &[serde_json::json!(tag), serde_json::json!(sc)]).map_err(err)?,
    };
    Ok(())
}

#[tauri::command]
pub fn scene_origin_set(state: State<'_, AppState>, country: String, scene: Option<String>) -> CmdResult<()> {
    let country = country.trim().to_uppercase();
    if country.len() != 2 || !country.chars().all(|c| c.is_ascii_uppercase()) { return Err("country must be an ISO alpha-2 code".into()); }
    match scene {
        None => state.real.exec("DELETE FROM scene_origin_map WHERE country = ?", &[serde_json::json!(country)]).map_err(err)?,
        Some(sc) => state.real.exec("INSERT INTO scene_origin_map (country, scene, builtin) VALUES (?, ?, FALSE) ON CONFLICT (country) DO UPDATE SET scene = excluded.scene, builtin = FALSE", &[serde_json::json!(country), serde_json::json!(sc)]).map_err(err)?,
    };
    Ok(())
}

/// Re-run compute_scenes.sql now so the Crate / Scenes follow a vocabulary edit without the nightly rebuild.
#[tauri::command]
pub async fn recompute_scenes(state: State<'_, AppState>, app: AppHandle) -> CmdResult<serde_json::Value> {
    let real = state.real.clone();
    let out = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        real.exec_batch(crate::db::COMPUTE_SCENES_SQL)?;
        let artists = real.scalar_i64("SELECT COUNT(DISTINCT artist_id) FROM artist_scene")?;
        let families = real.scalar_i64("SELECT COUNT(DISTINCT scene) FROM artist_scene")?;
        real.log_activity("scenes", "info", &format!("Re-filed {artists} artists across {families} scene families"), None);
        Ok(serde_json::json!({ "artists": artists, "families": families }))
    }).await.map_err(err)?.map_err(err)?;
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "scenes" }));
    Ok(out)
}

/// Phase 9b: drop one track on the end of the active Spotify queue. Returns an outcome, not an error, so the UI can branch (no device / needs reconnect).
#[tauri::command]
pub async fn queue_track(state: State<'_, AppState>, track_id: String) -> CmdResult<crate::spotify::queue::QueueOutcome> {
    let real = state.real.clone(); let client = state.spotify_ref();
    tauri::async_runtime::spawn_blocking(move || crate::spotify::queue::queue_track(&client, &real, &track_id)).await.map_err(err)
}

/// DIS-02: add a recommendation (by Spotify search) or explicit track ids to the Radar playlist.
#[tauri::command]
pub async fn add_to_radar(state: State<'_, AppState>, track_ids: Option<Vec<String>>, search: Option<String>) -> CmdResult<crate::playlists::CreatedPlaylist> {
    let real = state.real.clone(); let client = state.spotify_ref();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<crate::playlists::CreatedPlaylist> {
        let ids = match (track_ids, search) {
            (Some(ids), _) if !ids.is_empty() => ids,
            (_, Some(q)) => crate::playlists::search_track_ids(&client, &real, &q, 3)?,
            _ => anyhow::bail!("Nothing to add"),
        };
        crate::playlists::add_to_radar(&client, &real, &ids)
    }).await.map_err(err)?.map_err(err)
}

/// INS-12 export: the UI renders the HTML; we only write it where the user chose.
#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> CmdResult<()> {
    std::fs::write(&path, contents).map_err(|e| format!("Couldn't write {path}: {e}"))
}

/// Phase 4 blend: import a friend's export into blend_plays (aggregated; never mixed into your record).
#[tauri::command]
pub async fn import_blend(state: State<'_, AppState>, app: AppHandle, path: String, label: String) -> CmdResult<i64> {
    let real = state.real.clone(); let p = PathBuf::from(path); let l = if label.trim().is_empty() { "Friend".to_string() } else { label.trim().to_string() };
    let n = tauri::async_runtime::spawn_blocking(move || importer::import_blend(&real, &p, &l)).await.map_err(err)?.map_err(err)?;
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "blend" }));
    Ok(n)
}
#[tauri::command]
pub fn clear_blend(state: State<'_, AppState>) -> CmdResult<()> { state.real.exec("DELETE FROM blend_plays", &[]).map(|_| ()).map_err(err) }

/// Lyric features on demand (also runs in the background trickle).
#[tauri::command]
pub async fn lyrics_enrich_now(state: State<'_, AppState>) -> CmdResult<String> {
    let real = state.real.clone();
    let n = tauri::async_runtime::spawn_blocking(move || crate::connectors::lyrics::enrich_batch(&real, 60)).await.map_err(err)?.map_err(err)?;
    Ok(format!("Lyric features for {n} tracks"))
}

#[tauri::command]
pub fn save_binary_file(path: String, base64: String) -> CmdResult<()> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64.as_bytes()).map_err(|e| format!("bad image data: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Couldn't write {path}: {e}"))
}

/// Phase 5 data hygiene: fold one artist id into another, then rebuild.
#[tauri::command]
pub async fn merge_artists(state: State<'_, AppState>, app: AppHandle, from_id: String, into_id: String) -> CmdResult<()> {
    if from_id == into_id { return Err("Pick two different artists".into()); }
    let real = state.real.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        real.exec("INSERT INTO artist_merges (from_artist_id, into_artist_id) VALUES (?, ?) ON CONFLICT (from_artist_id) DO UPDATE SET into_artist_id = excluded.into_artist_id", &[serde_json::json!(from_id), serde_json::json!(into_id)])?;
        real.rebuild_all()?;
        real.log_activity("merge", "info", "Merged artists and rebuilt", None);
        Ok(())
    }).await.map_err(err)?.map_err(err)?;
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "merge" }));
    Ok(())
}
#[tauri::command]
pub async fn unmerge_artist(state: State<'_, AppState>, app: AppHandle, from_id: String) -> CmdResult<()> {
    let real = state.real.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        real.exec("DELETE FROM artist_merges WHERE from_artist_id = ?", &[serde_json::json!(from_id)])?;
        real.rebuild_all()?;
        Ok(())
    }).await.map_err(err)?.map_err(err)?;
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "merge" }));
    Ok(())
}
#[tauri::command]
pub fn list_merges(state: State<'_, AppState>) -> CmdResult<Vec<db::Row>> {
    state.real.query("SELECT m.from_artist_id AS \"fromId\", m.into_artist_id AS \"intoId\", a.name AS \"intoName\", al.alias_name AS \"fromName\" FROM artist_merges m LEFT JOIN artists a ON a.artist_id = m.into_artist_id LEFT JOIN artist_aliases al ON al.artist_id = m.into_artist_id AND lower(al.alias_name) = substr(m.from_artist_id, 6) ORDER BY m.created_at DESC", &[]).map_err(err)
}

#[tauri::command]
pub async fn listenbrainz_connect(state: State<'_, AppState>) -> CmdResult<()> {
    let real = state.real.clone();
    tauri::async_runtime::spawn_blocking(move || crate::connectors::listenbrainz::connect(&real)).await.map_err(err)?.map_err(err)
}
#[tauri::command]
pub fn listenbrainz_disconnect(state: State<'_, AppState>) -> CmdResult<()> { crate::connectors::listenbrainz::disconnect(&state.real).map_err(err) }

/// Travel: manual zone overrides; reloads offsets and rebuilds.
#[tauri::command]
pub async fn set_tz_override(state: State<'_, AppState>, app: AppHandle, from_date: String, to_date: String, zone: String, note: Option<String>, remove_id: Option<String>) -> CmdResult<()> {
    if remove_id.is_none() && zone.parse::<chrono_tz::Tz>().is_err() { return Err(format!("Unknown time zone: {zone}")); }
    let real = state.real.clone(); let home = state.real.zone.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        if let Some(id) = remove_id { real.exec("DELETE FROM tz_overrides WHERE CAST(id AS VARCHAR) = ?", &[serde_json::json!(id)])?; }
        else { real.exec("INSERT INTO tz_overrides (from_date, to_date, zone, note) VALUES (CAST(? AS DATE), CAST(? AS DATE), ?, ?)", &[serde_json::json!(from_date), serde_json::json!(to_date), serde_json::json!(zone), serde_json::json!(note)])?; }
        let saved = real.query("SELECT value FROM app_meta WHERE key = 'timezone'", &[])?.first().and_then(|r| r.get("value")).and_then(|v| v.as_str().map(str::to_string)).unwrap_or(home);
        real.load_tz_offsets(&saved)?;
        real.rebuild_all()?;
        Ok(())
    }).await.map_err(err)?.map_err(err)?;
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "timezone" }));
    Ok(())
}

/// Session hygiene: mark a session unattended / active by its local start time.
#[tauri::command]
pub async fn set_session_attention(state: State<'_, AppState>, app: AppHandle, start_at: String, attention: Option<String>) -> CmdResult<()> {
    let real = state.real.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        match attention {
            Some(a) if a == "unattended" || a == "active" => { real.exec("INSERT INTO session_overrides (start_at, attention) VALUES (CAST(? AS TIMESTAMP), ?) ON CONFLICT (start_at) DO UPDATE SET attention = excluded.attention", &[serde_json::json!(start_at), serde_json::json!(a)])?; }
            _ => { real.exec("DELETE FROM session_overrides WHERE start_at = CAST(? AS TIMESTAMP)", &[serde_json::json!(start_at)])?; }
        }
        real.rebuild_all()?;
        Ok(())
    }).await.map_err(err)?.map_err(err)?;
    events::emit(&app, events::DATA_CHANGED, serde_json::json!({ "reason": "session_override" }));
    Ok(())
}

/// Concerts (lite).
#[tauri::command]
pub fn set_concert(state: State<'_, AppState>, artist_id: String, on_date: String, venue: Option<String>, note: Option<String>, remove_id: Option<String>) -> CmdResult<()> {
    if let Some(id) = remove_id { return state.real.exec("DELETE FROM concerts WHERE CAST(id AS VARCHAR) = ?", &[serde_json::json!(id)]).map(|_| ()).map_err(err); }
    state.real.exec("INSERT INTO concerts (artist_id, on_date, venue, note) VALUES (?, CAST(? AS DATE), ?, ?)", &[serde_json::json!(artist_id), serde_json::json!(on_date), serde_json::json!(venue), serde_json::json!(note)]).map(|_| ()).map_err(err)
}

#[tauri::command]
pub fn mark_milestone_seen(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.real.exec("UPDATE milestones SET seen = TRUE WHERE CAST(milestone_id AS VARCHAR) = ?", &[serde_json::json!(id)]).map(|_| ()).map_err(err)
}
#[tauri::command]
pub fn mark_insight_surfaced(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.real.exec("UPDATE insights SET surfaced = TRUE WHERE CAST(insight_id AS VARCHAR) = ?", &[serde_json::json!(id)]).map(|_| ()).map_err(err)
}

/// Mixtape builder: for artists you don't own, fetch a few Spotify track ids by search (API-06 caps at 10).
#[tauri::command]
pub async fn spotify_tracks_for_artists(state: State<'_, AppState>, artists: Vec<String>, per_artist: Option<usize>) -> CmdResult<Vec<serde_json::Value>> {
    let real = state.real.clone(); let client = state.spotify_ref(); let n = per_artist.unwrap_or(2).clamp(1, 5);
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Vec<serde_json::Value>> {
        let mut out = Vec::new();
        for a in artists.iter().take(40) {
            let url = format!("{}/search?type=track&limit=10&q={}", crate::spotify::endpoints::API_BASE, urlencoding::encode(&format!("artist:{a}")));
            let Ok(v) = client.get(&real, &url, true) else { continue };
            for t in v["tracks"]["items"].as_array().cloned().unwrap_or_default().iter().filter(|t| t["artists"].get(0).and_then(|x| x["name"].as_str()).map(|nm| nm.eq_ignore_ascii_case(a)).unwrap_or(true)).take(n) {
                out.push(serde_json::json!({ "trackId": t["id"], "track": t["name"], "artist": t["artists"][0]["name"], "album": t["album"]["name"], "imageUrl": t["album"]["images"][0]["url"], "durationMs": t["duration_ms"] }));
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        Ok(out)
    }).await.map_err(err)?.map_err(err)
}
