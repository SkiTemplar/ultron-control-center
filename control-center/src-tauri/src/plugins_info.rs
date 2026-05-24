//! Control Center 2.0 — plugin cache introspection.
//!
//! Three layers:
//!   - `read_plugin_info_inner()` — legacy single-plugin probe used by the
//!     original Settings panel; still returns ECC counts so anything that
//!     relied on it keeps working.
//!   - `list_all_plugins_inner()` — full enumeration of
//!     `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` plus the
//!     `~/.claude/plugins/installed_plugins.json` manifest. Returns a flat
//!     list with per-plugin counts and the canonical `<plugin>@<market>`
//!     coordinate so the UI can render install/update/uninstall buttons
//!     without re-implementing the cache layout.
//!   - `check_plugin_updates_inner()` (v2.6 fb-022) — for each installed
//!     plugin, asks `gh` for the marketplace repo's `pushed_at`. If that
//!     timestamp is newer than the local cache mtime, the plugin is flagged
//!     `update_available`. Returns one row per known plugin so the UI can
//!     paint badges.

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

// ---------------------------------------------------------------------------
// v2.6 fb-022 — plugin update check via `gh repo view`
// ---------------------------------------------------------------------------

/// Result of a single plugin update probe. The UI uses
/// `update_available` to draw a badge and `remote_pushed_iso` to display
/// the upstream "last updated" stamp next to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginUpdateStatus {
    pub name: String,
    pub marketplace: String,
    pub coordinate: String,
    /// Local cache mtime (ISO 8601) — same value as `PluginEntry.last_update_iso`.
    pub local_iso: Option<String>,
    /// Remote `pushed_at` reported by `gh repo view --json pushedAt`.
    pub remote_pushed_iso: Option<String>,
    /// True when the marketplace repo was pushed after the local cache.
    pub update_available: bool,
    /// Optional error string (gh failed, marketplace not resolvable, etc.).
    /// When set, `update_available` is false and the row is treated as
    /// "unknown" by the UI.
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MarketplaceRegistryEntry {
    /// `installed_plugins.json` and `marketplaces.json` both use `repo` as the
    /// `owner/name` slug.
    #[serde(default)]
    repo: Option<String>,
    /// Some legacy entries used `repository` instead.
    #[serde(default)]
    repository: Option<String>,
    /// A few marketplaces expose just a URL — we accept it as a fallback.
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhRepoView {
    #[serde(rename = "pushedAt")]
    pushed_at: Option<String>,
}

fn gh_for_update(args: &[&str]) -> std::process::Command {
    let mut cmd = std::process::Command::new("gh");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — keeps subprocess invisible (matches library.rs).
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Reads `~/.claude/plugins/marketplaces.json` (or any sibling file the
/// user has) and builds a `marketplace-slug → owner/repo` map.
///
/// The marketplace file is a JSON object whose top-level keys are
/// marketplace slugs (`ecc`, `superpowers-marketplace`, …) and whose values
/// carry a `repo` field. We are intentionally permissive — Claude Code's
/// real format has drifted between versions and the rest of the file
/// (auth, sources, …) is none of our business.
fn load_marketplace_repo_map() -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Some(home) = dirs::home_dir() else { return out };
    let candidates = [
        home.join(".claude").join("plugins").join("marketplaces.json"),
        home.join(".claude").join("plugins").join("registry.json"),
    ];
    for path in candidates.iter() {
        if !path.exists() {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(path) else { continue };
        let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
            continue;
        };
        // Two layouts seen in the wild: `{ marketplaces: { slug: { repo } } }`
        // and the flat `{ slug: { repo } }`. Handle both.
        let root = json
            .get("marketplaces")
            .and_then(|v| v.as_object())
            .or_else(|| json.as_object());
        let Some(root) = root else { continue };
        for (slug, v) in root.iter() {
            let entry: MarketplaceRegistryEntry =
                match serde_json::from_value(v.clone()) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
            let repo = entry
                .repo
                .or(entry.repository)
                .or_else(|| entry.url.and_then(extract_owner_repo_from_url));
            if let Some(r) = repo {
                out.insert(slug.to_lowercase(), r);
            }
        }
    }
    out
}

fn extract_owner_repo_from_url(url: String) -> Option<String> {
    // Accepts https://github.com/owner/repo[.git] and github.com:owner/repo.
    let lower = url.to_lowercase();
    let needle = "github.com";
    let idx = lower.find(needle)?;
    let rest = &url[idx + needle.len()..];
    let rest = rest.trim_start_matches(['/', ':']);
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() < 2 {
        return None;
    }
    let owner = parts[0];
    let repo_raw = parts[1];
    let repo = repo_raw.trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

/// For every installed plugin, ask `gh` for the marketplace repo's
/// `pushedAt`. Compare against the local cache mtime and flag updates.
///
/// We swallow per-row failures so one broken plugin can't kill the whole
/// scan — the offending row just gets `update_available = false` and an
/// `error` string.
pub fn check_plugin_updates_inner() -> Result<Vec<PluginUpdateStatus>, String> {
    let plugins = list_all_plugins_inner()?;
    let market_map = load_marketplace_repo_map();
    let mut out: Vec<PluginUpdateStatus> = Vec::with_capacity(plugins.len());

    for p in plugins {
        let local_iso = p.last_update_iso.clone();
        let market_key = p.marketplace.to_lowercase();
        let Some(repo_slug) = market_map.get(&market_key).cloned() else {
            out.push(PluginUpdateStatus {
                name: p.name,
                marketplace: p.marketplace,
                coordinate: p.coordinate,
                local_iso,
                remote_pushed_iso: None,
                update_available: false,
                error: Some("marketplace repo not registered locally".into()),
            });
            continue;
        };

        let output = gh_for_update(&[
            "repo",
            "view",
            &repo_slug,
            "--json",
            "pushedAt",
        ])
        .output();

        match output {
            Ok(o) if o.status.success() => {
                let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                let parsed: Result<GhRepoView, _> = serde_json::from_str(&stdout);
                match parsed {
                    Ok(v) => {
                        let remote_iso = v.pushed_at.clone();
                        let update_available = match (&remote_iso, &local_iso) {
                            (Some(r), Some(l)) => r.as_str() > l.as_str(),
                            _ => false,
                        };
                        out.push(PluginUpdateStatus {
                            name: p.name,
                            marketplace: p.marketplace,
                            coordinate: p.coordinate,
                            local_iso,
                            remote_pushed_iso: remote_iso,
                            update_available,
                            error: None,
                        });
                    }
                    Err(e) => out.push(PluginUpdateStatus {
                        name: p.name,
                        marketplace: p.marketplace,
                        coordinate: p.coordinate,
                        local_iso,
                        remote_pushed_iso: None,
                        update_available: false,
                        error: Some(format!("parse gh json: {e}")),
                    }),
                }
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
                out.push(PluginUpdateStatus {
                    name: p.name,
                    marketplace: p.marketplace,
                    coordinate: p.coordinate,
                    local_iso,
                    remote_pushed_iso: None,
                    update_available: false,
                    error: Some(if stderr.is_empty() {
                        format!("gh exited {}", o.status)
                    } else {
                        stderr
                    }),
                });
            }
            Err(e) => out.push(PluginUpdateStatus {
                name: p.name,
                marketplace: p.marketplace,
                coordinate: p.coordinate,
                local_iso,
                remote_pushed_iso: None,
                update_available: false,
                error: Some(format!("spawn gh: {e}")),
            }),
        }
    }

    Ok(out)
}
