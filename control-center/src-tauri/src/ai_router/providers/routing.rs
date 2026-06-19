// Route function and zone-walking logic.
//
// Contains:
//   - primary_model_for_zone
//   - route
//   - attempt_assignment (private)

use std::time::Instant;

use crate::ai_router::store::{disabled_providers_set, load_metrics, load_providers, load_zones};
use crate::ai_router::types::{free_tier_daily_limit, FailReason, ZoneAssignment};

use super::call_wrappers::try_assignment_call;
use super::metrics::{bump_metrics, load_metrics_and_bump_route_counters, MetricSample};

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

/// Route a prompt through the zone's provider chain, falling back on failure.
///
/// This is the real router entrypoint used by all internal Rust callers:
/// cost_watchdog.rs, hooks_admin.rs, workdays.rs, plugins_info.rs, etc.
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
    let primary_cost = cost_of(&zone.primary.provider_id);

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let metrics_snapshot = load_metrics().unwrap_or_default();

    let mut last_error = String::new();
    let chain: Vec<&ZoneAssignment> = std::iter::once(&zone.primary)
        .chain(zone.fallbacks.iter())
        .collect();

    let now_utc = chrono::Utc::now();
    let mut cooled: Vec<(usize, &ZoneAssignment)> = Vec::new();

    for (chain_index, assignment) in chain.iter().copied().enumerate() {
        if disabled.contains(&assignment.provider_id) {
            last_error = format!(
                "[{}/{}] skipped — provider has no API key \
                 (set the key env var or configure in Settings > AI Router)",
                assignment.provider_id, assignment.model
            );
            continue;
        }

        if let Some(daily_limit) = free_tier_daily_limit(&assignment.provider_id) {
            let used = metrics_snapshot
                .daily
                .get(&assignment.provider_id)
                .filter(|d| d.date == today)
                .map(|d| d.count)
                .unwrap_or(0);
            if used >= daily_limit {
                last_error = format!(
                    "[{}/{}] skipped — daily free-tier quota exhausted \
                     ({}/{} requests today)",
                    assignment.provider_id, assignment.model, used, daily_limit
                );
                continue;
            }
        }

        if let Some(cm) = metrics_snapshot.by_class.get(&assignment.provider_id) {
            if cm.date == today {
                if let Some(until) = cm.cooldown_until.as_deref() {
                    let still_cooling = chrono::DateTime::parse_from_rfc3339(until)
                        .map(|t| t > now_utc)
                        .unwrap_or(false);
                    if still_cooling {
                        last_error = format!(
                            "[{}/{}] soft-skipped — health cooldown until {} \
                             ({} consecutive failures; last: {})",
                            assignment.provider_id,
                            assignment.model,
                            until,
                            cm.consecutive_failures,
                            cm.last_error.as_deref().unwrap_or("?")
                        );
                        cooled.push((chain_index, assignment));
                        continue;
                    }
                }
            }
        }

        match attempt_assignment(
            assignment,
            prompt,
            zone.system_prompt.as_deref(),
            cost_of(&assignment.provider_id),
            primary_cost,
            chain_index > 0,
        ) {
            Ok(text) => return Ok(text),
            Err(e) => last_error = e,
        }
    }

    // Last resort: every non-cooled provider failed — try the cooled ones.
    for (chain_index, assignment) in cooled {
        match attempt_assignment(
            assignment,
            prompt,
            zone.system_prompt.as_deref(),
            cost_of(&assignment.provider_id),
            primary_cost,
            chain_index > 0,
        ) {
            Ok(text) => return Ok(text),
            Err(e) => last_error = e,
        }
    }
    let _ = load_metrics_and_bump_route_counters(false);
    Err(format!(
        "all providers failed for zone '{}': {}",
        zone_id, last_error
    ))
}

/// One provider attempt inside [`route`]'s chain walk.
fn attempt_assignment(
    assignment: &ZoneAssignment,
    prompt: &str,
    system_prompt: Option<&str>,
    cost_per_mtok: f64,
    primary_cost_per_mtok: f64,
    used_fallback: bool,
) -> Result<String, String> {
    let has_free_tier_cap = free_tier_daily_limit(&assignment.provider_id).is_some();

    let started = Instant::now();
    let outcome = try_assignment_call(assignment, prompt, system_prompt);
    let latency_ms = started.elapsed().as_millis() as u64;

    let is_rate_limited = outcome.as_ref().err().is_some_and(|(_, reason)| {
        matches!(reason, FailReason::RateLimit | FailReason::Overloaded)
    });

    let success = outcome.is_ok();
    let out_tokens = outcome
        .as_ref()
        .map(|(c, _)| c.usage.output_tokens)
        .unwrap_or(0);
    let retry_count = outcome.as_ref().map(|(_, r)| *r).unwrap_or(0);
    let fail_reason = outcome.as_ref().err().map(|(_, reason)| *reason);
    let error_msg = outcome.as_ref().err().map(|(e, _)| e.as_str());

    let _ = bump_metrics(MetricSample {
        provider_id: &assignment.provider_id,
        model: &assignment.model,
        success,
        output_tokens: out_tokens,
        cost_per_mtok,
        primary_cost_per_mtok,
        latency_ms,
        mode: None,
        retry_count,
        fail_reason,
        error: error_msg,
    });

    match outcome {
        Ok((co, _retry_count)) => {
            let _ = load_metrics_and_bump_route_counters(used_fallback);
            Ok(co.text)
        }
        Err((e, _reason)) => {
            if is_rate_limited && has_free_tier_cap {
                Err(format!(
                    "[{}/{}] 429 on free-tier provider — quota exhausted, \
                     skipping without backoff",
                    assignment.provider_id, assignment.model
                ))
            } else {
                Err(format!(
                    "[{}/{}] {}",
                    assignment.provider_id, assignment.model, e
                ))
            }
        }
    }
}
