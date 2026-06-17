// installed_apps/cache.rs — 1-hour disk cache for the installed-apps inventory.

#[cfg(target_os = "windows")]
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::types::InstalledApp;

#[cfg(target_os = "windows")]
pub(super) const CACHE_TTL_SECS: u64 = 3600; // 1 hour

#[cfg(target_os = "windows")]
#[derive(Debug, Serialize, Deserialize)]
pub(super) struct CachedSnapshot {
    pub apps: Vec<InstalledApp>,
    pub generated_at: String,
    /// Unix seconds when the cache was written. Used for TTL math.
    pub written_unix: u64,
}

#[cfg(target_os = "windows")]
pub(super) fn cache_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron/.tmp/installed-apps.json"))
        .ok_or_else(|| "no HOME dir".to_string())
}

#[cfg(target_os = "windows")]
pub(super) fn read_cache() -> Option<CachedSnapshot> {
    let path = cache_path().ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(target_os = "windows")]
pub(super) fn write_cache(apps: &[InstalledApp]) -> Result<(), String> {
    use super::ps_util::iso_now_utc;

    let path = cache_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir cache parent: {}", e))?;
    }
    let snapshot = CachedSnapshot {
        apps: apps.to_vec(),
        generated_at: iso_now_utc(),
        written_unix: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };
    let json = serde_json::to_string(&snapshot).map_err(|e| format!("encode cache: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("write cache: {}", e))?;
    Ok(())
}

#[cfg(target_os = "windows")]
pub(super) fn cache_fresh(snapshot: &CachedSnapshot) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now.saturating_sub(snapshot.written_unix) < CACHE_TTL_SECS
}
