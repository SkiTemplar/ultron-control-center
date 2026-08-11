// plugins_info/update_check.rs â€” marketplace registry helpers compartidos con
// bulk_update (v2.9.5). Higiene 2026-08-11 (audit 08-09 #45): el scan v2.6
// por `gh repo view` (check_plugin_updates_inner + GhRepoView + gh_for_update)
// se borro entero â€” superseded por plugin_check_updates_bulk_inner (SHA-aware).

use serde::Deserialize;

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
    /// A few marketplaces expose just a URL â€” we accept it as a fallback.
    #[serde(default)]
    pub(super) url: Option<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Reads `~/.claude/plugins/marketplaces.json` (or any sibling file the
/// user has) and builds a `marketplace-slug â†’ owner/repo` map.
///
/// The marketplace file is a JSON object whose top-level keys are
/// marketplace slugs (`ecc`, `superpowers-marketplace`, â€¦) and whose values
/// carry a `repo` field. We are intentionally permissive â€” Claude Code's
/// real format has drifted between versions and the rest of the file
/// (auth, sources, â€¦) is none of our business.
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
