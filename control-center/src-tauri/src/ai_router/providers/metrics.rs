// Metrics bookkeeping for the AI router.
//
// Contains:
//   - MetricSample
//   - bump_metrics, apply_metric_sample (one provider attempt)
//   - record_route_outcome, apply_route_outcome (one finished route() call)
//
// Every write goes through `store::update_metrics`: read-modify-write under a
// cross-process file lock, atomic replace with a per-process temp file.

use crate::ai_router::retry_hint;
use crate::ai_router::store::update_metrics;
use crate::ai_router::types::{
    daily_quota_key, ClassMetrics, FailReason, ModelMetrics, RouteOutcome, RouterMetrics,
    HEALTH_GATE_CONSECUTIVE_FAILURES, HEALTH_GATE_COOLDOWN_MAX_MINUTES,
    HEALTH_GATE_COOLDOWN_MINUTES, RECENT_FALLBACK_WINDOW,
};

use super::call_wrappers::truncate;

/// Tope (en caracteres) del último error que se guarda por proveedor.
pub(crate) const MAX_LAST_ERROR_CHARS: usize = 300;

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
    pub retry_count: u32,
    pub fail_reason: Option<FailReason>,
    pub error: Option<&'a str>,
}

/// Record one provider attempt in the persisted metrics (locked RMW).
pub(crate) fn bump_metrics(s: MetricSample<'_>) -> Result<(), String> {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    update_metrics(|m| apply_metric_sample(m, &s, &today))
}

/// Record the final outcome of one `route()` call (locked RMW).
pub(crate) fn record_route_outcome(outcome: RouteOutcome) -> Result<(), String> {
    update_metrics(|m| apply_route_outcome(m, outcome))
}

/// Record that `route()` skipped a provider without attempting it (locked RMW).
pub(crate) fn record_hard_skip(provider_id: &str, why: &str) -> Result<(), String> {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    update_metrics(|m| apply_hard_skip(m, provider_id, why, &today))
}

/// Pure core of [`record_hard_skip`]: the provider's health row shows the motive
/// and how many times in a row, without counting a call that never happened.
pub(crate) fn apply_hard_skip(
    metrics: &mut RouterMetrics,
    provider_id: &str,
    why: &str,
    today: &str,
) {
    let pm = metrics.by_class.entry(provider_id.to_string()).or_default();
    if pm.date != today {
        *pm = ClassMetrics::default();
        pm.date = today.to_string();
    }
    pm.last_error = Some(truncate(why, MAX_LAST_ERROR_CHARS));
    pm.last_error_at = Some(chrono::Utc::now().to_rfc3339());
    pm.consecutive_failures = pm.consecutive_failures.saturating_add(1);
}

/// Pure core of [`record_route_outcome`]: bumps the cumulative counters and
/// pushes the outcome into the bounded recent window.
///
/// A route whose whole chain failed counts in `routes_total`, in
/// `routes_failed` and in the window as `Failed`. Until 2026-10-23 it went in
/// as a primary success, so the fallback rate went DOWN with every failure.
pub(crate) fn apply_route_outcome(metrics: &mut RouterMetrics, outcome: RouteOutcome) {
    metrics.routes_total = metrics.routes_total.saturating_add(1);
    match outcome {
        RouteOutcome::Primary => {}
        RouteOutcome::Fallback => {
            metrics.real_fallback_count = metrics.real_fallback_count.saturating_add(1);
        }
        RouteOutcome::Failed => {
            metrics.routes_failed = metrics.routes_failed.saturating_add(1);
        }
    }
    metrics.recent_outcomes.push(outcome);
    if metrics.recent_outcomes.len() > RECENT_FALLBACK_WINDOW {
        let excess = metrics.recent_outcomes.len() - RECENT_FALLBACK_WINDOW;
        metrics.recent_outcomes.drain(0..excess);
    }
}

/// Cooldown (seconds) for a model after a terminal failure, or `None` to keep
/// it in the chain.
///
/// - 429 whose retry hint exceeds the inline-retry window: cool down exactly
///   that long, from the first failure (the provider told us when it is back).
/// - Otherwise, from the `HEALTH_GATE_CONSECUTIVE_FAILURES`-th failure in a
///   row: 15 -> 30 -> 60 -> 120 min, doubling per extra failure.
pub(crate) fn model_cooldown_secs(
    consecutive_failures: u64,
    reason: Option<FailReason>,
    retry_hint_secs: Option<u64>,
) -> Option<i64> {
    if reason == Some(FailReason::RateLimit) {
        if let Some(secs) = retry_hint_secs.filter(|s| *s > retry_hint::INLINE_RETRY_MAX_SECS) {
            return Some(secs as i64);
        }
    }
    if consecutive_failures < HEALTH_GATE_CONSECUTIVE_FAILURES {
        return None;
    }
    let doublings = (consecutive_failures - HEALTH_GATE_CONSECUTIVE_FAILURES).min(3) as u32;
    let minutes = (HEALTH_GATE_COOLDOWN_MINUTES << doublings).min(HEALTH_GATE_COOLDOWN_MAX_MINUTES);
    Some(minutes * 60)
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

    // --- Provider-level health (display only) ---
    // The cooldown itself lives per model (below); the provider row in the UI
    // derives its cooldown from its models (see ai_router_usage_summary).
    let now = chrono::Utc::now();
    pm.cooldown_until = None;
    if s.success {
        pm.last_success_at = Some(now.to_rfc3339());
        pm.consecutive_failures = 0;
        pm.last_error = None;
    } else {
        // Redactar el texto completo y recortar después: un secreto cortado por
        // el tope queda por debajo del mínimo del patrón y escaparía.
        let completo = crate::memory::redaction::redact(s.error.unwrap_or("unknown error"));
        pm.last_error = Some(truncate(&completo, MAX_LAST_ERROR_CHARS));
        pm.last_error_at = Some(now.to_rfc3339());
        pm.consecutive_failures = pm.consecutive_failures.saturating_add(1);
    }

    // --- Per-model (by_model), key = "provider::model" ---
    let key = format!("{}::{}", s.provider_id, s.model);
    let mm = metrics.by_model.entry(key).or_default();
    if mm.date != today {
        // Daily counters reset; the health gate does not (absolute instant).
        *mm = ModelMetrics {
            consecutive_failures: mm.consecutive_failures,
            cooldown_until: mm.cooldown_until.take(),
            ..ModelMetrics::default()
        };
        mm.date = today.to_string();
    }

    // --- Health gate per (provider, model) ---
    if s.success {
        mm.consecutive_failures = 0;
        mm.cooldown_until = None;
    } else {
        mm.consecutive_failures = mm.consecutive_failures.saturating_add(1);
        let hint = s.error.and_then(retry_hint::hint_from_message);
        if let Some(secs) = model_cooldown_secs(mm.consecutive_failures, s.fail_reason, hint) {
            mm.cooldown_until = Some((now + chrono::Duration::seconds(secs)).to_rfc3339());
        }
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

    // --- Per-attempt failure EMA (0.1); stored as `fallback_rate` for
    // compatibility, exposed as `attempt_failure_rate` ---
    if s.success {
        metrics.fallback_rate *= 0.9;
    } else {
        metrics.fallback_rate = metrics.fallback_rate * 0.9 + 0.1;
    }

    // --- Savings ---
    if s.success && s.output_tokens > 0 && s.cost_per_mtok < s.primary_cost_per_mtok {
        metrics.fallback_output_tokens = metrics
            .fallback_output_tokens
            .saturating_add(s.output_tokens);
        let delta = (s.primary_cost_per_mtok - s.cost_per_mtok).max(0.0);
        metrics.cost_saved_usd += (s.output_tokens as f64) * delta / 1_000_000.0;
    }

    // --- Daily free-tier counter, per (provider, model) bucket ---
    // Legacy keys (bare provider id, written before 2026-10-23) are dropped:
    // they summed every model of the provider into one bucket.
    metrics.daily.retain(|k, _| k.contains("::"));
    let du = metrics
        .daily
        .entry(daily_quota_key(s.provider_id, s.model))
        .or_default();
    if du.date != today {
        du.date = today.to_string();
        du.count = 0;
    }
    du.count = du.count.saturating_add(1);

    // --- Fail-reason tally ---
    if let Some(reason) = &s.fail_reason {
        let rc = metrics.fail_reasons.entry(reason.to_string()).or_insert(0);
        *rc = rc.saturating_add(1);
    }
}
