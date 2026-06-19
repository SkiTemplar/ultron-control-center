// File I/O — read on demand; write atomically (tmp + rename) on save.
// Also: provider/zone/metrics load helpers and the key-status utilities.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;

use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::Mutex;

use super::seed::{seed_providers, seed_zones};
use super::types::{
    metrics_path, providers_path, zones_path, ApiKeyStatus, Provider, ProviderKind, RouterMetrics,
    Zone,
};

// ---------------------------------------------------------------------------
// Generic JSON helpers
// ---------------------------------------------------------------------------

pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", path.display(), e))
}

pub(crate) fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create dir {}: {}", parent.display(), e))?;
    }
    let body = serde_json::to_vec_pretty(value)
        .map_err(|e| format!("serialize {}: {}", path.display(), e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &body).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename to {}: {}", path.display(), e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// CLI presence cache
// ---------------------------------------------------------------------------

/// Process-lifetime cache of CLI binary detection results.
/// `pub` so `mod.rs` can re-export it for tests that need to evict entries.
pub static CLI_CACHE: Lazy<Mutex<std::collections::HashMap<String, bool>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

/// Returns `true` when `command` resolves on the current PATH.
///
/// Uses `where` on Windows and `which` on all other platforms. The result
/// is cached for the process lifetime — safe because CLI tools are not
/// installed/uninstalled mid-session.
pub fn detect_cli(command: &str) -> bool {
    if let Ok(cache) = CLI_CACHE.lock() {
        if let Some(&result) = cache.get(command) {
            return result;
        }
    }

    #[cfg(target_os = "windows")]
    let found = std::process::Command::new("where")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    #[cfg(not(target_os = "windows"))]
    let found = std::process::Command::new("which")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if let Ok(mut cache) = CLI_CACHE.lock() {
        cache.insert(command.to_string(), found);
    }
    found
}

// ---------------------------------------------------------------------------
// Key-status helpers
// ---------------------------------------------------------------------------

pub fn compute_key_status(p: &Provider) -> ApiKeyStatus {
    if p.kind == ProviderKind::Local {
        return ApiKeyStatus::Configured;
    }
    if p.kind == ProviderKind::Cli {
        let cmd = p.cli_command.as_deref().unwrap_or("");
        return if !cmd.is_empty() && detect_cli(cmd) {
            ApiKeyStatus::Configured
        } else {
            ApiKeyStatus::Missing
        };
    }
    if p.key_env_var.is_empty() {
        return ApiKeyStatus::Configured;
    }
    match std::env::var(&p.key_env_var) {
        Ok(v) if !v.trim().is_empty() && !looks_like_placeholder(&v) => ApiKeyStatus::Configured,
        Ok(_) => ApiKeyStatus::Placeholder,
        Err(_) => ApiKeyStatus::Missing,
    }
}

pub(crate) fn looks_like_placeholder(v: &str) -> bool {
    let lower = v.to_ascii_lowercase();
    lower.contains("your-key")
        || lower.contains("replace")
        || lower.starts_with("xxx")
        || lower == "sk-..."
}

/// Compute the set of provider IDs that should be skipped by `route()`.
pub(crate) fn disabled_providers_set() -> HashSet<String> {
    load_providers()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| {
            matches!(
                compute_key_status(p),
                ApiKeyStatus::Missing | ApiKeyStatus::Placeholder
            )
        })
        .map(|p| p.id)
        .collect()
}

// ---------------------------------------------------------------------------
// Load/save helpers
// ---------------------------------------------------------------------------

/// Returns the providers list, seeding the file on first run. Then patches
/// every entry's `api_key_status` against the current process env.
pub fn load_providers() -> Result<Vec<Provider>, String> {
    let path = providers_path()?;
    let mut providers: Vec<Provider> = if path.exists() {
        read_json(&path)?
    } else {
        let seeded = seed_providers();
        write_json(&path, &seeded)?;
        seeded
    };
    for p in providers.iter_mut() {
        p.api_key_status = compute_key_status(p);
    }
    Ok(providers)
}

pub fn load_zones() -> Result<Vec<Zone>, String> {
    let path = zones_path()?;
    if path.exists() {
        // Auto-cure: a hand-edit of zones.json on 2026-06-04 dropped the
        // 'utility' and 'light' zones — the two MOST invoked from code —
        // so route('utility')/route('light') returned Err('zone not found').
        // We now merge back any seed zone missing by id.
        let mut zones: Vec<Zone> = read_json(&path)?;
        let have: std::collections::HashSet<String> = zones.iter().map(|z| z.id.clone()).collect();
        for z in seed_zones() {
            if !have.contains(&z.id) {
                zones.push(z);
            }
        }
        // CLI-primary migration (2026-06-05): upgrade an existing zones.json
        // 'code-edit' entry that still points to the old cloud-only primary.
        let mut mutated = false;
        for z in &mut zones {
            if z.id == "code-edit" && z.primary.provider_id == "codex" {
                z.primary.provider_id = "codex-cli".into();
                if !z.fallbacks.iter().any(|f| f.provider_id == "codex") {
                    z.fallbacks.insert(
                        0,
                        super::types::ZoneAssignment {
                            provider_id: "codex".into(),
                            model: "gpt-5".into(),
                            max_tokens: z.primary.max_tokens,
                        },
                    );
                }
                mutated = true;
            }
        }
        // gemini-cli retirement migration (2026-06-19): the gemini-cli binary no
        // longer authenticates (Google dropped free-tier OAuth for individuals —
        // runtime IneligibleTierError "migrate to the Antigravity suite"). The
        // migration swaps it for the cloud 'gemini' provider in every chain and
        // de-dups. NOTE: this SUPERSEDES the 2026-06-05 rule that PROMOTED
        // research-web to gemini-cli — that rule was removed, the CLI is dead.
        if retire_gemini_cli(&mut zones) {
            mutated = true;
        }
        if mutated {
            let _ = write_json(&path, &zones);
        }
        Ok(zones)
    } else {
        let seeded = seed_zones();
        write_json(&path, &seeded)?;
        Ok(seeded)
    }
}

/// Retire the dead `gemini-cli` provider from every zone chain: replace it with
/// the cloud `gemini` provider (so research-web keeps gemini-2.5-flash via API,
/// and every fallback keeps a working target), then drop any fallback whose
/// provider already appears earlier in the chain (including as the primary).
///
/// Pure (no I/O) so the migration is unit-testable. Returns `true` if any zone
/// was mutated.
pub(crate) fn retire_gemini_cli(zones: &mut [Zone]) -> bool {
    let mut mutated = false;
    for z in zones.iter_mut() {
        if z.primary.provider_id == "gemini-cli" {
            z.primary.provider_id = "gemini".into();
            mutated = true;
        }
        for f in &mut z.fallbacks {
            if f.provider_id == "gemini-cli" {
                f.provider_id = "gemini".into();
                mutated = true;
            }
        }
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        seen.insert(z.primary.provider_id.clone());
        let before = z.fallbacks.len();
        z.fallbacks.retain(|f| seen.insert(f.provider_id.clone()));
        if z.fallbacks.len() != before {
            mutated = true;
        }
    }
    mutated
}

/// Persist a single zone: replaces the entry with matching `id`, or appends if
/// not found. Preserves all other zones and writes atomically.
pub fn save_zone(zone: Zone) -> Result<(), String> {
    let path = zones_path()?;
    let mut zones = load_zones()?;
    if let Some(existing) = zones.iter_mut().find(|z| z.id == zone.id) {
        *existing = zone;
    } else {
        zones.push(zone);
    }
    write_json(&path, &zones)
}

pub(crate) fn load_metrics() -> Result<RouterMetrics, String> {
    let path = metrics_path()?;
    if path.exists() {
        read_json(&path)
    } else {
        let m = RouterMetrics::default();
        write_json(&path, &m)?;
        Ok(m)
    }
}

pub(crate) fn mask_key(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || looks_like_placeholder(trimmed) {
        return None;
    }
    if trimmed.len() <= 8 {
        return Some("*".repeat(trimmed.len()));
    }
    Some(format!(
        "{}{}{}",
        &trimmed[..4],
        "*".repeat(trimmed.len() - 8),
        &trimmed[trimmed.len() - 4..]
    ))
}
