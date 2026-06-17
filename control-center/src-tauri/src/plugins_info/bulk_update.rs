// plugins_info/bulk_update.rs — v2.9.5 SHA-aware bulk update check and
// AI-powered changelog summary.

use serde::{Deserialize, Serialize};

use super::cache::list_all_plugins_inner;
use super::types::PluginBulkUpdate;
use super::update_check::load_marketplace_repo_map;

// ---------------------------------------------------------------------------
// Private types
// ---------------------------------------------------------------------------

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
// Cache helpers
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
    std::fs::create_dir_all(&dir).map_err(|e| format!("create cockpit dir: {e}"))?;
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
    let Ok(cockpit) = ensure_cockpit_dir() else {
        return;
    };
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

/// Delete the on-disk cache file so the next call fetches fresh from GitHub.
fn invalidate_update_cache() {
    if let Some(path) = update_cache_path() {
        let _ = std::fs::remove_file(path);
    }
}

// ---------------------------------------------------------------------------
// Marketplace registry helpers
// ---------------------------------------------------------------------------

/// Read `~/.claude/plugins/known_marketplaces.json` and return a map of
/// `marketplace-slug → owner/repo`.
///
/// `known_marketplaces.json` uses the shape:
/// ```json
/// { "slug": { "source": { "source": "github", "repo": "owner/repo" } } }
/// ```
fn load_known_marketplaces() -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let path = home
        .join(".claude")
        .join("plugins")
        .join("known_marketplaces.json");
    if !path.exists() {
        return out;
    }
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return out;
    };
    let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
        return out;
    };
    let Some(obj) = json.as_object() else {
        return out;
    };
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
fn load_installed_plugin_records() -> std::collections::HashMap<String, InstalledPluginRecord> {
    let Some(home) = dirs::home_dir() else {
        return Default::default();
    };
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
        let Some(arr) = entries_val.as_array() else {
            continue;
        };
        let Some(last) = arr.last() else { continue };
        let Ok(record): Result<InstalledPluginRecord, _> = serde_json::from_value(last.clone())
        else {
            continue;
        };
        out.insert(coord.to_lowercase(), record);
    }
    out
}

/// Derive the sub-path of a plugin inside its marketplace repo.
pub(super) fn plugin_repo_subpath(marketplace: &str, plugin_name: &str) -> String {
    match marketplace {
        "claude-plugins-official" => format!("plugins/{plugin_name}"),
        "addy-agent-skills" => plugin_name.to_string(),
        "claude-code-workflows" => plugin_name.to_string(),
        // superpowers-marketplace: entire repo is one plugin bundle
        "superpowers-marketplace" | "ecc" | "openai-codex" => String::new(),
        _ => format!("plugins/{plugin_name}"),
    }
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

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
fn fetch_latest_commit(repo_slug: &str, subpath: &str) -> Result<(String, String, String), String> {
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

/// Bulk update check (v2.9.5).
///
/// 1. Try the 1-hour on-disk cache; return it if still fresh (unless `force`).
/// 2. Load `installed_plugins.json` for SHAs and `known_marketplaces.json`
///    for repo slugs.
/// 3. For each installed plugin:
///    a. If `gitCommitSha` present: fetch HEAD commit of the plugin's subpath and compare SHAs.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
        assert_eq!(
            plugin_repo_subpath("superpowers-marketplace", "superpowers"),
            ""
        );
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
