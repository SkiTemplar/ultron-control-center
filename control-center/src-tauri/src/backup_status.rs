// ULTRON Control Center — disk-mirror backup status.
//
// Reads the mirror destinations under the configured backup root (set up by
// scripts/backup/weekly-backup.ps1, scheduled via Task Scheduler
// `ULTRON-Backup-Weekly`). Returns one entry per top-level subdir with
// the timestamp of the last modification so the UI can flag stale
// mirrors without recursively walking gigabytes of files.
//
// Backup root resolution order (v15.2 F7):
//   1. ~/.ultron/.tmp/backup-root.txt (user-configured via Settings UI)
//   2. $ULTRON_BACKUP_ROOT (env override — matches weekly-backup.ps1)
//   3. D:\BACKUP if the disk is mounted (USER's primary setup)
//   4. %USERPROFILE%\BACKUP (default for fresh installs)

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
pub struct BackupEntry {
    pub name: String,
    pub path: String,
    pub last_modified: Option<String>,
    pub age_hours: Option<f64>,
    pub exists: bool,
    /// `ok` (< 8 days), `stale` (8–30 days), `cold` (> 30 days).
    pub status: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct BackupStatusReport {
    pub root: String,
    pub root_exists: bool,
    pub entries: Vec<BackupEntry>,
    pub overall_status: String,
}

fn backup_root_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/.tmp/backup-root.txt"))
}

fn read_configured_backup_root() -> Option<String> {
    let path = backup_root_config_path()?;
    let s = fs::read_to_string(&path).ok()?;
    let trimmed = s.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn backup_root() -> PathBuf {
    // 1. user-configured override (Settings UI writes ~/.ultron/.tmp/backup-root.txt)
    if let Some(s) = read_configured_backup_root() {
        return PathBuf::from(s);
    }
    // 2. env-var (matches weekly-backup.ps1's own resolution path)
    if let Ok(v) = std::env::var("ULTRON_BACKUP_ROOT") {
        if !v.is_empty() {
            return PathBuf::from(v);
        }
    }
    // 3. D:\BACKUP if available (USER's primary setup, v15.1.6)
    let d_drive = PathBuf::from(r"D:\BACKUP");
    if d_drive.exists() {
        return d_drive;
    }
    // 4. %USERPROFILE%\BACKUP fallback
    if let Some(home) = dirs::home_dir() {
        return home.join("BACKUP");
    }
    PathBuf::from(r"C:\BACKUP")
}

// ---------------------------------------------------------------------------
// v15.2 F7: read/write the configured backup root from the UI.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct BackupRootInfo {
    /// Currently active path (after resolving the four sources above).
    pub current: String,
    /// Suggested default if `current` is empty (D:\BACKUP if disk mounted,
    /// otherwise ~/BACKUP).
    pub suggested: String,
    /// True when the path resolves to an existing directory.
    pub exists: bool,
    /// True when ~/.ultron/.tmp/backup-root.txt is the source of the value
    /// (i.e. the user has explicitly configured it via the UI).
    pub user_configured: bool,
    /// Path of the config file that backs the setting.
    pub config_path: String,
}

pub fn get_backup_root_inner() -> Result<BackupRootInfo, String> {
    let current = backup_root();
    let user_configured = read_configured_backup_root().is_some();
    let suggested = {
        let d_drive = PathBuf::from(r"D:\BACKUP");
        if d_drive.exists() {
            d_drive.to_string_lossy().to_string()
        } else if let Some(home) = dirs::home_dir() {
            home.join("BACKUP").to_string_lossy().to_string()
        } else {
            r"C:\BACKUP".to_string()
        }
    };
    let config_path = backup_root_config_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(BackupRootInfo {
        current: current.to_string_lossy().to_string(),
        suggested,
        exists: current.exists(),
        user_configured,
        config_path,
    })
}

#[derive(Debug, Deserialize)]
pub struct SetBackupRootPayload {
    pub path: String,
}

pub fn set_backup_root_inner(payload: SetBackupRootPayload) -> Result<BackupRootInfo, String> {
    let trimmed = payload.path.trim().to_string();
    let cfg = backup_root_config_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = cfg.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir tmp: {}", e))?;
        }
    }
    if trimmed.is_empty() {
        // Empty = clear the override and fall back to env/D:/home defaults.
        if cfg.exists() {
            fs::remove_file(&cfg).map_err(|e| format!("rm config: {}", e))?;
        }
        // Also unset the in-process env var so subsequent reads from the same
        // session don't keep the stale override.
        std::env::remove_var("ULTRON_BACKUP_ROOT");
    } else {
        fs::write(&cfg, &trimmed).map_err(|e| format!("write config: {}", e))?;
        // Mirror into the env var so the scheduled-task wrapper (which we
        // can't restart from here) and any in-process consumer pick it up.
        std::env::set_var("ULTRON_BACKUP_ROOT", &trimmed);
    }
    get_backup_root_inner()
}

fn iso_from_systime(t: SystemTime) -> Option<String> {
    let secs = t.duration_since(UNIX_EPOCH).ok()?.as_secs();
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd { break; }
        days -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    Some(format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month + 1, days + 1, h, m, s))
}

fn classify(age_hours: Option<f64>) -> &'static str {
    match age_hours {
        Some(h) if h < 8.0 * 24.0 => "ok",
        Some(h) if h < 30.0 * 24.0 => "stale",
        Some(_) => "cold",
        None => "unknown",
    }
}

/// Walks one level deep so we don't du gigabytes. Mtime of the top-level
/// subdir is what robocopy /MIR touches on every run, so this is a faithful
/// proxy for "when was the backup last refreshed".
pub fn backup_status_inner() -> Result<BackupStatusReport, String> {
    let root = backup_root();
    let root_str = root.to_string_lossy().to_string();
    let root_exists = root.exists();
    if !root_exists {
        return Ok(BackupStatusReport {
            root: root_str,
            root_exists: false,
            entries: Vec::new(),
            overall_status: "missing".into(),
        });
    }

    let mut entries: Vec<BackupEntry> = Vec::new();
    let now = SystemTime::now();
    let dir = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for ent in dir.flatten() {
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().to_string();
        let meta = ent.metadata().ok();
        let mtime = meta.as_ref().and_then(|m| m.modified().ok());
        let age_hours = mtime.and_then(|t| {
            now.duration_since(t).ok().map(|d| d.as_secs_f64() / 3600.0)
        });
        let last_iso = mtime.and_then(iso_from_systime);
        let status = classify(age_hours).to_string();
        entries.push(BackupEntry {
            name,
            path: path.to_string_lossy().to_string(),
            last_modified: last_iso,
            age_hours,
            exists: true,
            status,
        });
    }
    // Most-recently-modified first.
    entries.sort_by(|a, b| {
        a.age_hours
            .unwrap_or(f64::INFINITY)
            .partial_cmp(&b.age_hours.unwrap_or(f64::INFINITY))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let overall_status = if entries.is_empty() {
        "empty"
    } else if entries.iter().any(|e| e.status == "cold") {
        "cold"
    } else if entries.iter().any(|e| e.status == "stale") {
        "stale"
    } else {
        "ok"
    }
    .into();

    Ok(BackupStatusReport {
        root: root_str,
        root_exists,
        entries,
        overall_status,
    })
}

// LIB_RS_WIRING (v15.2 F7):
//   Register two new commands in `src-tauri/src/lib.rs` so the Backups
//   sub-tab can read/write the configured backup root.
//
//   1. Add Tauri command wrappers next to `backup_status`:
//
//        #[tauri::command]
//        async fn get_backup_root() -> Result<backup_status::BackupRootInfo, String> {
//            backup_status::get_backup_root_inner()
//        }
//
//        #[tauri::command]
//        async fn set_backup_root(path: String) -> Result<backup_status::BackupRootInfo, String> {
//            backup_status::set_backup_root_inner(backup_status::SetBackupRootPayload { path })
//        }
//
//   2. Add `get_backup_root` and `set_backup_root` to the
//      `tauri::generate_handler![...]` list (same list that already
//      contains `backup_status`).
//
//   The existing `backup_status` command already calls `backup_root()`
//   internally, which now resolves the user-configured override first —
//   no change needed to that wrapper.
