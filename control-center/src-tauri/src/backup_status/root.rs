// backup_status/root.rs — backup-root resolution, same-volume guard and the
// write-lock of backup-config.json.
//
// All items are pub(super) so backup_status.rs can use them directly.

use std::fs;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{Mutex, OnceLock};

// ---------------------------------------------------------------------------
// Process-wide write lock for backup-config.json
// ---------------------------------------------------------------------------
//
// `set_backup_sources_inner` does a read-modify-write of backup-config.json.
// Without a lock, two concurrent callers can interleave and one writer
// clobbers the other's changes silently. The lock is held across the full
// read → mutate → atomic-write cycle. Same pattern as
// `sessions_tags::SESSIONS_TAGS_WRITE_LOCK`. Pure reads are excluded.
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

/// Configured backup destination, or `None` when nothing is configured.
///
/// Resolution order MUST match `scripts/backup/weekly-backup.{ps1,sh}`:
///   1. ~/.ultron/.tmp/backup-root.txt (Settings → Backups writes it)
///   2. $ULTRON_BACKUP_ROOT
///   3. nothing: the script aborts with exit 2 and status `failed`.
///
/// 2026-10-23 (audit N1): the "D:\BACKUP if mounted" and "%USERPROFILE%\BACKUP"
/// fallbacks were removed. With D: unplugged the script mirrored the sources
/// onto the same disk with exit 0, and this function reported that folder.
pub(super) fn backup_root() -> Option<PathBuf> {
    if let Some(s) = read_configured_backup_root() {
        return Some(PathBuf::from(s));
    }
    std::env::var("ULTRON_BACKUP_ROOT")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Volume identity by path prefix: `c:` for `C:\...`, `\\server\share` for
/// UNC. Same rule as `Get-VolumeKey` in weekly-backup.ps1 (a subst drive or
/// a mount point inside C: is not detected). `None` when the path has no
/// prefix (relative path, or any path on a non-Windows host).
pub(super) fn volume_key(path: &Path) -> Option<String> {
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return None;
    };
    let key = match prefix.kind() {
        Prefix::Disk(d) | Prefix::VerbatimDisk(d) => {
            format!("{}:", (d as char).to_ascii_lowercase())
        }
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => format!(
            r"\\{}\{}",
            server.to_string_lossy().to_lowercase(),
            share.to_string_lossy().to_lowercase()
        ),
        _ => return None,
    };
    Some(key)
}

/// Names of the sources (`(name, absolute path)`) that live on the same
/// volume as `dest`. Empty when the volume of `dest` is unknown.
pub(super) fn same_volume_sources(dest: &Path, sources: &[(String, PathBuf)]) -> Vec<String> {
    let Some(dest_key) = volume_key(dest) else {
        return Vec::new();
    };
    sources
        .iter()
        .filter(|(_, abs)| volume_key(abs).as_deref() == Some(dest_key.as_str()))
        .map(|(name, _)| name.clone())
        .collect()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn src(name: &str, abs: &str) -> (String, PathBuf) {
        (name.to_string(), PathBuf::from(abs))
    }

    #[test]
    fn volume_key_ignores_case_and_handles_unc() {
        assert_eq!(volume_key(Path::new(r"D:\BACKUP")).as_deref(), Some("d:"));
        assert_eq!(volume_key(Path::new(r"d:\otro")).as_deref(), Some("d:"));
        assert_eq!(
            volume_key(Path::new(r"\\NAS\Copias\ultron")).as_deref(),
            Some(r"\\nas\copias")
        );
        assert_eq!(volume_key(Path::new("relativa")), None);
    }

    #[test]
    fn a_destination_on_the_sources_disk_is_reported() {
        let sources = vec![src(".ultron", r"C:\Users\u\.ultron"), src("TFG", r"E:\TFG")];
        let clash = same_volume_sources(Path::new(r"c:\Users\u\BACKUP"), &sources);
        assert_eq!(clash, vec![".ultron".to_string()]);
    }

    #[test]
    fn a_destination_on_another_disk_is_fine() {
        let sources = vec![src(".ultron", r"C:\Users\u\.ultron")];
        assert!(same_volume_sources(Path::new(r"D:\BACKUP"), &sources).is_empty());
    }
}
