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
mod migrate; // Phase 9f — move the whole record to another computer
mod stylus; // Phase 9m — ListenBrainz-compatible scrobble receiver

use anyhow::Context as _;
use db::Db;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Bump when the SQL pipeline changes so existing records rebuild on first launch.
pub const PIPELINE_REV: &str = "10";   // Phase 9f: scenes from tables, lyric v2 view, playlist sync columns

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

/// Move `path` and its `.wal` aside as `<name>.broken-<stamp>` (kept, never deleted, for diagnosis).
fn quarantine(path: &std::path::Path) {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    for p in [path.to_path_buf(), std::path::PathBuf::from(format!("{}.wal", path.display()))] {
        if p.exists() {
            let to = std::path::PathBuf::from(format!("{}.broken-{stamp}", p.display()));
            match std::fs::rename(&p, &to) { Ok(()) => log::warn!("moved {} → {}", p.display(), to.display()), Err(e) => log::error!("could not move {}: {e}", p.display()) }
        }
    }
}

fn detect_zone() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string())
}

/// Returns (real, demo, zone, rebuild_needed). A needed rebuild runs in the background once the window is up (Phase 9l).
fn open_databases(paths: &paths::DataPaths) -> anyhow::Result<(Arc<Db>, Arc<Db>, String, bool)> {
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
    // Phase 9h.1: the demo record is disposable (rebuilt from demo_seed.sql), so an unreadable demo.duckdb — typically a
    // stale .wal left by a killed run — is moved aside and recreated instead of stopping the app (owner's Linux MX crash).
    let demo = match Db::open(&paths.demo_db_path, &zone) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("demo record unreadable, recreating it: {e:#}");
            quarantine(&paths.demo_db_path);
            Db::open(&paths.demo_db_path, &zone).context("recreating the demo record")?
        }
    };
    // Phase 9i: a demo built by an older version lacks the newer features — replace it (never the real record).
    let demo_rev = demo.query("SELECT value FROM app_meta WHERE key = 'demo_rev'", &[]).ok().and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str().map(str::to_string)));
    let demo = if demo.scalar_i64("SELECT COUNT(*) FROM events")? > 0 && demo_rev.as_deref() != Some(db::DEMO_REV) {
        log::info!("demo record is from {:?}; rebuilding it for {}", demo_rev, db::DEMO_REV);
        drop(demo);
        quarantine(&paths.demo_db_path);
        Db::open(&paths.demo_db_path, &zone).context("recreating the demo record")?
    } else { demo };
    if demo.scalar_i64("SELECT COUNT(*) FROM events")? == 0 {
        log::info!("seeding demo record");
        // the full pipeline plus stand-in enrichment, so every page has something to show before an import (Phase 9i)
        for (name, sql) in [("demo_seed", db::DEMO_SEED_SQL), ("demo_events", db::DEMO_EVENTS_SQL), ("entity_resolution", db::ENTITY_RESOLUTION_SQL), ("demo_enrich", db::DEMO_ENRICH_SQL),
                            ("compute_sessions", db::COMPUTE_SESSIONS_SQL), ("compute_milestones", db::COMPUTE_MILESTONES_SQL), ("compute_scenes", db::COMPUTE_SCENES_SQL), ("compute_insights", db::COMPUTE_INSIGHTS_SQL)] {
            demo.exec_batch(sql).with_context(|| format!("building the demo record ({name}.sql)"))?;
        }
        demo.exec("INSERT INTO app_meta (key, value) VALUES ('demo_rev', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", &[serde_json::json!(db::DEMO_REV)])?;
        demo.checkpoint()?;
    }
    // Real record: make sure derived tables exist for whatever is in events
    // (e.g. schema upgraded, or a rebuild was interrupted).
    let events_n = real.scalar_i64("SELECT COUNT(*) FROM events")?;
    let resolved_n = real.scalar_i64("SELECT COUNT(*) FROM plays_resolved")?;
    // events that arrived after the last resolution (watermark written at the end of entity_resolution.sql)
    let unresolved = real.scalar_i64("SELECT COUNT(*) FROM events WHERE ingested_at > COALESCE(TRY_CAST((SELECT value FROM app_meta WHERE key = 'resolved_through') AS TIMESTAMPTZ), TIMESTAMPTZ '1900-01-01 00:00:00+00')")?;
    let built_with = real.query("SELECT value FROM app_meta WHERE key = 'built_with'", &[])?.first().and_then(|r| r.get("value")).and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    let version = env!("CARGO_PKG_VERSION").to_string() + "+" + PIPELINE_REV;
    let rebuild = events_n > 0 && (resolved_n == 0 || unresolved > 0 || built_with != version);
    if rebuild {
        log::info!("rebuild needed ({events_n} events, {resolved_n} resolved, {unresolved} since the last resolution, pipeline {built_with} → {version}) — running in the background");
        real.load_tz_offsets(&zone)?;
        real.exec("INSERT INTO app_meta (key, value) VALUES ('rebuilding', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value", &[])?;
    } else {
        real.exec("INSERT INTO app_meta (key, value) VALUES ('built_with', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", &[serde_json::json!(version)])?;
    }
    Ok((Arc::new(real), Arc::new(demo), zone, rebuild))
}

/// Phase 9h.1: logs go to the terminal *and* `<data dir>/logs/deep-cuts.log` (previous run kept as deep-cuts.1.log),
/// so a launch from the menu that dies still leaves its reason on disk.
fn init_logging() {
    struct Tee(Option<std::fs::File>);
    impl std::io::Write for Tee {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> { let _ = std::io::stderr().write_all(b); if let Some(f) = self.0.as_mut() { let _ = f.write_all(b); } Ok(b.len()) }
        fn flush(&mut self) -> std::io::Result<()> { let _ = std::io::stderr().flush(); if let Some(f) = self.0.as_mut() { let _ = f.flush(); } Ok(()) }
    }
    let file = paths::resolve().ok().and_then(|p| {
        let log = p.logs_dir.join("deep-cuts.log");
        let _ = std::fs::rename(&log, p.logs_dir.join("deep-cuts.1.log"));
        std::fs::File::create(&log).ok()
    });
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .target(env_logger::Target::Pipe(Box::new(Tee(file))))
        .init();
    // panics (like the setup failure) go through the log too, then the default hook prints as before
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| { log::error!("panic: {info}"); default(info); }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();

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
            let (real, demo, zone, rebuild) = open_databases(&paths).map_err(|e| {
                // `{:#}` prints the whole chain ("opening …: IO Error: …"), not just the outermost context
                log::error!("could not open the record: {e:#}");
                anyhow::anyhow!("{e:#}\n\nYour data folder is {} — nothing in it has been changed.", paths.data_dir.display())
            })?;
            app.manage(AppState {
                paths,
                real,
                demo,
                importing: AtomicBool::new(false),
                zone: Mutex::new(zone),
                spotify: SpotifyHandle(Arc::new(Mutex::new(None))),
            });
            tray::setup(app.handle())?;
            // Phase 9l: the first launch after an upgrade used to rebuild before any window existed (owner's "freezes").
            // Now the window opens at once and the rebuild runs here; the frontend shows a banner while app_meta
            // 'rebuilding' = '1' and refreshes when it's done. built_with is only written after success.
            if rebuild {
                let st = app.state::<AppState>();
                let db = st.real.clone();
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let version = env!("CARGO_PKG_VERSION").to_string() + "+" + PIPELINE_REV;
                    let started = std::time::Instant::now();
                    match db.rebuild_all() {
                        Ok(()) => {
                            let _ = db.exec("INSERT INTO app_meta (key, value) VALUES ('built_with', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", &[serde_json::json!(version)]);
                            db.log_activity("upgrade", "info", &format!("Rebuilt the record for pipeline {version} in {} s", started.elapsed().as_secs()), None);
                        }
                        Err(e) => { log::error!("background rebuild failed: {e:#}"); db.log_activity("upgrade", "error", &format!("Rebuild failed: {e:#}"), None); }
                    }
                    let _ = db.exec("INSERT INTO app_meta (key, value) VALUES ('rebuilding', '0') ON CONFLICT (key) DO UPDATE SET value = excluded.value", &[]);
                    events::emit(&handle, events::DATA_CHANGED, serde_json::json!({ "reason": "rebuild" }));
                });
            }
            // Phase 9m: Stylus starts with the app when the owner has turned it on (Services → Stylus)
            {
                let st = app.state::<AppState>();
                let on = st.real.query("SELECT value FROM app_meta WHERE key = 'stylus_enabled'", &[]).ok().and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str().map(|s| s == "true"))).unwrap_or(false);
                if on { if let Err(e) = stylus::start(st.real.clone()) { log::warn!("{e:#}"); st.real.log_activity("stylus", "error", &format!("{e:#}"), None); } }
            }
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
            // Phase 9f
            commands::lyrics_status,
            commands::forecast_log_write,
            commands::meta_set,
            commands::artist_tag_edit,
            commands::weather_store,
            commands::replace_playlist_items,
            commands::stylus_status,
            commands::stylus_configure,
            commands::stylus_add_device,
            commands::stylus_update_device,
            commands::stylus_remove_device,
            commands::artist_scene_auto,
            commands::export_record,
            commands::artist_set_origin,
            commands::artist_mb_candidates,
            commands::artist_set_mbid,
            commands::freqblog_connect,
            commands::freqblog_disconnect,
            commands::scene_family_upsert,
            commands::scene_family_delete,
            commands::scene_tag_set,
            commands::scene_origin_set,
            commands::recompute_scenes,
            commands::export_move_bundle,
            commands::inspect_move_bundle,
            commands::restore_move_bundle,
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
