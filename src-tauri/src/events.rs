//! Progress / task events streamed to the UI (spec §2.3). Payloads are plain
//! serialisable structs so the TypeScript side gets typed events.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const IMPORT_PROGRESS: &str = "import:progress";
pub const IMPORT_DONE: &str = "import:done";
pub const IMPORT_ERROR: &str = "import:error";
pub const DATA_CHANGED: &str = "data:changed";

#[derive(Debug, Clone, Serialize)]
pub struct ImportProgress {
    pub stage: String,        // extracting | indexing | importing | resolving | sessions | finishing
    pub file: Option<String>,
    pub file_index: usize,
    pub file_count: usize,
    pub rows_inserted: i64,
    pub rows_duplicate: i64,
    pub rows_skipped: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportDone {
    pub import_id: String,
    pub files: usize,
    pub rows_inserted: i64,
    pub rows_duplicate: i64,
    pub rows_skipped: i64,
    pub total_plays: i64,
    pub total_hours: f64,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportError {
    pub message: String,
}

pub fn emit<T: Serialize + Clone>(app: &AppHandle, name: &str, payload: T) {
    if let Err(e) = app.emit(name, payload) {
        log::warn!("event {name} failed: {e}");
    }
}
