// plugins_info/cache.rs — full plugin enumeration and uninstall. Also holds
// the shared filesystem helpers used by the other sub-modules.
// Higiene 2026-08-11 (audit 08-09 #45): read_plugin_info_inner (probe legacy
// de un solo plugin, hardcodeado a ecc/ecc) borrado — superseded por
// list_all_plugins_inner.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::types::PluginEntry;

// ---------------------------------------------------------------------------
// Public inner functions
// ---------------------------------------------------------------------------

/// Enumerate every plugin installed in `~/.claude/plugins/cache/`.
///
/// The expected layout is:
///   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
/// We pick the most-recently-modified version dir per plugin, mirror its
/// contents into the per-component counts, and cross-reference
/// installed_plugins.json so the UI can show an "active" badge.
pub fn list_all_plugins_inner() -> Result<Vec<PluginEntry>, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let cache = home.join(".claude").join("plugins").join("cache");
    let manifest = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");

    let installed_set = read_installed_manifest(&manifest);

    let mut out: Vec<PluginEntry> = Vec::new();
    if !cache.exists() {
        return Ok(out);
    }
    let market_dirs = std::fs::read_dir(&cache)
        .map_err(|e| format!("read cache: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir());
    for market in market_dirs {
        let marketplace = market.file_name().to_string_lossy().to_string();
        let market_path = market.path();
        let plugin_dirs = match std::fs::read_dir(&market_path) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for plugin in plugin_dirs
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
        {
            let name = plugin.file_name().to_string_lossy().to_string();
            // Pick latest version dir by mtime.
            let plugin_path = plugin.path();
            let mut versions: Vec<(PathBuf, SystemTime)> = match std::fs::read_dir(&plugin_path) {
                Ok(rd) => rd
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .filter_map(|e| {
                        let p = e.path();
                        let m = e.metadata().ok()?.modified().ok()?;
                        Some((p, m))
                    })
                    .collect(),
                Err(_) => continue,
            };
            versions.sort_by_key(|b| std::cmp::Reverse(b.1));
            let Some((root, mtime)) = versions.into_iter().next() else {
                continue;
            };
            let version = root
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();
            let coordinate = format!("{name}@{marketplace}");
            let installed = installed_set
                .iter()
                .any(|s| s.eq_ignore_ascii_case(&coordinate));
            out.push(PluginEntry {
                name: name.clone(),
                marketplace: marketplace.clone(),
                coordinate,
                version,
                root: root.display().to_string(),
                installed,
                last_update_iso: mtime_to_iso(mtime),
                skills_count: count_subdirs_with(&root.join("skills"), "SKILL.md"),
                agents_count: count_files_matching(&root.join("agents"), "md"),
                hooks_count: count_files_matching(&root.join("hooks"), "json"),
                mcp_servers_count: count_mcp_servers(&root),
            });
        }
    }

    // Stable order: marketplace then plugin name.
    out.sort_by(|a, b| {
        a.marketplace
            .to_lowercase()
            .cmp(&b.marketplace.to_lowercase())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Recursively removes the cache directory for one plugin/version. Best-effort:
/// the caller still has to ask Claude Code to re-resolve. Used by the
/// uninstall button.
pub fn uninstall_plugin_cache_inner(name: &str, marketplace: &str) -> Result<(), String> {
    let name = name.trim();
    let marketplace = marketplace.trim();
    if name.is_empty() || marketplace.is_empty() {
        return Err("plugin name and marketplace required".into());
    }
    // Guard against path-traversal — these are slugs, not paths.
    if name.contains(['/', '\\', '.']) || marketplace.contains(['/', '\\']) {
        return Err("invalid plugin or marketplace slug".into());
    }
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let dir = home
        .join(".claude")
        .join("plugins")
        .join("cache")
        .join(marketplace)
        .join(name);
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))
}

// ---------------------------------------------------------------------------
// Shared filesystem helpers (pub(super) — visible to sibling sub-modules)
// ---------------------------------------------------------------------------

pub(super) fn read_installed_manifest(path: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
        return Vec::new();
    };
    let Some(obj) = json.get("plugins").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    obj.keys().cloned().collect()
}

pub(super) fn count_subdirs_with(dir: &std::path::Path, child: &str) -> usize {
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir() && e.path().join(child).exists())
                .count()
        })
        .unwrap_or(0)
}

pub(super) fn count_files_matching(dir: &std::path::Path, ext: &str) -> usize {
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some(ext))
                .count()
        })
        .unwrap_or(0)
}

pub(super) fn count_mcp_servers(root: &std::path::Path) -> usize {
    let p = root.join("mcp-configs").join("mcp-servers.json");
    let Ok(txt) = std::fs::read_to_string(&p) else {
        return 0;
    };
    let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&txt) else {
        return 0;
    };
    json.get("mcpServers")
        .and_then(|v| v.as_object())
        .map(|m| m.len())
        .unwrap_or_else(|| json.as_object().map(|m| m.len()).unwrap_or(0))
}

pub(super) fn mtime_to_iso(t: SystemTime) -> Option<String> {
    let dt: chrono::DateTime<chrono::Utc> = t.into();
    Some(dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}
