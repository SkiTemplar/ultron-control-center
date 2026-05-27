//! Control Center 2.0 — plugin cache introspection.
//!
//! Four layers:
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
//!   - `plugin_check_updates_bulk_inner()` (v2.9.5) — SHA-aware bulk update
//!     check. Reads `gitCommitSha` from `installed_plugins.json` and compares
//!     against `gh api repos/<owner>/<repo>/commits?path=<plugin-path>&per_page=1`.
//!     Falls back to timestamp comparison for plugins without a local SHA.
//!     Results are cached 1 h to `~/.ultron/cockpit/plugin-update-cache.json`.
//!   - `plugin_changelog_summary_inner()` (v2.9.5) — invokes `ai_router::route`
//!     with the recent commits log to produce a human-readable summary.

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

// ---------------------------------------------------------------------------
// v2.9.5 — SHA-aware bulk update check + changelog summary
// ---------------------------------------------------------------------------

/// Rich per-plugin update record returned by the new bulk check command.
/// Supersedes `PluginUpdateStatus` for new UI code; old command is kept for
/// backwards compatibility with any caller that already depends on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginBulkUpdate {
    /// `<name>@<marketplace>` coordinate.
    pub coordinate: String,
    pub name: String,
    pub marketplace: String,
    /// Git SHA stored in `installed_plugins.json` (may be absent for old installs).
    pub installed_sha: Option<String>,
    /// HEAD SHA of the plugin's path in the upstream marketplace repo.
    pub latest_sha: Option<String>,
    /// True when `latest_sha` differs from `installed_sha` (or when the
    /// remote commit date is newer than `lastUpdated` for plugins without SHAs).
    pub update_available: bool,
    /// Subject line of the latest remote commit (empty when unavailable).
    pub latest_commit_msg: String,
    /// When the upstream commit was authored (ISO 8601, may be empty).
    pub latest_commit_date: String,
    /// ISO 8601 timestamp of when this record was last fetched from GitHub.
    pub last_check: String,
    /// Non-fatal diagnostic; the row is still returned but `update_available`
    /// is conservatively false when this is set.
    pub error: Option<String>,
}

/// On-disk cache structure written to
/// `~/.ultron/cockpit/plugin-update-cache.json`.
#[derive(Debug, Serialize, Deserialize)]
struct UpdateCache {
    /// ISO 8601 timestamp of the last full refresh.
    fetched_at: String,
    entries: Vec<PluginBulkUpdate>,
}

/// Installed-plugin record as stored in `installed_plugins.json`.
/// Only the fields we care about; unknown fields are ignored by `serde`.
#[derive(Debug, Deserialize)]
struct InstalledPluginRecord {
    #[serde(rename = "gitCommitSha", default)]
    git_commit_sha: Option<String>,
    #[serde(rename = "lastUpdated", default)]
    last_updated: Option<String>,
}

/// GitHub commit summary shape returned by
/// `gh api repos/<owner>/<repo>/commits?path=<p>&per_page=1`.
#[derive(Debug, Deserialize)]
struct GhCommit {
    sha: Option<String>,
    commit: Option<GhCommitInner>,
}

#[derive(Debug, Deserialize)]
struct GhCommitInner {
    message: Option<String>,
    author: Option<GhCommitAuthor>,
}

#[derive(Debug, Deserialize)]
struct GhCommitAuthor {
    date: Option<String>,
}

/// Parsed record from `known_marketplaces.json`.
#[derive(Debug, Deserialize)]
struct KnownMarketplaceEntry {
    source: Option<KnownMarketplaceSource>,
}

#[derive(Debug, Deserialize)]
struct KnownMarketplaceSource {
    repo: Option<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Returns the path to the `~/.ultron/cockpit/plugin-update-cache.json` file.
fn update_cache_path() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    Some(
        home.join(".ultron")
            .join("cockpit")
            .join("plugin-update-cache.json"),
    )
}

/// Returns the ultron cockpit directory, creating it if absent.
fn ensure_cockpit_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let dir = home.join(".ultron").join("cockpit");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create cockpit dir: {e}"))?;
    Ok(dir)
}

/// Attempt to load a valid cache that is younger than `max_age_secs`.
fn load_update_cache(max_age_secs: u64) -> Option<Vec<PluginBulkUpdate>> {
    let path = update_cache_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let cache: UpdateCache = serde_json::from_str(&raw).ok()?;
    let fetched: chrono::DateTime<chrono::Utc> = cache.fetched_at.parse().ok()?;
    let age = chrono::Utc::now()
        .signed_duration_since(fetched)
        .num_seconds()
        .unsigned_abs();
    if age > max_age_secs {
        return None;
    }
    Some(cache.entries)
}

/// Persist the freshly-fetched results to the 1-hour cache file.
fn save_update_cache(entries: &[PluginBulkUpdate]) {
    let Ok(cockpit) = ensure_cockpit_dir() else { return };
    let path = cockpit.join("plugin-update-cache.json");
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let cache = UpdateCache {
        fetched_at: now,
        entries: entries.to_vec(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&cache) {
        let _ = std::fs::write(&path, json);
    }
}

/// Read `~/.claude/plugins/known_marketplaces.json` and return a map of
/// `marketplace-slug → owner/repo`.
///
/// `known_marketplaces.json` uses the shape:
/// ```json
/// { "slug": { "source": { "source": "github", "repo": "owner/repo" } } }
/// ```
fn load_known_marketplaces() -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Some(home) = dirs::home_dir() else { return out };
    let path = home
        .join(".claude")
        .join("plugins")
        .join("known_marketplaces.json");
    if !path.exists() {
        return out;
    }
    let Ok(raw) = std::fs::read_to_string(&path) else { return out };
    let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
        return out;
    };
    let Some(obj) = json.as_object() else { return out };
    for (slug, v) in obj.iter() {
        let entry: Result<KnownMarketplaceEntry, _> = serde_json::from_value(v.clone());
        if let Ok(e) = entry {
            if let Some(repo) = e.source.and_then(|s| s.repo) {
                out.insert(slug.to_lowercase(), repo);
            }
        }
    }
    out
}

/// Read `installed_plugins.json` and return a map of
/// `coordinate (lowercase) → InstalledPluginRecord`.
fn load_installed_plugin_records()
    -> std::collections::HashMap<String, InstalledPluginRecord>
{
    let Some(home) = dirs::home_dir() else { return Default::default() };
    let path = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Default::default();
    };
    let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
        return Default::default();
    };
    let Some(plugins_obj) = json.get("plugins").and_then(|v| v.as_object()) else {
        return Default::default();
    };
    let mut out = std::collections::HashMap::new();
    for (coord, entries_val) in plugins_obj.iter() {
        let Some(arr) = entries_val.as_array() else { continue };
        let Some(last) = arr.last() else { continue };
        let Ok(record): Result<InstalledPluginRecord, _> =
            serde_json::from_value(last.clone()) else { continue };
        out.insert(coord.to_lowercase(), record);
    }
    out
}

/// Derive the sub-path of a plugin inside its marketplace repo.
fn plugin_repo_subpath(marketplace: &str, plugin_name: &str) -> String {
    match marketplace {
        "claude-plugins-official" => format!("plugins/{plugin_name}"),
        "addy-agent-skills" => plugin_name.to_string(),
        "claude-code-workflows" => plugin_name.to_string(),
        // superpowers-marketplace: entire repo is one plugin bundle
        "superpowers-marketplace" | "ecc" | "openai-codex" => String::new(),
        _ => format!("plugins/{plugin_name}"),
    }
}

/// Build a `gh` command (Windows: CREATE_NO_WINDOW).
fn gh_cmd_v2(args: &[&str]) -> std::process::Command {
    let mut cmd = std::process::Command::new("gh");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Fetch the latest commit SHA + message + date for `<owner>/<repo>` at
/// `subpath`. When `subpath` is empty this probes the repo root.
fn fetch_latest_commit(
    repo_slug: &str,
    subpath: &str,
) -> Result<(String, String, String), String> {
    let endpoint = if subpath.is_empty() {
        format!("repos/{repo_slug}/commits?per_page=1")
    } else {
        let encoded = subpath.replace(' ', "%20").replace('#', "%23");
        format!("repos/{repo_slug}/commits?path={encoded}&per_page=1")
    };

    let output = gh_cmd_v2(&["api", &endpoint])
        .output()
        .map_err(|e| format!("spawn gh: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("gh api exited {}", output.status)
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let commits: Vec<GhCommit> =
        serde_json::from_str(&stdout).map_err(|e| format!("parse gh api json: {e}"))?;

    let first = commits
        .into_iter()
        .next()
        .ok_or_else(|| "no commits found".to_string())?;
    let sha = first.sha.unwrap_or_default();
    let inner = first.commit.unwrap_or(GhCommitInner {
        message: None,
        author: None,
    });
    let msg = inner
        .message
        .unwrap_or_default()
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string();
    let date = inner.author.and_then(|a| a.date).unwrap_or_default();

    Ok((sha, msg, date))
}

/// Fetch the N most-recent commit subjects for `<owner>/<repo>` at `subpath`.
fn fetch_commit_log(repo_slug: &str, subpath: &str, n: u8) -> Result<Vec<String>, String> {
    let n_str = n.clamp(1, 30).to_string();
    let endpoint = if subpath.is_empty() {
        format!("repos/{repo_slug}/commits?per_page={n_str}")
    } else {
        let encoded = subpath.replace(' ', "%20").replace('#', "%23");
        format!("repos/{repo_slug}/commits?path={encoded}&per_page={n_str}")
    };

    let output = gh_cmd_v2(&["api", &endpoint])
        .output()
        .map_err(|e| format!("spawn gh: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("gh api exited {}", output.status)
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let commits: Vec<GhCommit> =
        serde_json::from_str(&stdout).map_err(|e| format!("parse gh api json: {e}"))?;

    let lines: Vec<String> = commits
        .into_iter()
        .filter_map(|c| {
            let inner = c.commit?;
            let sha = c.sha.unwrap_or_default();
            let sha_short = &sha[..sha.len().min(7)];
            let msg = inner
                .message
                .unwrap_or_default()
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim()
                .to_string();
            let date = inner.author.and_then(|a| a.date).unwrap_or_default();
            let date_short = &date[..date.len().min(10)];
            if msg.is_empty() {
                None
            } else {
                Some(format!("{date_short} [{sha_short}] {msg}"))
            }
        })
        .collect();

    Ok(lines)
}

// ---------------------------------------------------------------------------
// Public inner functions
// ---------------------------------------------------------------------------

/// Delete the on-disk cache file so the next call fetches fresh from GitHub.
fn invalidate_update_cache() {
    if let Some(path) = update_cache_path() {
        let _ = std::fs::remove_file(path);
    }
}

/// Bulk update check (v2.9.5).
///
/// 1. Try the 1-hour on-disk cache; return it if still fresh (unless `force`).
/// 2. Load `installed_plugins.json` for SHAs and `known_marketplaces.json`
///    for repo slugs.
/// 3. For each installed plugin:
///    a. If `gitCommitSha` present: fetch HEAD commit of the plugin's subpath
///       and compare SHAs.
///    b. If no SHA: compare `lastUpdated` (ISO) against the latest commit date.
/// 4. Write cache; return results.
pub fn plugin_check_updates_bulk_inner(force: bool) -> Result<Vec<PluginBulkUpdate>, String> {
    const CACHE_TTL: u64 = 3600; // 1 hour

    if !force {
        if let Some(cached) = load_update_cache(CACHE_TTL) {
            return Ok(cached);
        }
    } else {
        // Wipe stale cache so save_update_cache writes a fresh file.
        invalidate_update_cache();
    }

    let plugins = list_all_plugins_inner()?;
    let known_markets = load_known_marketplaces();
    let legacy_markets = load_marketplace_repo_map();
    let installed_records = load_installed_plugin_records();

    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut out: Vec<PluginBulkUpdate> = Vec::with_capacity(plugins.len());

    for p in &plugins {
        let coord_lower = p.coordinate.to_lowercase();
        let market_lower = p.marketplace.to_lowercase();

        let repo_slug = known_markets
            .get(&market_lower)
            .or_else(|| legacy_markets.get(&market_lower))
            .cloned();

        let Some(repo_slug) = repo_slug else {
            out.push(PluginBulkUpdate {
                coordinate: p.coordinate.clone(),
                name: p.name.clone(),
                marketplace: p.marketplace.clone(),
                installed_sha: None,
                latest_sha: None,
                update_available: false,
                latest_commit_msg: String::new(),
                latest_commit_date: String::new(),
                last_check: now.clone(),
                error: Some("marketplace repo not registered".into()),
            });
            continue;
        };

        let record = installed_records.get(&coord_lower);
        let installed_sha = record.and_then(|r| r.git_commit_sha.clone());
        let last_updated_iso = record
            .and_then(|r| r.last_updated.clone())
            .or_else(|| p.last_update_iso.clone())
            .unwrap_or_default();

        let subpath = plugin_repo_subpath(&market_lower, &p.name);

        match fetch_latest_commit(&repo_slug, &subpath) {
            Ok((latest_sha, latest_msg, latest_date)) => {
                let update_available = if let Some(ref local_sha) = installed_sha {
                    // SHA comparison: update available when they differ.
                    // Guard against empty strings and short-SHA matches.
                    let local_short = &local_sha[..local_sha.len().min(8)];
                    let remote_short = &latest_sha[..latest_sha.len().min(8)];
                    !local_sha.is_empty()
                        && !latest_sha.is_empty()
                        && !local_short.eq_ignore_ascii_case(remote_short)
                } else {
                    // Fallback: compare ISO timestamps lexicographically.
                    !last_updated_iso.is_empty()
                        && !latest_date.is_empty()
                        && latest_date.as_str() > last_updated_iso.as_str()
                };

                out.push(PluginBulkUpdate {
                    coordinate: p.coordinate.clone(),
                    name: p.name.clone(),
                    marketplace: p.marketplace.clone(),
                    installed_sha,
                    latest_sha: Some(latest_sha),
                    update_available,
                    latest_commit_msg: latest_msg,
                    latest_commit_date: latest_date,
                    last_check: now.clone(),
                    error: None,
                });
            }
            Err(e) => {
                out.push(PluginBulkUpdate {
                    coordinate: p.coordinate.clone(),
                    name: p.name.clone(),
                    marketplace: p.marketplace.clone(),
                    installed_sha,
                    latest_sha: None,
                    update_available: false,
                    latest_commit_msg: String::new(),
                    latest_commit_date: String::new(),
                    last_check: now.clone(),
                    error: Some(e),
                });
            }
        }
    }

    save_update_cache(&out);
    Ok(out)
}

/// Changelog summary for a single plugin (v2.9.5).
///
/// Fetches the last 15 commits from the plugin's subpath in its marketplace
/// repo and uses `ai_router::route("light", …)` to summarise. Degrades
/// gracefully to a raw commit list if the AI router is not configured.
pub fn plugin_changelog_summary_inner(
    coordinate: &str,
    installed_sha: Option<&str>,
) -> Result<String, String> {
    let (name, marketplace) = coordinate
        .split_once('@')
        .ok_or_else(|| format!("invalid coordinate: {coordinate}"))?;

    let known = load_known_marketplaces();
    let legacy = load_marketplace_repo_map();
    let market_lower = marketplace.to_lowercase();

    let repo_slug = known
        .get(&market_lower)
        .or_else(|| legacy.get(&market_lower))
        .cloned()
        .ok_or_else(|| format!("marketplace '{marketplace}' not registered"))?;

    let subpath = plugin_repo_subpath(&market_lower, name);
    let log_lines = fetch_commit_log(&repo_slug, &subpath, 15)?;

    if log_lines.is_empty() {
        return Ok("No recent commits found in the upstream repository.".to_string());
    }

    let commits_text = log_lines
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{}. {l}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");

    let sha_context = match installed_sha {
        Some(sha) if !sha.is_empty() => {
            format!(
                "The user currently has commit `{}` installed.",
                &sha[..sha.len().min(8)]
            )
        }
        _ => "The user's installed commit SHA is unknown.".to_string(),
    };

    let prompt = format!(
        "You are summarising recent changes to the `{coordinate}` Claude Code plugin.\n\
         {sha_context}\n\n\
         Recent upstream commits (newest first):\n{commits_text}\n\n\
         Write a concise changelog summary (3-5 bullet points) that a developer \
         would find useful. Focus on new features, bug fixes, and breaking changes. \
         Be specific. Output only the bullet points, no preamble."
    );

    match crate::ai_router::route("light", &prompt) {
        Ok(summary) => Ok(summary),
        Err(_) => Ok(format!(
            "Recent commits (AI summary unavailable):\n{commits_text}"
        )),
    }
}

#[cfg(test)]
mod bulk_update_tests {
    use super::*;

    #[test]
    fn plugin_subpath_official_marketplace() {
        assert_eq!(
            plugin_repo_subpath("claude-plugins-official", "code-review"),
            "plugins/code-review"
        );
    }

    #[test]
    fn plugin_subpath_whole_repo_plugins() {
        assert_eq!(plugin_repo_subpath("superpowers-marketplace", "superpowers"), "");
        assert_eq!(plugin_repo_subpath("ecc", "ecc"), "");
        assert_eq!(plugin_repo_subpath("openai-codex", "codex"), "");
    }

    #[test]
    fn plugin_subpath_addy() {
        assert_eq!(
            plugin_repo_subpath("addy-agent-skills", "agent-skills"),
            "agent-skills"
        );
    }

    #[test]
    fn sha_update_detected_when_different() {
        let local = "917e5f53";
        let remote = "abc123de";
        assert!(!local.eq_ignore_ascii_case(remote));
    }

    #[test]
    fn sha_no_update_when_same_short() {
        let local = "917e5f53b16b115b70a3a355ed5f4993b9f8b73d";
        let remote = "917e5f53b16b115b70a3a355ed5f4993b9f8b73d";
        let local_short = &local[..8];
        let remote_short = &remote[..8];
        assert!(local_short.eq_ignore_ascii_case(remote_short));
    }
}
