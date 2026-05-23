//! Control Center 2.0 — plugin cache introspection.
//!
//! Two layers:
//!   - `read_plugin_info_inner()` — legacy single-plugin probe used by the
//!     original Settings panel; still returns ECC counts so anything that
//!     relied on it keeps working.
//!   - `list_all_plugins_inner()` — full enumeration of
//!     `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` plus the
//!     `~/.claude/plugins/installed_plugins.json` manifest. Returns a flat
//!     list with per-plugin counts and the canonical `<plugin>@<market>`
//!     coordinate so the UI can render install/update/uninstall buttons
//!     without re-implementing the cache layout.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub root: Option<String>,
    pub last_update_iso: Option<String>,
    pub skills_count: usize,
    pub agents_count: usize,
    pub hooks_count: usize,
    pub mcp_servers_count: usize,
}

/// Single row for the Plugins panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginEntry {
    /// Plugin slug (e.g. "ecc", "superpowers", "code-review").
    pub name: String,
    /// Marketplace slug (e.g. "ecc", "superpowers-marketplace",
    /// "claude-plugins-official").
    pub marketplace: String,
    /// Canonical "<name>@<marketplace>" coordinate used by `/plugin install`.
    pub coordinate: String,
    /// Version dir name (e.g. "2.0.0-rc.1", "1.0.0", "unknown").
    pub version: String,
    /// Absolute path to the version directory.
    pub root: String,
    /// True when installed_plugins.json mentions this plugin (the cache dir
    /// may exist without an active install if the user ran /plugin uninstall
    /// but Claude Code hasn't pruned the bytes yet).
    pub installed: bool,
    /// ISO of the version dir's mtime — the closest thing to "last updated".
    pub last_update_iso: Option<String>,
    pub skills_count: usize,
    pub agents_count: usize,
    pub hooks_count: usize,
    pub mcp_servers_count: usize,
}

pub fn read_plugin_info_inner() -> Result<PluginInfo, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let base = home
        .join(".claude")
        .join("plugins")
        .join("cache")
        .join("ecc")
        .join("ecc");
    if !base.exists() {
        return Ok(PluginInfo {
            installed: false,
            version: None,
            root: None,
            last_update_iso: None,
            skills_count: 0,
            agents_count: 0,
            hooks_count: 0,
            mcp_servers_count: 0,
        });
    }
    let mut versions: Vec<(PathBuf, SystemTime)> = std::fs::read_dir(&base)
        .map_err(|e| format!("read base: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let p = e.path();
            let m = e.metadata().ok()?.modified().ok()?;
            Some((p, m))
        })
        .collect();
    versions.sort_by(|a, b| b.1.cmp(&a.1));
    let Some((root, mtime)) = versions.into_iter().next() else {
        return Ok(PluginInfo {
            installed: false,
            version: None,
            root: Some(base.display().to_string()),
            last_update_iso: None,
            skills_count: 0,
            agents_count: 0,
            hooks_count: 0,
            mcp_servers_count: 0,
        });
    };

    let version = root
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());

    let skills_count = count_subdirs_with(&root.join("skills"), "SKILL.md");
    let agents_count = count_files_matching(&root.join("agents"), "md");
    let hooks_count = count_files_matching(&root.join("hooks"), "json");
    let mcp_servers_count = count_mcp_servers(&root);

    let last_update_iso = mtime_to_iso(mtime);

    Ok(PluginInfo {
        installed: true,
        version,
        root: Some(root.display().to_string()),
        last_update_iso,
        skills_count,
        agents_count,
        hooks_count,
        mcp_servers_count,
    })
}

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
    let manifest = home.join(".claude").join("plugins").join("installed_plugins.json");

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
        for plugin in plugin_dirs.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()) {
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
            versions.sort_by(|a, b| b.1.cmp(&a.1));
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
    std::fs::remove_dir_all(&dir)
        .map_err(|e| format!("remove {}: {e}", dir.display()))
}

fn read_installed_manifest(path: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
        return Vec::new();
    };
    let Some(obj) = json.get("plugins").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    obj.keys().cloned().collect()
}

fn count_subdirs_with(dir: &std::path::Path, child: &str) -> usize {
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

fn count_files_matching(dir: &std::path::Path, ext: &str) -> usize {
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

fn count_mcp_servers(root: &std::path::Path) -> usize {
    let p = root.join("mcp-configs").join("mcp-servers.json");
    let Ok(txt) = std::fs::read_to_string(&p) else { return 0 };
    let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&txt) else { return 0 };
    json.get("mcpServers")
        .and_then(|v| v.as_object())
        .map(|m| m.len())
        .unwrap_or_else(|| json.as_object().map(|m| m.len()).unwrap_or(0))
}

fn mtime_to_iso(t: SystemTime) -> Option<String> {
    let dt: chrono::DateTime<chrono::Utc> = t.into();
    Some(dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}
