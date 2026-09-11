//! Background tasks (spec §3 scheduler). Runs while the window is open or
//! hidden to the tray. Each tick is a blocking job on tokio's blocking pool;
//! every failure is logged to activity_log (NFR-05), never surfaced as a crash.

use crate::connectors::{lastfm, musicbrainz, statsfm};
use crate::spotify::endpoints::budget;
use crate::spotify::sync;
use crate::AppState;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub fn start(app: AppHandle) {
    // Spotify: poll every 20 min, first run 15 s after launch.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            let a2 = a.clone();
            run_blocking(&a, "poll", move |st| {
                if !st.spotify.is_connected() { return Ok(()); }
                let added = sync::poll_recent(&st.spotify_ref(), &st.real)?;
                if added > 0 { let _ = a2.emit("data:changed", serde_json::json!({ "reason": "poll", "added": added })); }
                Ok(())
            }).await;
            tokio::time::sleep(Duration::from_secs(budget::POLL_EVERY_SECS)).await;
        }
    });

    // Spotify: enrichment trickle every 10 min (budget-aware inside), library daily.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let mut ticks: u64 = 0;
        loop {
            run_blocking(&a, "enrich", |st| {
                if !st.spotify.is_connected() { return Ok(()); }
                sync::enrich_batch(&st.spotify_ref(), &st.real)?;
                Ok(())
            }).await;
            if ticks % (budget::LIBRARY_SYNC_EVERY_SECS / 600) == 0 {
                run_blocking(&a, "sync", |st| {
                    if !st.spotify.is_connected() { return Ok(()); }
                    let c = st.spotify_ref();
                    let (me, _) = sync::whoami(&c, &st.real)?;
                    sync::sync_liked(&c, &st.real)?;
                    sync::sync_playlists(&c, &st.real, &me)?;
                    Ok(())
                }).await;
            }
            ticks += 1;
            tokio::time::sleep(Duration::from_secs(600)).await;
        }
    });

    // Last.fm + MusicBrainz: gentle trickle every 5 min.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(90)).await;
        loop {
            run_blocking(&a, "lastfm", |st| { lastfm::enrich_tags(&st.real, 40)?; lastfm::enrich_similar(&st.real, 10)?; Ok(()) }).await;
            run_blocking(&a, "musicbrainz", |st| {
                let connected = st.real.query("SELECT status FROM connector_state WHERE service = 'musicbrainz'", &[])
                    .ok().and_then(|r| r.first().and_then(|m| m.get("status")).and_then(|v| v.as_str().map(str::to_string)));
                if connected.as_deref() == Some("connected") { musicbrainz::resolve_batch(&st.real, 30)?; musicbrainz::enrich_relations(&st.real, 10)?; crate::connectors::coverart::enrich_batch(&st.real, 10)?; }
                Ok(())
            }).await;
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });

    // Lyric features (LRCLIB): 40 tracks every 15 minutes, most-played first, when enabled in Settings.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(180)).await;
        loop {
            run_blocking(&a, "lyrics", |st| {
                let on = st.real.query("SELECT value FROM app_meta WHERE key = 'lyrics_enabled'", &[]).ok().and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str().map(|s| s == "true"))).unwrap_or(false);
                if on { crate::connectors::lyrics::enrich_batch(&st.real, 40)?; }
                Ok(())
            }).await;
            tokio::time::sleep(Duration::from_secs(900)).await;
        }
    });

    // Nightly (03:30 local): full rebuild (DM-02), milestones, Parquet backup (NFR-03), keep 14 backups.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let now = chrono::Local::now();
            let mut next = now.date_naive().and_hms_opt(3, 30, 0).unwrap();
            if next <= now.naive_local() { next += chrono::Duration::days(1); }
            let wait = (next - now.naive_local()).num_seconds().max(60) as u64;
            tokio::time::sleep(Duration::from_secs(wait)).await;
            run_blocking(&a, "nightly", |st| {
                st.real.rebuild_all()?;
                let stamp = chrono::Local::now().format("%Y%m%d");
                let out = st.paths.backups_dir.join(format!("events-{stamp}.parquet"));
                st.real.exec_batch(&format!("COPY (SELECT * FROM events ORDER BY occurred_at) TO '{}' (FORMAT PARQUET)", out.to_string_lossy().replace('\'', "''")))?;
                let mut files: Vec<_> = std::fs::read_dir(&st.paths.backups_dir)?.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("events-")).collect();
                files.sort_by_key(|e| e.file_name());
                while files.len() > 14 { let f = files.remove(0); let _ = std::fs::remove_file(f.path()); }
                st.real.log_activity("nightly", "info", "Nightly rebuild and backup done", Some(&out.to_string_lossy()));
                Ok(())
            }).await;
        }
    });

    // Radar refresh: monthly, add accepted recommendations that aren't in the Radar playlist yet.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(600)).await;
        loop {
            run_blocking(&a, "radar", |st| {
                if !st.spotify.is_connected() { return Ok(()); }
                let last = st.real.query("SELECT value FROM app_meta WHERE key = 'radar_refreshed'", &[]).ok().and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str().map(str::to_string)));
                let due = last.map(|v| v < chrono::Local::now().checked_sub_signed(chrono::Duration::days(30)).unwrap().format("%Y-%m-%d").to_string()).unwrap_or(true);
                if !due { return Ok(()); }
                let names = st.real.query("SELECT DISTINCT subject_key FROM recommendation_feedback f WHERE verdict = 'accepted' AND decided_at >= now() - INTERVAL 45 DAY AND subject_key NOT LIKE 'album-gap:%' AND subject_key NOT LIKE 'underserved:%' AND subject_key NOT LIKE 'forgotten:%' AND subject_key NOT LIKE 'one-track:%'", &[])?;
                let client = st.spotify_ref();
                let mut ids = Vec::new();
                for r in names.iter().take(15) {
                    let key = r.get("subject_key").and_then(|v| v.as_str()).unwrap_or("");
                    let name = key.strip_prefix("name:").unwrap_or(key);
                    if let Ok(found) = crate::playlists::search_track_ids(&client, &st.real, name, 2) { ids.extend(found); }
                }
                if !ids.is_empty() { crate::playlists::add_to_radar(&client, &st.real, &ids)?; }
                st.real.exec("INSERT INTO app_meta (key, value) VALUES ('radar_refreshed', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", &[serde_json::json!(chrono::Local::now().format("%Y-%m-%d").to_string())])?;
                Ok(())
            }).await;
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });

    // stats.fm: every 6 hours, newest streams first, stops at known history.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(120)).await;
        loop {
            let a2 = a.clone();
            run_blocking(&a, "statsfm", move |st| {
                if crate::secrets::get(crate::secrets::STATSFM_KEY).ok().flatten().is_none() { return Ok(()); }
                let n = statsfm::import(&st.real, 5)?;
                if n > 0 { let _ = a2.emit("data:changed", serde_json::json!({ "reason": "statsfm", "added": n })); }
                Ok(())
            }).await;
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

async fn run_blocking<F>(app: &AppHandle, task: &'static str, f: F)
where F: FnOnce(&AppState) -> anyhow::Result<()> + Send + 'static {
    let a = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let st = a.state::<AppState>();
        if st.importing.load(Ordering::SeqCst) { return Ok(()); } // never fight the importer for the writer
        f(&st)
    }).await;
    match r {
        Ok(Ok(())) => {}
        Ok(Err(e)) => { let st = app.state::<AppState>(); st.real.log_activity(task, "error", &format!("{task} failed"), Some(&format!("{e:#}"))); }
        Err(e) => log::error!("{task} panicked: {e}"),
    }
}
