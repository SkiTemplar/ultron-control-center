// ULTRON Control Center — D:\ backup status.
//
// Reads the mirror destinations under D:\USER\BACKUP\ (set up by
// scripts/backup/weekly-backup.ps1, scheduled via Task Scheduler
// `ULTRON-Backup-Weekly`). Returns one entry per top-level subdir with
// the timestamp of the last modification so the UI can flag stale
// mirrors without recursively walking gigabytes of files.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

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

fn backup_root() -> PathBuf {
    PathBuf::from(r"D:\USER\BACKUP")
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
