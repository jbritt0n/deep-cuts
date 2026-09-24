//! Phase 9f — move the whole record to another computer.
//!
//! Owner request: "a way to export the entire database and plug it into another version on a
//! different computer, including all enrichment data collected so far — album art, genre/tags,
//! lyric features, listening history/polling, and all interactions I've made within the app."
//!
//! Everything the app knows lives in the one DuckDB file, so the bundle is that database written
//! out table by table as Parquet (DuckDB's storage format changes between versions; Parquet does
//! not), plus a manifest, plus — optionally — the keyring secrets (Spotify tokens and client id,
//! Last.fm key/user, stats.fm key) encrypted with a passphrase the owner types. Album art is URLs
//! in `albums.image_url`, so it travels with the tables.
//!
//! Restore is column-intersecting: every table in the bundle that still exists is emptied and
//! refilled from the Parquet with the columns both sides know, so a bundle from an older or newer
//! build imports cleanly and columns the bundle lacks take their schema defaults. Derived tables
//! (plays_resolved, sessions, insights …) are included for completeness but rebuilt afterwards
//! anyway, because the receiving build may have a newer pipeline.
//!
//! Secrets file format: "DCS1" ‖ salt(16) ‖ nonce(24) ‖ XChaCha20-Poly1305(ciphertext).
//! Key = 200 000 rounds of SHA-256 over (salt ‖ passphrase ‖ previous). Deliberately simple and
//! dependency-light; the threat model is a bundle sitting on a USB stick, not a nation state.

use crate::db::Db;
use crate::paths::DataPaths;
use crate::secrets;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const FORMAT: u32 = 1;
const SKIP_TABLES: &[&str] = &["tz_offsets"];   // regenerated from the zone on open
const SECRET_KEYS: &[&str] = &[secrets::SPOTIFY_TOKENS, secrets::SPOTIFY_CLIENT_ID, secrets::LASTFM_KEY, secrets::LASTFM_USER, secrets::STATSFM_KEY, secrets::FREQBLOG_KEY];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo { pub name: String, pub rows: i64 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub format: u32,
    pub app_version: String,
    pub pipeline_rev: String,
    pub created_at: String,
    pub zone: String,
    pub tables: Vec<TableInfo>,
    pub events: i64,
    pub plays: i64,
    pub first_play: Option<String>,
    pub last_play: Option<String>,
    pub secrets: bool,
    pub source_os: String,
    pub source_data_dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreReport { pub tables: usize, pub rows: i64, pub skipped_tables: Vec<String>, pub secrets_restored: usize, pub manifest: Manifest, pub backup_of_previous: Option<String> }

fn q(path: &Path) -> String { path.to_string_lossy().replace('\'', "''") }

fn base_tables(db: &Db) -> Result<Vec<String>> {
    Ok(db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE' ORDER BY table_name", &[])?
        .into_iter().filter_map(|r| r.get("table_name").and_then(|v| v.as_str()).map(str::to_string))
        .filter(|t| !SKIP_TABLES.contains(&t.as_str()) && !t.starts_with('_')).collect())
}

/// Write `<dest_dir>/deep-cuts-move-<stamp>.zip`. Returns its path.
pub fn export_bundle(db: &Db, paths: &DataPaths, dest_dir: &Path, passphrase: Option<&str>, app_version: &str, pipeline_rev: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(dest_dir)?;
    let tmp = tempfile::tempdir()?;
    db.checkpoint()?;
    let mut tables = Vec::new();
    for t in base_tables(db)? {
        let out = tmp.path().join(format!("{t}.parquet"));
        db.exec_batch(&format!("COPY (SELECT * FROM \"{t}\") TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD)", q(&out))).with_context(|| format!("exporting {t}"))?;
        let rows = db.scalar_i64(&format!("SELECT COUNT(*) FROM \"{t}\"")).unwrap_or(0);
        tables.push(TableInfo { name: t, rows });
    }
    let zone = db.query("SELECT value FROM app_meta WHERE key = 'timezone'", &[])?.first().and_then(|r| r.get("value")).and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| db.zone.clone());
    let span = db.query("SELECT CAST(MIN(played_at) AS VARCHAR) AS f, CAST(MAX(played_at) AS VARCHAR) AS l FROM plays_resolved", &[])?;
    let (first, last) = span.first().map(|r| (r.get("f").and_then(|v| v.as_str()).map(str::to_string), r.get("l").and_then(|v| v.as_str()).map(str::to_string))).unwrap_or((None, None));
    let mut manifest = Manifest {
        format: FORMAT, app_version: app_version.to_string(), pipeline_rev: pipeline_rev.to_string(), created_at: chrono::Utc::now().to_rfc3339(), zone,
        tables, events: db.scalar_i64("SELECT COUNT(*) FROM events").unwrap_or(0), plays: db.scalar_i64("SELECT COUNT(*) FROM plays_resolved").unwrap_or(0),
        first_play: first, last_play: last, secrets: false, source_os: std::env::consts::OS.to_string(), source_data_dir: paths.data_dir.to_string_lossy().to_string(),
    };
    // secrets, only with a passphrase
    let mut secret_blob: Option<Vec<u8>> = None;
    if let Some(pw) = passphrase.filter(|p| !p.trim().is_empty()) {
        let mut m = serde_json::Map::new();
        for k in SECRET_KEYS { if let Ok(Some(v)) = secrets::get(k) { m.insert(k.to_string(), json!(v)); } }
        if !m.is_empty() {
            secret_blob = Some(encrypt(pw, serde_json::Value::Object(m).to_string().as_bytes())?);
            manifest.secrets = true;
        }
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let out = dest_dir.join(format!("deep-cuts-move-{stamp}.zip"));
    let file = std::fs::File::create(&out)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("manifest.json", opts)?;
    zip.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
    zip.start_file("README.txt", opts)?;
    zip.write_all(b"Deep Cuts move bundle. Restore it from Settings -> Record -> Move to another computer on the destination machine.\nTables are Parquet (one per table); manifest.json lists them. secrets.enc, when present, holds the connector tokens encrypted with the passphrase you typed.\n")?;
    for t in &manifest.tables {
        zip.start_file(format!("tables/{}.parquet", t.name), stored)?;   // Parquet is already ZSTD-compressed
        let mut f = std::fs::File::open(tmp.path().join(format!("{}.parquet", t.name)))?;
        std::io::copy(&mut f, &mut zip)?;
    }
    if let Some(b) = secret_blob { zip.start_file("secrets.enc", stored)?; zip.write_all(&b)?; }
    zip.finish()?;
    db.log_activity("move", "info", &format!("Move bundle written: {} tables, {} plays{}", manifest.tables.len(), manifest.plays, if manifest.secrets { ", secrets included (encrypted)" } else { "" }), Some(&out.to_string_lossy()));
    Ok(out)
}

pub fn inspect_bundle(path: &Path) -> Result<Manifest> {
    let f = std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut z = zip::ZipArchive::new(f)?;
    let mut m = String::new();
    z.by_name("manifest.json").map_err(|_| anyhow!("Not a Deep Cuts move bundle (no manifest.json)"))?.read_to_string(&mut m)?;
    let man: Manifest = serde_json::from_str(&m).context("reading manifest.json")?;
    if man.format > FORMAT { anyhow::bail!("This bundle was made by a newer Deep Cuts (format {}); update this app first.", man.format); }
    Ok(man)
}

/// Replace this record with the bundle's. Backs up the current events to backups/ first.
pub fn restore_bundle(db: &Db, paths: &DataPaths, path: &Path, passphrase: Option<&str>, app_version: &str) -> Result<RestoreReport> {
    let manifest = inspect_bundle(path)?;
    let f = std::fs::File::open(path)?;
    let mut z = zip::ZipArchive::new(f)?;
    let tmp = tempfile::tempdir()?;
    // secrets first: a wrong passphrase must fail before anything is touched
    let mut secret_values: Option<serde_json::Map<String, serde_json::Value>> = None;
    if manifest.secrets {
        if let Ok(mut sf) = z.by_name("secrets.enc") {
            let mut blob = Vec::new(); sf.read_to_end(&mut blob)?;
            match passphrase.filter(|p| !p.trim().is_empty()) {
                Some(pw) => {
                    let plain = decrypt(pw, &blob).map_err(|_| anyhow!("Wrong passphrase for the bundle's secrets. Leave it blank to restore the record without them."))?;
                    secret_values = serde_json::from_slice::<serde_json::Value>(&plain).ok().and_then(|v| v.as_object().cloned());
                }
                None => {}
            }
        }
    }
    // safety copy of what is here now
    let mut backup = None;
    if db.scalar_i64("SELECT COUNT(*) FROM events").unwrap_or(0) > 0 {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let out = paths.backups_dir.join(format!("events-before-restore-{stamp}.parquet"));
        db.exec_batch(&format!("COPY (SELECT * FROM events ORDER BY occurred_at) TO '{}' (FORMAT PARQUET)", q(&out)))?;
        backup = Some(out.to_string_lossy().to_string());
    }
    // unpack the tables
    for t in &manifest.tables {
        let name = format!("tables/{}.parquet", t.name);
        let Ok(mut entry) = z.by_name(&name) else { continue };
        let dest = tmp.path().join(format!("{}.parquet", t.name));
        let mut out = std::fs::File::create(&dest)?;
        std::io::copy(&mut entry, &mut out)?;
    }
    let existing: std::collections::HashSet<String> = base_tables(db)?.into_iter().collect();
    let mut restored = 0usize; let mut rows = 0i64; let mut skipped = Vec::new();
    db.exec_batch("BEGIN TRANSACTION")?;
    let result: Result<()> = (|| {
        for t in &manifest.tables {
            let file = tmp.path().join(format!("{}.parquet", t.name));
            if !existing.contains(&t.name) || !file.exists() { skipped.push(t.name.clone()); continue; }
            let src_cols: Vec<String> = db.query(&format!("DESCRIBE SELECT * FROM read_parquet('{}')", q(&file)), &[])?
                .into_iter().filter_map(|r| r.get("column_name").and_then(|v| v.as_str()).map(str::to_string)).collect();
            let dst_cols: Vec<String> = db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'main' AND table_name = ? ORDER BY ordinal_position", &[json!(t.name)])?
                .into_iter().filter_map(|r| r.get("column_name").and_then(|v| v.as_str()).map(str::to_string)).collect();
            let cols: Vec<String> = dst_cols.iter().filter(|c| src_cols.contains(c)).map(|c| format!("\"{c}\"")).collect();
            if cols.is_empty() { skipped.push(t.name.clone()); continue; }
            db.exec_batch(&format!("DELETE FROM \"{}\"", t.name))?;
            let list = cols.join(", ");
            db.exec_batch(&format!("INSERT INTO \"{}\" ({list}) SELECT {list} FROM read_parquet('{}')", t.name, q(&file))).with_context(|| format!("restoring {}", t.name))?;
            rows += t.rows; restored += 1;
        }
        Ok(())
    })();
    match result {
        Ok(()) => db.exec_batch("COMMIT")?,
        Err(e) => { let _ = db.exec_batch("ROLLBACK"); return Err(e); }
    }
    // secrets → keyring
    let mut secrets_restored = 0;
    if let Some(m) = secret_values {
        for (k, v) in m { if let Some(s) = v.as_str() { if SECRET_KEYS.contains(&k.as_str()) && secrets::set(&k, s).is_ok() { secrets_restored += 1; } } }
    }
    // the record's own zone wins; derived tables rebuilt under this build's pipeline
    let zone = db.query("SELECT value FROM app_meta WHERE key = 'timezone'", &[])?.first().and_then(|r| r.get("value")).and_then(|v| v.as_str().map(str::to_string)).unwrap_or(manifest.zone.clone());
    db.load_tz_offsets(&zone)?;
    db.rebuild_all()?;
    db.exec("INSERT INTO app_meta (key, value) VALUES ('built_with', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", &[json!(app_version)])?;
    db.log_activity("move", "info", &format!("Restored a move bundle from {} ({} plays, {restored} tables, {secrets_restored} secrets)", manifest.source_os, manifest.plays), Some(&path.to_string_lossy()));
    Ok(RestoreReport { tables: restored, rows, skipped_tables: skipped, secrets_restored, manifest, backup_of_previous: backup })
}

// ---- crypto helpers ---------------------------------------------------------------------------
fn derive_key(pw: &str, salt: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut prev = [0u8; 32];
    for _ in 0..200_000 {
        let mut h = Sha256::new();
        h.update(salt); h.update(pw.as_bytes()); h.update(prev);
        prev = h.finalize().into();
    }
    prev
}

fn encrypt(pw: &str, plain: &[u8]) -> Result<Vec<u8>> {
    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{XChaCha20Poly1305, XNonce};
    use rand::RngCore;
    let mut salt = [0u8; 16]; rand::thread_rng().fill_bytes(&mut salt);
    let mut nonce = [0u8; 24]; rand::thread_rng().fill_bytes(&mut nonce);
    let key = derive_key(pw, &salt);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let ct = cipher.encrypt(XNonce::from_slice(&nonce), plain).map_err(|_| anyhow!("encryption failed"))?;
    let mut out = Vec::with_capacity(4 + 16 + 24 + ct.len());
    out.extend_from_slice(b"DCS1"); out.extend_from_slice(&salt); out.extend_from_slice(&nonce); out.extend_from_slice(&ct);
    Ok(out)
}

fn decrypt(pw: &str, blob: &[u8]) -> Result<Vec<u8>> {
    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{XChaCha20Poly1305, XNonce};
    if blob.len() < 4 + 16 + 24 || &blob[..4] != b"DCS1" { anyhow::bail!("not a Deep Cuts secrets file"); }
    let (salt, rest) = blob[4..].split_at(16);
    let (nonce, ct) = rest.split_at(24);
    let key = derive_key(pw, salt);
    let cipher = XChaCha20Poly1305::new((&key).into());
    cipher.decrypt(XNonce::from_slice(nonce), ct).map_err(|_| anyhow!("wrong passphrase"))
}

/// Phase 9i — "Export everything": a readable copy of the whole record (not a restore bundle). Writes
/// `<dest>/deep-cuts-export-<stamp>/` with every table as CSV or Parquet, `plays_enriched` (one row per play with its
/// enrichment), and a README. Secrets are never included.
pub fn export_record(db: &Db, dest_dir: &Path, format: &str) -> Result<PathBuf> {
    let parquet = format == "parquet";
    let ext = if parquet { "parquet" } else { "csv" };
    let opts = if parquet { "(FORMAT PARQUET, COMPRESSION ZSTD)" } else { "(HEADER, DELIMITER ',')" };
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let out = dest_dir.join(format!("deep-cuts-export-{stamp}"));
    std::fs::create_dir_all(out.join("tables"))?;
    db.checkpoint()?;
    let mut listing = String::new();
    // the flat file first — it's the one most people want
    db.exec_batch(&format!("COPY (SELECT * FROM plays_enriched ORDER BY played_at) TO '{}' {opts}", q(&out.join(format!("plays_enriched.{ext}")))))?;
    for t in base_tables(db)? {
        let rows = db.scalar_i64(&format!("SELECT COUNT(*) FROM \"{t}\"")).unwrap_or(0);
        if rows == 0 { continue; }
        // CSV can't hold nested lists / JSON as-is; cast every column to text so spreadsheets read it
        let select = if parquet { "*".to_string() } else {
            db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'main' AND table_name = ? ORDER BY ordinal_position", &[json!(t)])?
                .into_iter().filter_map(|r| r.get("column_name").and_then(|v| v.as_str()).map(|c| format!("CAST(\"{c}\" AS VARCHAR) AS \"{c}\""))).collect::<Vec<_>>().join(", ")
        };
        db.exec_batch(&format!("COPY (SELECT {select} FROM \"{t}\") TO '{}' {opts}", q(&out.join("tables").join(format!("{t}.{ext}")))))?;
        listing.push_str(&format!("  tables/{t}.{ext}  ({rows} rows)\n"));
    }
    std::fs::write(out.join("README.txt"), format!("Deep Cuts — everything in this record, exported {stamp}.\n\nplays_enriched.{ext}: one row per play with its artist origin, scene, tags, album art URL, release date,\nLast.fm listeners, audio features (FreqBlog), lyric language/themes (derived — no lyric text exists), and whether it is\nin your Liked Songs.\n\nEvery table as stored:\n{listing}\nTo move the record to another computer use Settings → Record → Move to another computer instead — that bundle restores.\nNo passwords or sign-in tokens are in this export.\n"))?;
    db.log_activity("export", "info", &format!("Exported everything ({ext})"), Some(&out.to_string_lossy()));
    Ok(out)
}
