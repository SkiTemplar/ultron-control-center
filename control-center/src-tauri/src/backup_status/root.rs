// backup_status/root.rs — backup-root resolution and write-lock.
//
// Extracted from backup_status.rs (refactor only, no logic changes).
// All items are pub(super) so backup_status.rs can use them directly.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

// ---------------------------------------------------------------------------
// Process-wide write lock for backup-config.json
// ---------------------------------------------------------------------------
//
// `set_backup_sources_inner` and `set_backup_schedule_inner` both do a
// read-modify-write of the same file (backup-config.json). Without a lock,
// two concurrent callers (e.g. the UI saving sources while another request
// saves the schedule) can interleave, causing one writer to clobber the
// other's changes silently. The lock is held across the full read → mutate →
// atomic-write cycle. Same pattern as `sessions_tags::SESSIONS_TAGS_WRITE_LOCK`
// / `kg::kg_write_lock` / `workdays::workday_lock`. Pure reads are excluded.
static BACKUP_CONFIG_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) fn backup_config_lock() -> &'static Mutex<()> {
    BACKUP_CONFIG_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

pub(super) fn backup_root_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/.tmp/backup-root.txt"))
}

pub(super) fn read_configured_backup_root() -> Option<String> {
    let path = backup_root_config_path()?;
    let s = fs::read_to_string(&path).ok()?;
    let trimmed = s.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

pub(super) fn backup_root() -> PathBuf {
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
    // 3. D:\BACKUP if available (common secondary-drive convention, v15.1.6)
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
