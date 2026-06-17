// plugins_info/update_check.rs — v2.6 fb-022 plugin update check via `gh repo view`.

use serde::Deserialize;

use super::cache::list_all_plugins_inner;
use super::types::PluginUpdateStatus;

// ---------------------------------------------------------------------------
// Private types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(super) struct MarketplaceRegistryEntry {
    /// `installed_plugins.json` and `marketplaces.json` both use `repo` as the
    /// `owner/name` slug.
    #[serde(default)]
    pub(super) repo: Option<String>,
    /// Some legacy entries used `repository` instead.
    #[serde(default)]
    pub(super) repository: Option<String>,
    /// A few marketplaces expose just a URL — we accept it as a fallback.
    #[serde(default)]
    pub(super) url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhRepoView {
    #[serde(rename = "pushedAt")]
    pushed_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub(super) fn gh_for_update(args: &[&str]) -> std::process::Command {
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
pub(super) fn load_marketplace_repo_map() -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let candidates = [
        home.join(".claude")
            .join("plugins")
            .join("marketplaces.json"),
        home.join(".claude").join("plugins").join("registry.json"),
    ];
    for path in candidates.iter() {
        if !path.exists() {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
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
            let entry: MarketplaceRegistryEntry = match serde_json::from_value(v.clone()) {
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

pub(super) fn extract_owner_repo_from_url(url: String) -> Option<String> {
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

// ---------------------------------------------------------------------------
// Public inner function
// ---------------------------------------------------------------------------

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

        let output = gh_for_update(&["repo", "view", &repo_slug, "--json", "pushedAt"]).output();

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
