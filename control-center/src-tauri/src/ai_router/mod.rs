// ULTRON Control Center — AI Router backend.
//
// Owns zone -> (provider, model) routing decisions plus a thin health-check
// + test-invocation layer over each upstream provider. The frontend lives in
// `src/components/AIRouter/` and talks to the seven `#[tauri::command]`
// wrappers declared at the bottom of this file.
//
// Module layout:
//   types.rs     — All domain types, storage path helpers, free_tier_daily_limit
//   seed.rs      — Seed data (seed_providers, seed_zones)
//   store.rs     — File I/O, CLI cache, load/save helpers, key-status helpers
//   health.rs    — Health-check cache (30s TTL) + HTTP client
//   exec.rs      — Retry/backoff, CLI invocation, sanitize_for_cmd, call_cli
//   providers.rs — Per-provider HTTP wrappers, try_assignment_call, metrics,
//                  bump_metrics, apply_metric_sample, route, primary_model_for_zone
//   tests.rs     — 46 unit tests (cfg(test) only)
//
// NOTE: #[tauri::command] functions are declared in this file (mod.rs) rather
// than in a sub-module because Tauri's generate_handler! macro requires the
// command symbols and their generated companions (__cmd__*, __tauri_command_name_*)
// to be resolvable at the path used in lib.rs (`ai_router::ai_router_list_zones`).
// A `pub use sub::fn` forward only moves the function symbol — not the
// macro-generated companions — causing "could not find __cmd__*" errors.

pub(crate) mod exec;
pub(crate) mod health;
pub(crate) mod providers;
pub(crate) mod seed;
pub(crate) mod store;
pub(crate) mod types;

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Public re-exports — only what external callers (other crate modules + lib.rs)
// actually reference as `crate::ai_router::*`.
// ---------------------------------------------------------------------------

// The two functions called by other crate modules (hooks_admin, cost_watchdog, …)
pub use providers::{primary_model_for_zone, route};

// CLI_CACHE — exposed pub so the test in tests.rs can evict entries via
// `crate::ai_router::CLI_CACHE.lock()`.
pub use store::CLI_CACHE;

// Types used directly in this file's Tauri command bodies.
use types::{
    KeyValidation, Provider, ProviderKind, ProviderUsageRow, RouterMetrics, UsageSummary, Zone,
};

// ---------------------------------------------------------------------------
// validate_agent — checks that an agent file exists on disk.
// Kept here rather than in a sub-module so existing doc-references resolve.
// ---------------------------------------------------------------------------

/// Returns `true` if `agent_id` corresponds to a known agent file in the
/// agents directory (`~/.claude/agents/<agent_id>.md`).
#[allow(dead_code)] // referenced in sessions.rs doc comments; not called directly
pub fn validate_agent(agent_id: &str) -> bool {
    if agent_id.is_empty() {
        return false;
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let agents_dir = std::path::Path::new(&home).join(".claude").join("agents");
    let path = agents_dir.join(format!("{}.md", agent_id));
    path.exists()
}

// ---------------------------------------------------------------------------
// Tauri commands — declared here so generate_handler! in lib.rs resolves
// `ai_router::ai_router_*` directly (macro-generated companions included).
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ai_router_list_zones() -> Result<Vec<Zone>, String> {
    store::load_zones()
}

#[tauri::command]
pub fn ai_router_save_zone(zone: Zone) -> Result<(), String> {
    store::save_zone(zone)
}

#[tauri::command]
pub fn ai_router_list_providers() -> Result<Vec<Provider>, String> {
    store::load_providers()
}

#[tauri::command]
pub fn ai_router_health(provider_id: String) -> Result<bool, String> {
    let providers = store::load_providers()?;
    let provider = providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("provider '{}' not found", provider_id))?;

    // CLI providers: checking for the binary in PATH is the correct
    // availability signal. Evict the cache entry so a freshly installed CLI
    // is detected correctly.
    if provider.kind == ProviderKind::Cli {
        let cmd = provider.cli_command.as_deref().unwrap_or("");
        if cmd.is_empty() {
            return Ok(false);
        }
        if let Ok(mut cache) = CLI_CACHE.lock() {
            cache.remove(cmd);
        }
        return Ok(store::detect_cli(cmd));
    }

    Ok(health::provider_health(provider))
}

#[tauri::command]
pub fn ai_router_metrics() -> Result<RouterMetrics, String> {
    let mut metrics = store::load_metrics()?;
    // Recompute derived latency fields from each model's histogram so the
    // dashboard always sees fresh p50/p95/avg.
    for mm in metrics.by_model.values_mut() {
        mm.latency_ms_avg = mm.histogram.avg_ms();
        mm.latency_p50_ms = mm.histogram.p50_ms();
        mm.latency_p95_ms = mm.histogram.p95_ms();
    }
    Ok(metrics)
}

#[tauri::command]
pub fn ai_router_validate_keys() -> Result<Vec<KeyValidation>, String> {
    let providers = store::load_providers()?;
    let validations = providers
        .iter()
        .map(|p| {
            if p.kind == ProviderKind::Cli {
                let cmd = p.cli_command.as_deref().unwrap_or("");
                let installed = !cmd.is_empty() && store::detect_cli(cmd);
                let install_hint = match cmd {
                    "codex" => "npm install -g @openai/codex  then  codex auth",
                    "gemini" => "npm install -g @google/gemini-cli  then  gemini auth",
                    _ => "Install the CLI and run its auth command",
                };
                return KeyValidation {
                    provider_id: p.id.clone(),
                    provider_label: p.name.clone(),
                    has_key: installed,
                    source: if installed {
                        "cli-installed".to_string()
                    } else {
                        "cli-missing".to_string()
                    },
                    warning: if installed {
                        None
                    } else {
                        Some(format!("CLI '{}' not found on PATH. {}", cmd, install_hint))
                    },
                };
            }

            if p.kind == ProviderKind::Local || p.key_env_var.is_empty() {
                return KeyValidation {
                    provider_id: p.id.clone(),
                    provider_label: p.name.clone(),
                    has_key: true,
                    source: "local".to_string(),
                    warning: None,
                };
            }

            match std::env::var(&p.key_env_var) {
                Ok(v) if !v.trim().is_empty() && !store::looks_like_placeholder(&v) => {
                    KeyValidation {
                        provider_id: p.id.clone(),
                        provider_label: p.name.clone(),
                        has_key: true,
                        source: "env".to_string(),
                        warning: None,
                    }
                }
                Ok(_) => KeyValidation {
                    provider_id: p.id.clone(),
                    provider_label: p.name.clone(),
                    has_key: false,
                    source: "none".to_string(),
                    warning: Some(format!(
                        "Provider '{}' has a placeholder value in {}. \
                         Set a real key or configure it in Settings > AI Router.",
                        p.id, p.key_env_var
                    )),
                },
                Err(_) => KeyValidation {
                    provider_id: p.id.clone(),
                    provider_label: p.name.clone(),
                    has_key: false,
                    source: "none".to_string(),
                    warning: Some(format!(
                        "Provider '{}' has no API key. \
                         Set {} or configure it in Settings > AI Router.",
                        p.id, p.key_env_var
                    )),
                },
            }
        })
        .collect();
    Ok(validations)
}

#[tauri::command]
pub fn ai_router_usage_summary() -> Result<UsageSummary, String> {
    use std::collections::HashMap;

    let providers = store::load_providers()?;
    let zones = store::load_zones()?;
    let metrics = store::load_metrics().unwrap_or_default();

    let mut rows: Vec<ProviderUsageRow> = Vec::with_capacity(providers.len());
    for p in &providers {
        let (key_present, key_masked) = if p.kind == ProviderKind::Cli {
            let cmd = p.cli_command.as_deref().unwrap_or("");
            let installed = !cmd.is_empty() && store::detect_cli(cmd);
            (installed, None)
        } else if p.key_env_var.is_empty() {
            (true, None)
        } else {
            match std::env::var(&p.key_env_var) {
                Ok(v) => {
                    let masked = store::mask_key(&v);
                    (masked.is_some(), masked)
                }
                Err(_) => (false, None),
            }
        };

        let mut primary_for_zones: Vec<String> = Vec::new();
        let mut fallback_for_zones: Vec<String> = Vec::new();
        for z in &zones {
            if z.primary.provider_id == p.id {
                primary_for_zones.push(z.id.clone());
            }
            if z.fallbacks.iter().any(|f| f.provider_id == p.id) {
                fallback_for_zones.push(z.id.clone());
            }
        }

        let cm = metrics.by_class.get(&p.id).cloned().unwrap_or_default();

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let used_today = metrics
            .daily
            .get(&p.id)
            .filter(|d| d.date == today)
            .map(|d| d.count)
            .unwrap_or(0);
        let free_tier_limit = types::free_tier_daily_limit(&p.id);
        let free_tier_pct = free_tier_limit
            .filter(|lim| *lim > 0)
            .map(|lim| (used_today as f64 / lim as f64) * 100.0);

        rows.push(ProviderUsageRow {
            provider_id: p.id.clone(),
            provider_label: p.name.clone(),
            key_env_var: p.key_env_var.clone(),
            key_present,
            key_masked,
            call_count: cm.count,
            success_count: cm.success_count,
            total_tokens: cm.tokens,
            latency_ms_avg: cm.latency_ms_avg,
            primary_for_zones,
            fallback_for_zones,
            free_tier_limit,
            free_tier_used_today: used_today,
            free_tier_pct,
            last_error: cm.last_error.clone(),
            last_error_at: cm.last_error_at.clone(),
            consecutive_failures: cm.consecutive_failures,
            cooldown_until: cm.cooldown_until.clone(),
        });
    }

    let mut zone_chains: HashMap<String, Vec<String>> = HashMap::new();
    for z in &zones {
        let mut chain: Vec<String> = vec![z.primary.provider_id.clone()];
        for f in &z.fallbacks {
            chain.push(f.provider_id.clone());
        }
        zone_chains.insert(z.id.clone(), chain);
    }

    let real_fallback_rate = if metrics.routes_total > 0 {
        metrics.real_fallback_count as f64 / metrics.routes_total as f64
    } else {
        0.0
    };

    // Rolling-window health signal: only the last N routes, so failures from
    // retired providers (gemini-cli/claude-haiku) drop out as fresh traffic
    // arrives instead of poisoning the rate forever.
    let recent_window = metrics.recent_routes.len();
    let real_fallback_rate_recent = if recent_window > 0 {
        metrics.recent_routes.iter().filter(|&&f| f).count() as f64 / recent_window as f64
    } else {
        0.0
    };

    Ok(UsageSummary {
        providers: rows,
        fallback_rate: metrics.fallback_rate,
        attempt_failure_rate: metrics.fallback_rate,
        real_fallback_rate,
        real_fallback_count: metrics.real_fallback_count,
        routes_total: metrics.routes_total,
        real_fallback_rate_recent,
        recent_window: recent_window as u64,
        zone_chains,
    })
}
