// Route function and zone-walking logic.
//
// Contains:
//   - primary_model_for_zone
//   - route
//   - skip_reason, attempt_assignment, finish_route (private)
//   - log_route_decision (route-decisions.jsonl)

use std::collections::HashSet;
use std::time::Instant;

use crate::ai_router::store::{disabled_providers_set, load_metrics, load_providers, load_zones};
use crate::ai_router::types::{
    free_tier_daily_limit, route_decisions_path, FailReason, RouteOutcome, RouterMetrics,
    ZoneAssignment,
};

use super::call_wrappers::{dispatch_model, truncate, try_assignment_call};
use super::metrics::{
    bump_metrics, record_hard_skip, record_route_outcome, MetricSample, MAX_LAST_ERROR_CHARS,
};

/// Rotation threshold for the route-decision JSONL (mirrors the hooks'
/// `jsonl-log.js` policy: single generation, at most 2x this on disk).
const ROUTE_LOG_MAX_BYTES: u64 = 1024 * 1024;

/// Append one structured route decision to `~/.ultron/logs/route-decisions.jsonl`
/// (cat15.2). Single-generation size rotation: when the file exceeds
/// `ROUTE_LOG_MAX_BYTES` it is renamed to `<file>.1` before the write.
///
/// Schema: `{ts, zone, model, provider_id, used_fallback, reason}` plus
/// `error` on a failed route. `reason` is `primary`, `fallback` or `failed`;
/// a failed route names the LAST provider of the chain it tried or skipped
/// (nobody answered: `reason` is what says so), so every line is complete.
/// Errors are returned; `route()` logs them instead of failing the route.
fn log_route_decision(
    zone_id: &str,
    provider_id: &str,
    model: &str,
    outcome: RouteOutcome,
    error: Option<&str>,
) -> Result<(), String> {
    let path = route_decisions_path()?;
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() >= ROUTE_LOG_MAX_BYTES {
            std::fs::rename(&path, path.with_extension("jsonl.1"))
                .map_err(|e| format!("rotate {}: {}", path.display(), e))?;
        }
    }
    let line = route_decision_line(zone_id, provider_id, model, outcome, error);
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {}", path.display(), e))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("append {}: {}", path.display(), e))
}

/// One JSONL line of the route-decision log (hand-built: no serde struct for
/// a single append; values are escaped to stay valid even with odd ids).
fn route_decision_line(
    zone_id: &str,
    provider_id: &str,
    model: &str,
    outcome: RouteOutcome,
    error: Option<&str>,
) -> String {
    let reason = match outcome {
        RouteOutcome::Primary => "primary",
        RouteOutcome::Fallback => "fallback",
        RouteOutcome::Failed => "failed",
    };
    let error_field = error
        .map(|e| {
            let redacted = crate::memory::redaction::redact(e);
            format!(
                ",\"error\":{}",
                json_str(&truncate(&redacted, MAX_LAST_ERROR_CHARS))
            )
        })
        .unwrap_or_default();
    format!(
        "{{\"ts\":{},\"zone\":{},\"model\":{},\"provider_id\":{},\"used_fallback\":{},\"reason\":{}{}}}\n",
        json_str(&chrono::Utc::now().to_rfc3339()),
        json_str(zone_id),
        json_str(model),
        json_str(provider_id),
        outcome == RouteOutcome::Fallback,
        json_str(reason),
        error_field,
    )
}

/// Minimal JSON string escaping for the route-decision log fields.
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ---------------------------------------------------------------------------
// Route function
// ---------------------------------------------------------------------------

/// Public read-only accessor: the primary model id configured for a zone.
/// `None` if the zone is unknown or zones cannot be loaded.
#[cfg_attr(not(test), allow(dead_code))]
pub fn primary_model_for_zone(zone_id: &str) -> Option<String> {
    load_zones()
        .ok()?
        .into_iter()
        .find(|z| z.id == zone_id)
        .map(|z| z.primary.model)
}

/// Why `route()` does not attempt an assignment right now.
enum Skip {
    /// Not attempted at all (no key, daily quota exhausted).
    Hard(String),
    /// Health cooldown: retried as a last resort after the rest failed.
    Cooled(String),
}

/// Snapshot of the per-call state the skip checks read.
struct ChainState<'a> {
    disabled: &'a HashSet<String>,
    metrics: &'a RouterMetrics,
    today: &'a str,
    now: chrono::DateTime<chrono::Utc>,
}

/// `Some(skip)` when the assignment must not be attempted in the first pass.
fn skip_reason(a: &ZoneAssignment, st: &ChainState<'_>) -> Option<Skip> {
    if st.disabled.contains(&a.provider_id) {
        return Some(Skip::Hard(format!(
            "[{}/{}] skipped — provider has no API key \
             (set the key env var or configure it in Settings > API Keys)",
            a.provider_id, a.model
        )));
    }
    if let Some(daily_limit) = free_tier_daily_limit(&a.provider_id) {
        // Per (provider, model): Groq and Gemini quotas are per model.
        let used = st.metrics.daily_used(&a.provider_id, &a.model, st.today);
        if used >= daily_limit {
            return Some(Skip::Hard(format!(
                "[{}/{}] skipped — daily free-tier quota exhausted \
                 ({}/{} requests today)",
                a.provider_id, a.model, used, daily_limit
            )));
        }
    }
    // Health gate keyed by (provider, model): a 429 on groq/120b must not
    // bench groq/20b, which has its own quota bucket.
    let mm = st
        .metrics
        .by_model
        .get(&format!("{}::{}", a.provider_id, a.model))?;
    let until = mm.cooldown_until.as_deref()?;
    let still_cooling = chrono::DateTime::parse_from_rfc3339(until)
        .map(|t| t > st.now)
        .unwrap_or(false);
    if !still_cooling {
        return None;
    }
    let last = st
        .metrics
        .by_class
        .get(&a.provider_id)
        .and_then(|cm| cm.last_error.as_deref())
        .unwrap_or("?");
    Some(Skip::Cooled(format!(
        "[{}/{}] soft-skipped — health cooldown until {} \
         ({} consecutive failures; last: {})",
        a.provider_id, a.model, until, mm.consecutive_failures, last
    )))
}

/// Route a prompt through the zone's provider chain, falling back on failure.
///
/// This is the real router entrypoint used by all internal Rust callers:
/// memory (capture, ai_tasks), hooks_admin::naming, sessions_tags,
/// plugins_info::bulk_update, sesiones::mejorar and the session-summary /
/// apps commands.
///
/// Every finished call is recorded once in the metrics and in
/// `route-decisions.jsonl`: `primary`, `fallback` or `failed` (whole chain
/// exhausted or skipped).
// cat15 observability: a span per routing decision. `prompt` is skipped (it may
// be large and carry user content); `zone` is recorded as a field, and `err`
// auto-records the final error when the whole primary->fallback chain is
// exhausted.
#[tracing::instrument(skip(prompt), fields(zone = %zone_id), err)]
pub fn route(zone_id: &str, prompt: &str) -> Result<String, String> {
    let zones = load_zones()?;
    let zone = zones
        .iter()
        .find(|z| z.id == zone_id)
        .ok_or_else(|| format!("zone '{}' not found", zone_id))?;

    let disabled = disabled_providers_set();
    let providers = load_providers().unwrap_or_default();
    let cost_of = |pid: &str| -> f64 {
        providers
            .iter()
            .find(|p| p.id == pid)
            .map(|p| p.cost_per_mtok)
            .unwrap_or(0.0)
    };
    let metrics = load_metrics().unwrap_or_else(|e| {
        tracing::warn!(error = %e, "metrics.json ilegible: route() sin cuota ni cooldowns");
        RouterMetrics::default()
    });
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let state = ChainState {
        disabled: &disabled,
        metrics: &metrics,
        today: &today,
        now: chrono::Utc::now(),
    };
    let ctx = AttemptCtx {
        zone_id,
        prompt,
        system_prompt: zone.system_prompt.as_deref(),
        primary_cost_per_mtok: cost_of(&zone.primary.provider_id),
    };

    let chain: Vec<&ZoneAssignment> = std::iter::once(&zone.primary)
        .chain(zone.fallbacks.iter())
        .collect();
    walk_chain(&chain, &state, &ctx, &cost_of).map_err(|failure| {
        let error = format!(
            "all providers failed for zone '{}': {}",
            zone_id,
            failure.reasons.join("; ")
        );
        finish_route(
            zone_id,
            &failure.provider_id,
            &failure.model,
            RouteOutcome::Failed,
            Some(&error),
        );
        error
    })
}

/// Why a whole chain gave no answer: every motive, and the last assignment
/// tried or skipped.
#[derive(Default)]
struct ChainFailure {
    provider_id: String,
    model: String,
    reasons: Vec<String>,
}

impl ChainFailure {
    fn note(&mut self, assignment: &ZoneAssignment, why: String) {
        self.provider_id.clone_from(&assignment.provider_id);
        self.model.clone_from(&assignment.model);
        self.reasons.push(why);
    }
}

/// A hard skip makes no attempt, so nothing else would record it: without this
/// the health panel stayed empty while every route failed.
fn record_skip(assignment: &ZoneAssignment, why: &str) {
    if let Err(e) = record_hard_skip(&assignment.provider_id, why) {
        tracing::warn!(provider = %assignment.provider_id, error = %e, "no se ha podido registrar el salto en metrics.json");
    }
}

/// Walk the chain: attempt every assignment that is not skipped, then the
/// cooled ones as a last resort. `Err` carries every skip/attempt motive.
fn walk_chain(
    chain: &[&ZoneAssignment],
    state: &ChainState<'_>,
    ctx: &AttemptCtx<'_>,
    cost_of: &dyn Fn(&str) -> f64,
) -> Result<String, ChainFailure> {
    let mut failure = ChainFailure::default();
    let mut cooled: Vec<(usize, &ZoneAssignment)> = Vec::new();
    for (chain_index, assignment) in chain.iter().copied().enumerate() {
        match skip_reason(assignment, state) {
            Some(Skip::Hard(why)) => {
                record_skip(assignment, &why);
                failure.note(assignment, why);
            }
            Some(Skip::Cooled(why)) => {
                failure.note(assignment, why);
                cooled.push((chain_index, assignment));
            }
            None => {
                let cost = cost_of(&assignment.provider_id);
                match attempt_assignment(ctx, assignment, cost, chain_index > 0) {
                    Ok(text) => return Ok(text),
                    Err(e) => failure.note(assignment, e),
                }
            }
        }
    }
    // Last resort: every non-cooled provider failed — try the cooled ones.
    for (chain_index, assignment) in cooled {
        let cost = cost_of(&assignment.provider_id);
        match attempt_assignment(ctx, assignment, cost, chain_index > 0) {
            Ok(text) => return Ok(text),
            Err(e) => failure.note(assignment, e),
        }
    }
    Err(failure)
}

/// Record the final outcome of a route in the metrics and the decision log.
/// A telemetry failure never fails the route: it is logged with its error.
fn finish_route(
    zone_id: &str,
    provider_id: &str,
    model: &str,
    outcome: RouteOutcome,
    error: Option<&str>,
) {
    if let Err(e) = record_route_outcome(outcome) {
        tracing::warn!(zone = zone_id, error = %e, "no se ha podido registrar la ruta en metrics.json");
    }
    if let Err(e) = log_route_decision(zone_id, provider_id, model, outcome, error) {
        tracing::warn!(zone = zone_id, error = %e, "no se ha podido escribir route-decisions.jsonl");
    }
}

/// Per-route data shared by every attempt of the chain.
struct AttemptCtx<'a> {
    zone_id: &'a str,
    prompt: &'a str,
    system_prompt: Option<&'a str>,
    primary_cost_per_mtok: f64,
}

/// One provider attempt inside [`route`]'s chain walk.
fn attempt_assignment(
    ctx: &AttemptCtx<'_>,
    assignment: &ZoneAssignment,
    cost_per_mtok: f64,
    used_fallback: bool,
) -> Result<String, String> {
    let has_free_tier_cap = free_tier_daily_limit(&assignment.provider_id).is_some();
    // The model that is really dispatched (ollama resolves its own active
    // local model), so metrics and the log never name a model nobody called.
    let model = dispatch_model(assignment);

    let started = Instant::now();
    let outcome = try_assignment_call(assignment, ctx.prompt, ctx.system_prompt);
    let latency_ms = started.elapsed().as_millis() as u64;

    let sample = MetricSample {
        provider_id: &assignment.provider_id,
        model: &model,
        success: outcome.is_ok(),
        output_tokens: outcome
            .as_ref()
            .map(|(c, _)| c.usage.output_tokens)
            .unwrap_or(0),
        cost_per_mtok,
        primary_cost_per_mtok: ctx.primary_cost_per_mtok,
        latency_ms,
        retry_count: outcome.as_ref().map(|(_, r)| *r).unwrap_or(0),
        fail_reason: outcome.as_ref().err().map(|(_, reason)| *reason),
        error: outcome.as_ref().err().map(|(e, _)| e.as_str()),
    };
    if let Err(e) = bump_metrics(sample) {
        tracing::warn!(provider = %assignment.provider_id, error = %e, "no se ha podido registrar el intento en metrics.json");
    }

    match outcome {
        Ok((co, _retry_count)) => {
            let route_outcome = if used_fallback {
                RouteOutcome::Fallback
            } else {
                RouteOutcome::Primary
            };
            finish_route(
                ctx.zone_id,
                &assignment.provider_id,
                &model,
                route_outcome,
                None,
            );
            Ok(co.text)
        }
        Err((e, reason)) => {
            let rate_limited = matches!(reason, FailReason::RateLimit | FailReason::Overloaded);
            if rate_limited && has_free_tier_cap {
                Err(format!(
                    "[{}/{}] 429 persistente en free-tier tras retries con \
                     backoff largo (2s/5s/10s, ventana RPM) — fallback",
                    assignment.provider_id, model
                ))
            } else {
                Err(format!("[{}/{}] {}", assignment.provider_id, model, e))
            }
        }
    }
}

#[cfg(test)]
#[path = "routing_tests.rs"]
mod tests;
