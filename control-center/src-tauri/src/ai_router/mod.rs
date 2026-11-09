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
//   store.rs     — CLI cache, load/save helpers, key-status helpers
//     store/json_io.rs         — atomic JSON writes + locked metrics updates
//     store/zone_migrations.rs — zones.json migrations (normalize_zones)
//   health.rs    — Health-check cache (30s TTL) + HTTP client
//   exec.rs      — Retry/backoff, CLI invocation (direct spawn, stdin for
//                  codex), run_with_timeout (kills the process tree)
//   providers/   — call_wrappers (per-provider HTTP wrappers,
//                  try_assignment_call), metrics (bump_metrics,
//                  record_route_outcome), routing (route,
//                  primary_model_for_zone)
//   tests/       — unit tests by area (cfg(test) only)
//   api_format.rs         — ApiFormat (dispatch protocol), legacy deduction,
//                           openai_api_root
//   seed_openai_compat.rs — OpenAI-compatible seed providers (no zone)
//   key_source.rs         — keys del router: entorno y, si faltan, HKCU\Environment
//   discover.rs           — ai_router_discover_models
//   custom.rs             — ai_router_upsert/remove_custom_provider
//   delegation.rs         — ai_router_get/set_delegation (delegation.json)
//   delegation_runtime.rs — ai_router_delegation_status / _ledger
//
// NOTE: the original commands are declared in this file (mod.rs). The
// 2026-10-26 ones live in their sub-modules and handlers.rs registers them by
// their full path (`ai_router::delegation::ai_router_get_delegation`), which
// resolves the macro-generated companions too. What does NOT work is a
// `pub use sub::fn` forward: it only moves the function symbol, not the
// companions (__cmd__*), causing "could not find __cmd__*" errors.

pub(crate) mod api_format;
pub(crate) mod custom;
pub(crate) mod delegation;
pub(crate) mod delegation_runtime;
pub(crate) mod discover;
pub(crate) mod exec;
pub(crate) mod health;
pub(crate) mod key_source;
pub(crate) mod key_validation;
pub(crate) mod providers;
pub(crate) mod retry_hint;
pub(crate) mod seed;
pub(crate) mod seed_openai_compat;
pub(crate) mod store;
pub(crate) mod types;

#[cfg(test)]
mod test_http;
#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Public re-exports — only what external callers (other crate modules + lib.rs)
// actually reference as `crate::ai_router::*`.
// ---------------------------------------------------------------------------

// `route` is called by other crate modules (memory, hooks_admin, sessions_tags,
// plugins_info, commands::…).
// `primary_model_for_zone` lost its last production caller when
// `agent_orchestration::delegate::resolve_cheap_model` was retired
// (2026-09-14, kanban "comandos huérfanos"); kept as ai_router's documented
// "what model would zone X use" primitive — exercised today only by
// `ai_router_tests::basics`.
#[cfg_attr(not(test), allow(unused_imports))]
pub use providers::{primary_model_for_zone, route};

// CLI_CACHE — exposed pub so the test in tests.rs can evict entries via
// `crate::ai_router::CLI_CACHE.lock()`.
pub use store::CLI_CACHE;

// Types used directly in this file's Tauri command bodies.
use types::{
    KeyValidation, Provider, ProviderKind, ProviderUsageRow, RouterMetrics, UsageSummary, Zone,
};

// ---------------------------------------------------------------------------
// Tauri commands — declared here so generate_handler! in handlers.rs resolves
// `ai_router::ai_router_*` directly (macro-generated companions included).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_router_list_zones() -> Result<Vec<Zone>, String> {
    store::load_zones()
}

/// Persists a zone edit and returns it as stored. Rejects, with the reason,
/// an edit that the next `load_zones` would revert (see `store::save_zone`).
#[tauri::command]
pub async fn ai_router_save_zone(zone: Zone) -> Result<Zone, String> {
    store::save_zone(zone)
}

#[tauri::command]
pub async fn ai_router_list_providers() -> Result<Vec<Provider>, String> {
    store::load_providers()
}

#[tauri::command]
pub async fn ai_router_health(provider_id: String) -> Result<bool, String> {
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
pub async fn ai_router_metrics() -> Result<RouterMetrics, String> {
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
pub async fn ai_router_validate_keys() -> Result<Vec<KeyValidation>, String> {
    let providers = store::load_providers()?;
    Ok(providers
        .iter()
        .map(key_validation::key_validation)
        .collect())
}

/// Latest still-active cooldown among a provider's models. The health gate is
/// per model; the provider row shows the furthest one so the UI stays honest.
fn latest_model_cooldown(metrics: &RouterMetrics, provider_id: &str) -> Option<String> {
    let now = chrono::Utc::now();
    metrics
        .by_model
        .values()
        .filter(|mm| mm.provider_id == provider_id)
        .filter_map(|mm| mm.cooldown_until.as_deref())
        .filter_map(|u| chrono::DateTime::parse_from_rfc3339(u).ok())
        .filter(|t| *t > now)
        .max()
        .map(|t| t.to_rfc3339())
}

#[tauri::command]
pub async fn ai_router_usage_summary() -> Result<UsageSummary, String> {
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
            match key_source::resolve_key(&p.key_env_var) {
                Some(v) => {
                    let masked = store::mask_key(&v);
                    (masked.is_some(), masked)
                }
                None => (false, None),
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
        let used_today = provider_daily_peak(&metrics, &p.id, &today);
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
            cooldown_until: latest_model_cooldown(&metrics, &p.id),
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

    let rates = route_rates(&metrics);
    Ok(UsageSummary {
        providers: rows,
        attempt_failure_rate: metrics.fallback_rate,
        real_fallback_rate: rates.missed_primary,
        real_fallback_count: metrics.real_fallback_count,
        routes_failed: metrics.routes_failed,
        route_failure_rate: rates.failed,
        routes_total: metrics.routes_total,
        real_fallback_rate_recent: rates.missed_primary_recent,
        route_failure_rate_recent: rates.failed_recent,
        recent_window: metrics.recent_outcomes.len() as u64,
        zone_chains,
    })
}

/// Route-level rates derived from the persisted counters.
#[derive(Debug, PartialEq)]
pub(crate) struct RouteRates {
    /// (fallback + failed) / total, cumulative.
    pub missed_primary: f64,
    /// failed / total, cumulative.
    pub failed: f64,
    /// Same over the recent window: the actionable signal.
    pub missed_primary_recent: f64,
    pub failed_recent: f64,
}

fn ratio(part: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        part as f64 / total as f64
    }
}

/// Pure: rates of [`UsageSummary`]. A route whose chain failed counts as a
/// miss of the primary AND as a failure; until 2026-10-23 it counted as a
/// primary success and the rates went down with every failure.
pub(crate) fn route_rates(m: &RouterMetrics) -> RouteRates {
    let missed = m.real_fallback_count.saturating_add(m.routes_failed);
    let window = m.recent_outcomes.len() as u64;
    let count = |pred: fn(&types::RouteOutcome) -> bool| {
        m.recent_outcomes.iter().filter(|o| pred(o)).count() as u64
    };
    RouteRates {
        missed_primary: ratio(missed, m.routes_total),
        failed: ratio(m.routes_failed, m.routes_total),
        missed_primary_recent: ratio(count(|o| o.missed_primary()), window),
        failed_recent: ratio(count(|o| *o == types::RouteOutcome::Failed), window),
    }
}

/// Requests sent today to the most used free-tier bucket of the provider.
/// The quota is per (provider, model), so the provider row shows the bucket
/// closest to its limit, not the sum of its models.
fn provider_daily_peak(metrics: &RouterMetrics, provider_id: &str, today: &str) -> u64 {
    let prefix = format!("{provider_id}::");
    metrics
        .daily
        .iter()
        .filter(|(k, d)| k.starts_with(&prefix) && d.date == today)
        .map(|(_, d)| d.count)
        .max()
        .unwrap_or(0)
}
