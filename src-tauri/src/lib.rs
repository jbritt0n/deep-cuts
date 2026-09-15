//! Deep Cuts v3 — Tauri core. Rust stays thin: paths, DuckDB, import, events.
//! All analytics live in `sql/`; all UI logic lives in the React app.

mod commands;
mod connectors;
mod db;
mod events;
mod importer;
mod paths;
mod playlists;
mod scheduler;
mod secrets;
mod spotify;
mod tray;

mod llm; // Phase 9e — Ollama provider (spec §9.1)

use db::Db;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Bump when the SQL pipeline changes so existing records rebuild on first launch.
pub const PIPELINE_REV: &str = "9";

pub struct AppState {
    pub paths: paths::DataPaths,
    /// The owner's record. Always open; empty until the first import.
    pub real: Arc<Db>,
    /// Demo record (NFR-06) — used whenever `real` has no plays.
    pub demo: Arc<Db>,
    pub importing: AtomicBool,
    pub zone: Mutex<String>,
    /// Quota-aware Spotify client (behind a handle so a fresh login can swap it).
    pub spotify: SpotifyHandle,
}

/// Cheap handle so commands/scheduler can call the current client without
/// holding the slot lock across network calls.
#[derive(Clone)]
pub struct SpotifyHandle(Arc<Mutex<Option<Arc<spotify::client::SpotifyClient>>>>);

impl AppState {
    pub fn spotify_ref(&self) -> Arc<spotify::client::SpotifyClient> { self.spotify.current() }

    /// Real when it has plays, otherwise demo.
    pub fn active(&self) -> Arc<Db> {
        let n = self.real.scalar_i64("SELECT COUNT(*) FROM plays_resolved").unwrap_or(0);
        if n > 0 { self.real.clone() } else { self.demo.clone() }
    }
}

impl SpotifyHandle {
    pub fn current(&self) -> Arc<spotify::client::SpotifyClient> {
        let mut g = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if g.is_none() { *g = Some(Arc::new(spotify::client::SpotifyClient::new().expect("spotify client"))); }
        g.as_ref().unwrap().clone()
    }
    pub fn replace(&self, c: spotify::client::SpotifyClient) { *self.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(c)); }
    pub fn is_connected(&self) -> bool { self.current().is_connected() }
    pub fn is_paused(&self) -> bool { self.current().is_paused() }
    pub fn set_tokens(&self, t: Option<spotify::auth::Tokens>) { self.current().set_tokens(t) }
}

fn detect_zone() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string())
}

fn open_databases(paths: &paths::DataPaths) -> anyhow::Result<(Arc<Db>, Arc<Db>, String)> {
    let real = Db::open(&paths.db_path, &detect_zone())?;
    // A zone saved earlier wins over the OS zone.
    let saved = real
        .query("SELECT value FROM app_meta WHERE key = 'timezone'", &[])
        .ok()
        .and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str().map(str::to_string)));
    let zone = saved.unwrap_or_else(detect_zone);
    if zone != real.zone {
        real.load_tz_offsets(&zone)?;
    }
    let demo = Db::open(&paths.demo_db_path, &zone)?;
    if demo.scalar_i64("SELECT COUNT(*) FROM events")? == 0 {
        log::info!("seeding demo record");
        demo.exec_batch(db::DEMO_SEED_SQL)?;
        demo.exec_batch(db::ENTITY_RESOLUTION_SQL)?;
        demo.exec_batch(db::COMPUTE_SESSIONS_SQL)?;
        demo.checkpoint()?;
    }
    // Real record: make sure derived tables exist for whatever is in events
    // (e.g. schema upgraded, or a rebuild was interrupted).
    let events_n = real.scalar_i64("SELECT COUNT(*) FROM events")?;
    let resolved_n = real.scalar_i64("SELECT COUNT(*) FROM plays_resolved")?;
    let built_with = real.query("SELECT value FROM app_meta WHERE key = 'built_with'", &[])?.first().and_then(|r| r.get("value")).and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    let version = env!("CARGO_PKG_VERSION").to_string() + "+" + PIPELINE_REV;
    if events_n > 0 && (events_n != resolved_n || built_with != version) {
        log::info!("rebuilding derived tables ({events_n} events, {resolved_n} resolved, pipeline {built_with} → {version})");
        real.load_tz_offsets(&zone)?;
        real.rebuild_all()?;
        real.log_activity("upgrade", "info", &format!("Rebuilt the record for pipeline {version}"), None);
    }
    real.exec("INSERT INTO app_meta (key, value) VALUES ('built_with', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", &[serde_json::json!(version)])?;
    Ok((Arc::new(real), Arc::new(demo), zone))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: focus the existing window instead of opening another
            // (DuckDB is single-writer — two instances would fight over the file).
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = paths::resolve()?;
            log::info!("data dir: {} (portable: {})", paths.data_dir.display(), paths.portable);
            let (real, demo, zone) = open_databases(&paths)?;
            app.manage(AppState {
                paths,
                real,
                demo,
                importing: AtomicBool::new(false),
                zone: Mutex::new(zone),
                spotify: SpotifyHandle(Arc::new(Mutex::new(None))),
            });
            tray::setup(app.handle())?;
            scheduler::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::query,
            commands::inspect_import,
            commands::start_import,
            commands::rebuild,
            commands::get_activity,
            commands::get_import_history,
            commands::get_settings,
            commands::set_setting,
            commands::list_timezones,
            commands::set_timezone,
            commands::open_data_folder,
            commands::export_events,
            commands::get_connectors,
            commands::spotify_set_client_id,
            commands::spotify_connect,
            commands::spotify_disconnect,
            commands::sync_now,
            commands::lastfm_connect,
            commands::lastfm_disconnect,
            commands::musicbrainz_connect,
            commands::musicbrainz_disconnect,
            commands::statsfm_connect,
            commands::statsfm_disconnect,
            commands::rec_feedback,
            commands::create_playlist,
            commands::add_to_radar,
            commands::queue_track,
            commands::set_artist_scene,
            commands::llm_status,
            commands::llm_chat,
            commands::save_text_file,
            commands::import_blend,
            commands::clear_blend,
            commands::lyrics_enrich_now,
            commands::save_binary_file,
            commands::merge_artists,
            commands::unmerge_artist,
            commands::list_merges,
            commands::listenbrainz_connect,
            commands::listenbrainz_disconnect,
            commands::set_tz_override,
            commands::set_session_attention,
            commands::set_concert,
            commands::mark_milestone_seen,
            commands::mark_insight_surfaced,
            commands::spotify_tracks_for_artists,
            commands::lastfm_wild_connect,
            commands::lastfm_wild_disconnect,
            commands::lastfm_wild_reset,
        ])
        .on_window_event(|window, event| {
            // Close hides to the tray so the poller keeps running (ING-05). Quit from the tray menu.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Deep Cuts");
}
