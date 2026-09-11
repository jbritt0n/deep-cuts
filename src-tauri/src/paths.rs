//! Where data lives (PKG-03).
//! * `portable.flag` next to the executable → `<exe dir>/data/`
//! * otherwise the OS app-data directory:
//!   Windows `%APPDATA%\DeepCuts`, Linux `~/.local/share/deep-cuts`, macOS `~/Library/Application Support/DeepCuts`.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct DataPaths {
    pub portable: bool,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub demo_db_path: PathBuf,
    pub backups_dir: PathBuf,
    pub logs_dir: PathBuf,
}

pub fn resolve() -> anyhow::Result<DataPaths> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));

    let (portable, data_dir) = match exe_dir {
        Some(dir) if dir.join("portable.flag").exists() => (true, dir.join("data")),
        _ => (false, os_app_data_dir()?),
    };

    std::fs::create_dir_all(&data_dir)?;
    let backups_dir = data_dir.join("backups");
    let logs_dir = data_dir.join("logs");
    std::fs::create_dir_all(&backups_dir)?;
    std::fs::create_dir_all(&logs_dir)?;

    Ok(DataPaths {
        portable,
        db_path: data_dir.join("deep-cuts.duckdb"),
        demo_db_path: data_dir.join("demo.duckdb"),
        data_dir,
        backups_dir,
        logs_dir,
    })
}

fn os_app_data_dir() -> anyhow::Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("APPDATA is not set"))?;
        Ok(base.join("DeepCuts"))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("HOME is not set"))?;
        Ok(home.join("Library/Application Support/DeepCuts"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            return Ok(PathBuf::from(xdg).join("deep-cuts"));
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("HOME is not set"))?;
        Ok(home.join(".local/share/deep-cuts"))
    }
}
