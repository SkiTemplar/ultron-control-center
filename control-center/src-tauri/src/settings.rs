// ULTRON Control Center — Settings module.
//
// Read/write ~/.claude/settings.json from the UI. Mutations are sensitive:
//   - we make a timestamped backup before every save
//   - we never serialize a partial document; only the full parsed JSON
//   - the frontend round-trips the entire object so we don't accidentally
//     drop fields we don't know about (forward compatibility)
//
// Out of scope here (intentionally): editing the raw text with arbitrary
// content. The frontend works with structured JSON only.

use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
pub struct SettingsSnapshot {
    pub path: String,
    pub content: serde_json::Value,
    pub modified: Option<String>,
    pub size_bytes: u64,
    pub backup_dir: String,
    pub recent_backups: Vec<String>,
}

fn claude_settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/settings.json"))
}

fn backups_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/backups/control-center-settings"))
}

fn iso_now_compact() -> String {
    let secs = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // YYYYMMDDTHHMMSS — used in filenames
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd {
            break;
        }
        days -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}",
        year,
        month + 1,
        days + 1,
        h,
        m,
        s
    )
}

fn iso_pretty(secs: u64) -> String {
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd {
            break;
        }
        days -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month + 1,
        days + 1,
        h,
        m,
        s
    )
}

fn list_recent_backups(dir: &PathBuf) -> Vec<String> {
    if !dir.exists() {
        return Vec::new();
    }
    let mut entries: Vec<(SystemTime, String)> = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mt = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            entries.push((mt, name.to_string()));
        }
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.into_iter().take(8).map(|(_, n)| n).collect()
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

pub fn settings_read_inner() -> Result<SettingsSnapshot, String> {
    let path = claude_settings_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read settings.json: {}", e))?;
    let content: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("parse settings.json: {}", e))?;
    let meta = fs::metadata(&path).ok();
    let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| iso_pretty(d.as_secs()))
        });
    let backup_dir = backups_dir().ok_or_else(|| "no HOME".to_string())?;
    let recent_backups = list_recent_backups(&backup_dir);

    Ok(SettingsSnapshot {
        path: path.to_string_lossy().to_string(),
        content,
        modified,
        size_bytes,
        backup_dir: backup_dir.to_string_lossy().to_string(),
        recent_backups,
    })
}

// ---------------------------------------------------------------------------
// Save (with timestamped backup)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct SettingsSavePayload {
    pub content: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
pub struct SettingsSaveResult {
    pub success: bool,
    pub backup_path: Option<String>,
    pub new_size_bytes: u64,
}

pub fn settings_save_inner(payload: SettingsSavePayload) -> Result<SettingsSaveResult, String> {
    // Refuse anything that isn't a JSON object at top level. settings.json
    // is an object per Claude Code's own schema; this catches accidental
    // serialization of a wrapping array or a scalar.
    if !payload.content.is_object() {
        return Err("settings.json root must be a JSON object".to_string());
    }

    let path = claude_settings_path().ok_or_else(|| "no HOME".to_string())?;
    let backup_dir = backups_dir().ok_or_else(|| "no HOME".to_string())?;
    if !backup_dir.exists() {
        fs::create_dir_all(&backup_dir).map_err(|e| format!("mkdir backups: {}", e))?;
    }

    // Backup current file (if any) before overwriting.
    let mut backup_path: Option<PathBuf> = None;
    if path.exists() {
        let stamp = iso_now_compact();
        let bk = backup_dir.join(format!("settings-{}.json", stamp));
        fs::copy(&path, &bk).map_err(|e| format!("backup copy: {}", e))?;
        backup_path = Some(bk);
    }

    // Pretty-print with 2-space indent for human readability when the user
    // edits the file directly later.
    let serialized =
        serde_json::to_string_pretty(&payload.content).map_err(|e| format!("serialize: {}", e))?;
    // Atomic-ish write via temp + rename.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;

    let new_size_bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(SettingsSaveResult {
        success: true,
        backup_path: backup_path.map(|p| p.to_string_lossy().to_string()),
        new_size_bytes,
    })
}
