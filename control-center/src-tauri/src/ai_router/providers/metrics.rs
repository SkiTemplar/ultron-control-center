// Metrics bookkeeping for the AI router.
//
// Contains:
//   - MetricSample
//   - bump_metrics, apply_metric_sample
//   - load_metrics_and_bump_route_counters

use crate::ai_router::store::{load_metrics, write_json};
use crate::ai_router::types::{
    metrics_path, ClassMetrics, FailReason, ModelMetrics, RouterMetrics,
    HEALTH_GATE_CONSECUTIVE_FAILURES, HEALTH_GATE_COOLDOWN_MINUTES,
};

use super::call_wrappers::truncate;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/// Una muestra de metricas tras un intento de ruta.
pub(crate) struct MetricSample<'a> {
    pub provider_id: &'a str,
    pub model: &'a str,
    pub success: bool,
    pub output_tokens: u64,
    pub cost_per_mtok: f64,
    pub primary_cost_per_mtok: f64,
    pub latency_ms: u64,
    pub mode: Option<&'a str>,
    pub retry_count: u32,
    pub fail_reason: Option<FailReason>,
    pub error: Option<&'a str>,
}

/// Mutate the persisted metrics so the dashboard moves. Best-effort.
pub(crate) fn bump_metrics(s: MetricSample<'_>) -> Result<(), String> {
    let mut metrics = load_metrics().unwrap_or_default();
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    apply_metric_sample(&mut metrics, &s, &today);
    write_json(&metrics_path()?, &metrics)
}

/// Pure mutation core of [`bump_metrics`], split out for unit-testability.
pub(crate) fn apply_metric_sample(metrics: &mut RouterMetrics, s: &MetricSample<'_>, today: &str) {
    // --- Per-provider (by_class) ---
    let pm = metrics
        .by_class
        .entry(s.provider_id.to_string())
        .or_default();
    if pm.date != today {
        *pm = ClassMetrics::default();
        pm.date = today.to_string();
    }
    pm.count = pm.count.saturating_add(1);
    if s.success {
        pm.success_count = pm.success_count.saturating_add(1);
    }
    pm.tokens = pm.tokens.saturating_add(s.output_tokens);
    if pm.count <= 1 {
        pm.latency_ms_avg = s.latency_ms;
    } else {
        pm.latency_ms_avg = (pm.latency_ms_avg + s.latency_ms) / 2;
    }

    // --- Health bookkeeping (F1 2026-06-10) ---
    let now = chrono::Utc::now();
    if s.success {
        pm.last_success_at = Some(now.to_rfc3339());
        pm.consecutive_failures = 0;
        pm.cooldown_until = None;
        pm.last_error = None;
    } else {
        pm.last_error = Some(truncate(s.error.unwrap_or("unknown error"), 300).to_string());
        pm.last_error_at = Some(now.to_rfc3339());
        pm.consecutive_failures = pm.consecutive_failures.saturating_add(1);
        if pm.consecutive_failures >= HEALTH_GATE_CONSECUTIVE_FAILURES {
            pm.cooldown_until =
                Some((now + chrono::Duration::minutes(HEALTH_GATE_COOLDOWN_MINUTES)).to_rfc3339());
        }
    }

    // --- Per-model (by_model), key = "provider::model" ---
    let key = format!("{}::{}", s.provider_id, s.model);
    let mm = metrics.by_model.entry(key).or_default();
    if mm.date != today {
        *mm = ModelMetrics::default();
        mm.date = today.to_string();
    }
    mm.provider_id = s.provider_id.to_string();
    mm.model = s.model.to_string();
    mm.count = mm.count.saturating_add(1);
    if s.success {
        mm.success_count = mm.success_count.saturating_add(1);
    }
    mm.output_tokens = mm.output_tokens.saturating_add(s.output_tokens);
    mm.histogram.record(s.latency_ms);
    mm.latency_ms_avg = mm.histogram.avg_ms();
    mm.latency_p50_ms = mm.histogram.p50_ms();
    mm.latency_p95_ms = mm.histogram.p95_ms();
    mm.total_retries = mm.total_retries.saturating_add(s.retry_count as u64);
    if s.retry_count > 0 {
        mm.retried_calls = mm.retried_calls.saturating_add(1);
    }

    // --- Fallback rate (EMA 0.1) ---
    if s.success {
        metrics.fallback_rate *= 0.9;
    } else {
        metrics.fallback_rate = metrics.fallback_rate * 0.9 + 0.1;
    }

    // --- Savings ---
    if s.success && s.output_tokens > 0 && s.cost_per_mtok < s.primary_cost_per_mtok {
        metrics.tokens_saved_total = metrics.tokens_saved_total.saturating_add(s.output_tokens);
        let delta = (s.primary_cost_per_mtok - s.cost_per_mtok).max(0.0);
        metrics.cost_saved_usd += (s.output_tokens as f64) * delta / 1_000_000.0;
    }

    // --- Daily counter ---
    let du = metrics.daily.entry(s.provider_id.to_string()).or_default();
    if du.date != today {
        du.date = today.to_string();
        du.count = 0;
    }
    du.count = du.count.saturating_add(1);

    // --- Per-mode daily counters ---
    if let Some(mode) = s.mode {
        if metrics.by_mode.date != today {
            metrics.by_mode.date = today.to_string();
            metrics.by_mode.counts.clear();
        }
        let mc = metrics.by_mode.counts.entry(mode.to_string()).or_insert(0);
        *mc = mc.saturating_add(1);
    }

    // --- Fail-reason tally ---
    if let Some(reason) = &s.fail_reason {
        let rc = metrics.fail_reasons.entry(reason.to_string()).or_insert(0);
        *rc = rc.saturating_add(1);
    }
}

/// Atomically increments the per-route counters in the persisted metrics file.
pub(crate) fn load_metrics_and_bump_route_counters(used_fallback: bool) -> Result<(), String> {
    let path = metrics_path()?;
    let mut metrics: RouterMetrics = if path.exists() {
        crate::ai_router::store::read_json(&path).unwrap_or_default()
    } else {
        RouterMetrics::default()
    };
    metrics.routes_total = metrics.routes_total.saturating_add(1);
    if used_fallback {
        metrics.real_fallback_count = metrics.real_fallback_count.saturating_add(1);
    }
    // Rolling window: record this outcome and evict the oldest beyond the cap so
    // `real_fallback_rate_recent` reflects only the current zone configuration
    // (immune to retired-provider history like gemini-cli/claude-haiku).
    metrics.recent_routes.push(used_fallback);
    let window = crate::ai_router::types::RECENT_FALLBACK_WINDOW;
    if metrics.recent_routes.len() > window {
        let excess = metrics.recent_routes.len() - window;
        metrics.recent_routes.drain(0..excess);
    }
    write_json(&path, &metrics)
}
