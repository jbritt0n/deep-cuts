//! Extended Streaming History import (ING-01…04). Rust only locates and
//! unzips files and drives progress; the parsing, dedupe and insert are the
//! embedded SQL in `sql/import_*.sql`, executed per file (DuckDB reads the
//! JSON directly). Ported from v1 scripts/import_history.py.

use crate::db::{self, Db};
use crate::events::{self, ImportDone, ImportError, ImportProgress};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::AppHandle;
use tempfile::TempDir;

const FILE_PREFIX: &str = "Streaming_History_Audio_";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub name: String,
    pub rows_total: i64,
    pub rows_audio: i64,
    pub rows_skipped: i64,
    pub rows_duplicate_in_file: i64,
    pub rows_already_imported: i64,
    pub first_ts: Option<String>,
    pub last_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub source: String,
    pub source_kind: String, // zip | folder | file
    pub files: Vec<FilePreview>,
    pub rows_total: i64,
    pub rows_audio: i64,
    pub rows_skipped: i64,
    pub rows_duplicate_in_file: i64,
    pub rows_already_imported: i64,
    pub rows_new: i64,
    pub first_ts: Option<String>,
    pub last_ts: Option<String>,
    pub sample: Vec<db::Row>,
}

/// Find `Streaming_History_Audio_*.json` in a zip, a folder (recursively) or a
/// single file. Returns the files plus the temp dir that must outlive them.
pub fn locate_files(input: &Path) -> Result<(Vec<PathBuf>, Option<TempDir>, &'static str)> {
    if !input.exists() {
        return Err(anyhow!("{} does not exist", input.display()));
    }
    let is_zip = input
        .extension()
        .map(|e| e.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);

    if input.is_file() && is_zip {
        let tmp = tempfile::Builder::new().prefix("deep-cuts-import-").tempdir()?;
        let file = std::fs::File::open(input)?;
        let mut zip = zip::ZipArchive::new(file).context("reading zip")?;
        let mut out = Vec::new();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            let name = entry.name().to_string();
            let base = Path::new(&name)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if base.starts_with(FILE_PREFIX) && base.ends_with(".json") {
                let dest = tmp.path().join(&base);
                let mut f = std::fs::File::create(&dest)?;
                std::io::copy(&mut entry, &mut f)?;
                out.push(dest);
            }
        }
        if out.is_empty() {
            return Err(anyhow!(
                "No {FILE_PREFIX}*.json files inside the zip. Is this the *Extended* streaming history export (not the account-data one)?"
            ));
        }
        out.sort();
        return Ok((out, Some(tmp), "zip"));
    }

    if input.is_file() {
        return Ok((vec![input.to_path_buf()], None, "file"));
    }

    let mut out: Vec<PathBuf> = walkdir::WalkDir::new(input)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            let n = e.file_name().to_string_lossy();
            n.starts_with(FILE_PREFIX) && n.ends_with(".json")
        })
        .map(|e| e.into_path())
        .collect();
    if out.is_empty() {
        return Err(anyhow!(
            "No {FILE_PREFIX}*.json files found in {}. Point me at the export zip or the 'Spotify Extended Streaming History' folder.",
            input.display()
        ));
    }
    out.sort();
    Ok((out, None, "folder"))
}

fn basename(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
}

fn str_or_none(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|x| x.as_str().map(str::to_string))
}

fn stage_file(store: &Db, path: &Path) -> Result<FilePreview> {
    store.exec(db::IMPORT_STAGE_SQL, &[json!(path.to_string_lossy())])
        .with_context(|| format!("staging {}", basename(path)))?;
    let rows = store.query(db::IMPORT_PREVIEW_SQL, &[])?;
    let r = rows.first().ok_or_else(|| anyhow!("empty preview"))?;
    let i = |k: &str| r.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    Ok(FilePreview {
        name: basename(path),
        rows_total: i("rows_total"),
        rows_audio: i("rows_audio"),
        rows_skipped: i("rows_skipped"),
        rows_duplicate_in_file: i("rows_duplicate_in_file"),
        rows_already_imported: i("rows_already_imported"),
        first_ts: str_or_none(r.get("first_ts")),
        last_ts: str_or_none(r.get("last_ts")),
    })
}

/// ING-01: counts, date range and a preview before anything is written.
pub fn preview(store: &Db, input: &Path) -> Result<ImportPreview> {
    let (files, _tmp, kind) = locate_files(input)?;
    store.exec_batch(db::IMPORT_EXISTING_KEYS_SQL)?;
    let mut previews = Vec::new();
    for f in &files {
        let p = stage_file(store, f)?;
        // keys of this file count as "already imported" for the *next* file only
        // during a real import; for preview we keep files independent.
        previews.push(p);
    }
    let sample = store.query(
        "SELECT strftime(ts, '%Y-%m-%d %H:%M') AS ts, track_name, artist_name, album_name, ms_played \
         FROM _stage WHERE track_name IS NOT NULL ORDER BY ts DESC LIMIT 6",
        &[],
    )?;
    let sum = |f: fn(&FilePreview) -> i64| previews.iter().map(f).sum::<i64>();
    let rows_audio = sum(|p| p.rows_audio);
    let dup_in_file = sum(|p| p.rows_duplicate_in_file);
    let already = sum(|p| p.rows_already_imported);
    Ok(ImportPreview {
        source: input.to_string_lossy().to_string(),
        source_kind: kind.to_string(),
        rows_total: sum(|p| p.rows_total),
        rows_audio,
        rows_skipped: sum(|p| p.rows_skipped),
        rows_duplicate_in_file: dup_in_file,
        rows_already_imported: already,
        rows_new: (rows_audio - dup_in_file - already).max(0),
        first_ts: previews.iter().filter_map(|p| p.first_ts.clone()).min(),
        last_ts: previews.iter().filter_map(|p| p.last_ts.clone()).max(),
        files: previews,
        sample,
    })
}

/// ING-02/03/04: import every file with progress events, then rebuild.
pub fn run(app: &AppHandle, store: &Db, input: &Path, import_id: &str) -> Result<ImportDone> {
    let started = Instant::now();
    let progress = |stage: &str, file: Option<String>, idx: usize, count: usize, ins: i64, dup: i64, skip: i64, msg: String| {
        events::emit(
            app,
            events::IMPORT_PROGRESS,
            ImportProgress {
                stage: stage.to_string(),
                file,
                file_index: idx,
                file_count: count,
                rows_inserted: ins,
                rows_duplicate: dup,
                rows_skipped: skip,
                message: msg,
            },
        );
    };

    progress("extracting", None, 0, 0, 0, 0, 0, "Opening your export".into());
    let (files, _tmp, _kind) = locate_files(input)?;
    let count = files.len();

    progress("indexing", None, 0, count, 0, 0, 0, "Indexing what's already in your record".into());
    store.exec_batch(db::IMPORT_EXISTING_KEYS_SQL)?;

    let (mut inserted, mut duplicate, mut skipped) = (0i64, 0i64, 0i64);
    for (i, f) in files.iter().enumerate() {
        let name = basename(f);
        progress("importing", Some(name.clone()), i, count, inserted, duplicate, skipped, format!("Reading {name}"));
        let p = stage_file(store, f)?;
        let before = store.scalar_i64("SELECT COUNT(*) FROM events WHERE event_type = 'play'")?;
        store.exec(db::IMPORT_INSERT_SQL, &[json!(name)])
            .with_context(|| format!("inserting {name}"))?;
        store.exec_batch(db::IMPORT_MARK_KEYS_SQL)?;
        let after = store.scalar_i64("SELECT COUNT(*) FROM events WHERE event_type = 'play'")?;
        let file_inserted = after - before;
        let file_dup = p.rows_audio - file_inserted;
        inserted += file_inserted;
        duplicate += file_dup;
        skipped += p.rows_skipped;
        store.exec(
            "INSERT INTO import_files (import_id, source_file, rows_total, rows_audio, rows_skipped, rows_inserted, rows_duplicate) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[json!(import_id), json!(name), json!(p.rows_total), json!(p.rows_audio), json!(p.rows_skipped), json!(file_inserted), json!(file_dup)],
        )?;
        progress("importing", Some(name.clone()), i + 1, count, inserted, duplicate, skipped, format!("{name}: +{file_inserted} plays"));
    }
    let _ = store.exec_batch("DROP TABLE IF EXISTS _stage; DROP TABLE IF EXISTS _existing_keys;");

    // ING-04: derive everything, then land on the dashboard.
    progress("resolving", None, count, count, inserted, duplicate, skipped, "Resolving artists, albums and tracks".into());
    store.exec_batch(db::ENTITY_RESOLUTION_SQL).context("entity_resolution.sql")?;
    progress("sessions", None, count, count, inserted, duplicate, skipped, "Finding your listening sessions".into());
    store.exec_batch(db::COMPUTE_SESSIONS_SQL).context("compute_sessions.sql")?;
    store.exec_batch(db::COMPUTE_MILESTONES_SQL).context("compute_milestones.sql")?;
    progress("finishing", None, count, count, inserted, duplicate, skipped, "Pressing the record".into());
    store.checkpoint()?;

    let total_plays = store.scalar_i64("SELECT COUNT(*) FROM plays_resolved")?;
    let total_hours = store.scalar_f64("SELECT ROUND(SUM(ms_played)/3600000.0, 1) FROM plays_resolved")?;
    let done = ImportDone {
        import_id: import_id.to_string(),
        files: count,
        rows_inserted: inserted,
        rows_duplicate: duplicate,
        rows_skipped: skipped,
        total_plays,
        total_hours,
        elapsed_ms: started.elapsed().as_millis(),
    };
    store.log_activity(
        "import",
        "info",
        &format!("Imported {inserted} new plays from {count} files in {:.1}s ({duplicate} duplicates, {skipped} podcast/video rows skipped)", started.elapsed().as_secs_f32()),
        Some(&input.to_string_lossy()),
    );
    Ok(done)
}

pub fn report_error(app: &AppHandle, store: &Db, err: &anyhow::Error) {
    let message = format!("{err:#}");
    log::error!("import failed: {message}");
    store.log_activity("import", "error", "Import failed", Some(&message));
    events::emit(app, events::IMPORT_ERROR, ImportError { message });
}

/// Blend (Phase 4): aggregate someone else's export into blend_plays under a label. Never touches events.
pub fn import_blend(store: &Db, input: &Path, label: &str) -> Result<i64> {
    let (files, _tmp, _kind) = locate_files(input)?;
    store.exec("DELETE FROM blend_plays WHERE label = ?", &[json!(label)])?;
    let mut rows = 0i64;
    for f in &files {
        store.exec(db::IMPORT_STAGE_SQL, &[json!(f.to_string_lossy())])?;
        rows += store.exec(db::IMPORT_BLEND_SQL, &[json!(label)])? as i64;
    }
    let _ = store.exec_batch("DROP TABLE IF EXISTS _stage;");
    store.log_activity("blend", "info", &format!("Blend import for {label}: {rows} track rows from {} files", files.len()), Some(&input.to_string_lossy()));
    Ok(rows)
}
