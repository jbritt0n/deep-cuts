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
    const ALLOWED: &[&str] = &["attention_gap_min", "theme", "lyrics_enabled", "album_threshold"];
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
                "enrichedTracks": enriched.first().and_then(|x| x.get("e")).and_then(|v| v.as_i64()).unwrap_or(0), "totalTracks": enriched.first().and_then(|x| x.get("n")).and_then(|v| v.as_i64()).unwrap_or(0), "likedSongs": liked }),
            "lastfm" => serde_json::json!({ "taggedArtists": tag_of("lastfm") }),
            "musicbrainz" => serde_json::json!({ "taggedArtists": tag_of("musicbrainz"), "resolvedArtists": mbids }),
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
                let pls = sync::sync_playlists(&client, &real, &me)?;
                let enriched = sync::enrich_batch(&client, &real)?;
                format!("Spotify: +{added} plays, {liked} liked songs, {pls} playlists, {enriched} tracks enriched")
            }
            "lastfm" => { let t = lastfm::enrich_tags(&real, 60)?; let s = lastfm::enrich_similar(&real, 15)?; format!("Last.fm: tagged {t} artists, {s} similar-artist seeds") }
            "musicbrainz" => { let n = musicbrainz::resolve_batch(&real, 40)?; let r = musicbrainz::enrich_relations(&real, 15)?; format!("MusicBrainz: resolved {n} artists, relationships for {r}") }
            "statsfm" => { let n = crate::connectors::statsfm::import(&real, 10)?; format!("stats.fm: +{n} plays") }
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
