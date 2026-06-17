// Per-provider HTTP wrappers and routing logic.
//
// Contains:
//   - truncate helper
//   - clamp_max_tokens
//   - call_anthropic, call_openai_compat, call_gemini, call_ollama
//   - try_assignment_call
//   - MetricSample, bump_metrics, apply_metric_sample
//   - load_metrics_and_bump_route_counters
//   - route, primary_model_for_zone, attempt_assignment

use std::time::Instant;

use super::exec::{call_cli, with_retry};
use super::health::http_client;
use super::store::{
    detect_cli, disabled_providers_set, load_metrics, load_providers, load_zones,
    looks_like_placeholder, write_json,
};
use super::types::{
    free_tier_daily_limit, metrics_path, CallOutcome, FailReason, Provider, ProviderKind,
    RouterMetrics, TokenUsage, ZoneAssignment, HEALTH_GATE_CONSECUTIVE_FAILURES,
    HEALTH_GATE_COOLDOWN_MINUTES,
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/// Truncate `s` to at most `max` Unicode scalar values, appending `...`.
pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("...");
    out
}

pub(crate) fn clamp_max_tokens(requested: u32, default: u32) -> u32 {
    if requested == 0 {
        default
    } else {
        requested.min(8192)
    }
}

// ---------------------------------------------------------------------------
// Per-provider call wrappers
// ---------------------------------------------------------------------------

pub(crate) fn call_anthropic(
    provider: &Provider,
    model: &str,
    prompt: &str,
    system: Option<&str>,
    max_tokens: u32,
) -> Result<CallOutcome, (String, FailReason)> {
    let client = http_client().map_err(|e| (e, FailReason::Error))?;
    let key = std::env::var(&provider.key_env_var).map_err(|_| {
        (
            format!("missing {} env var", provider.key_env_var),
            FailReason::Error,
        )
    })?;
    let url = format!("{}/v1/messages", provider.base_url.trim_end_matches('/'));
    // KIRKARDO R11.3 FIX-4: wrap the system prompt in an ephemeral cache
    // breakpoint so Anthropic deduplicates stable system text across calls.
    let system_value = match system {
        Some(s) if s.len() >= 32 => serde_json::json!([
            {
                "type": "text",
                "text": s,
                "cache_control": { "type": "ephemeral" }
            }
        ]),
        Some(s) => serde_json::Value::String(s.to_string()),
        None => serde_json::Value::String(String::new()),
    };
    let body = serde_json::json!({
        "model": model,
        "max_tokens": clamp_max_tokens(max_tokens, 1024),
        "system": system_value,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let resp = client
        .post(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| {
            let reason = if e.is_timeout() {
                FailReason::Timeout
            } else {
                FailReason::Error
            };
            (format!("anthropic request failed: {}", e), reason)
        })?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        let reason = FailReason::from_http_status(status.as_u16());
        return Err((
            format!("anthropic {}: {}", status, truncate(&text, 200)),
            reason,
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        (
            format!("parse anthropic response: {}", e),
            FailReason::Error,
        )
    })?;
    let out = v
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let out = out.ok_or_else(|| {
        (
            "anthropic returned no text in content block".to_string(),
            FailReason::Error,
        )
    })?;
    let usage = TokenUsage {
        input_tokens: v
            .pointer("/usage/input_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        output_tokens: v
            .pointer("/usage/output_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
    };
    Ok(CallOutcome {
        text: out.to_string(),
        usage,
    })
}

pub(crate) fn call_openai_compat(
    provider: &Provider,
    model: &str,
    prompt: &str,
    system: Option<&str>,
    max_tokens: u32,
) -> Result<CallOutcome, (String, FailReason)> {
    let client = http_client().map_err(|e| (e, FailReason::Error))?;
    let key = std::env::var(&provider.key_env_var).map_err(|_| {
        (
            format!("missing {} env var", provider.key_env_var),
            FailReason::Error,
        )
    })?;
    let url = format!(
        "{}/v1/chat/completions",
        provider.base_url.trim_end_matches('/')
    );
    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = system {
        if !sys.is_empty() {
            messages.push(serde_json::json!({ "role": "system", "content": sys }));
        }
    }
    messages.push(serde_json::json!({ "role": "user", "content": prompt }));
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": clamp_max_tokens(max_tokens, 1024),
    });
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| {
            let reason = if e.is_timeout() {
                FailReason::Timeout
            } else {
                FailReason::Error
            };
            (format!("{} request failed: {}", provider.id, e), reason)
        })?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        let reason = FailReason::from_http_status(status.as_u16());
        return Err((
            format!("{} {}: {}", provider.id, status, truncate(&text, 200)),
            reason,
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        (
            format!("parse {} response: {}", provider.id, e),
            FailReason::Error,
        )
    })?;
    let out = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let out = out.ok_or_else(|| {
        (
            format!(
                "{} returned no text in choices[0].message.content",
                provider.id
            ),
            FailReason::Error,
        )
    })?;
    let usage = TokenUsage {
        input_tokens: v
            .pointer("/usage/prompt_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        output_tokens: v
            .pointer("/usage/completion_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
    };
    Ok(CallOutcome {
        text: out.to_string(),
        usage,
    })
}

pub(crate) fn call_gemini(
    provider: &Provider,
    model: &str,
    prompt: &str,
    system: Option<&str>,
    max_tokens: u32,
) -> Result<CallOutcome, (String, FailReason)> {
    let client = http_client().map_err(|e| (e, FailReason::Error))?;
    let key = std::env::var(&provider.key_env_var).map_err(|_| {
        (
            format!("missing {} env var", provider.key_env_var),
            FailReason::Error,
        )
    })?;
    let url = format!(
        "{}/v1beta/models/{}:generateContent",
        provider.base_url.trim_end_matches('/'),
        model
    );
    let mut body = serde_json::json!({
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        // thinkingBudget:0 disables the "thinking" phase on gemini-2.5-flash so
        // the model actually writes output tokens instead of burning the entire
        // budget on hidden reasoning and returning an empty candidates[].content.
        "generationConfig": {
            "maxOutputTokens": clamp_max_tokens(max_tokens, 1024),
            "thinkingConfig": { "thinkingBudget": 0 }
        },
    });
    if let Some(sys) = system {
        if !sys.is_empty() {
            body["systemInstruction"] = serde_json::json!({ "parts": [{ "text": sys }] });
        }
    }
    let resp = client
        .post(&url)
        .query(&[("key", key)])
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| {
            let reason = if e.is_timeout() {
                FailReason::Timeout
            } else {
                FailReason::Error
            };
            (format!("gemini request failed: {}", e), reason)
        })?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        let reason = FailReason::from_http_status(status.as_u16());
        return Err((
            format!("gemini {}: {}", status, truncate(&text, 200)),
            reason,
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| (format!("parse gemini response: {}", e), FailReason::Error))?;
    let out = v
        .get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let out = out.ok_or_else(|| {
        (
            "gemini returned no text (thinking may have consumed the output budget)".to_string(),
            FailReason::Error,
        )
    })?;
    let usage = TokenUsage {
        input_tokens: v
            .pointer("/usageMetadata/promptTokenCount")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        output_tokens: v
            .pointer("/usageMetadata/candidatesTokenCount")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
    };
    Ok(CallOutcome {
        text: out.to_string(),
        usage,
    })
}

pub(crate) fn call_ollama(
    provider: &Provider,
    model: &str,
    prompt: &str,
    system: Option<&str>,
    _max_tokens: u32,
) -> Result<CallOutcome, (String, FailReason)> {
    let client = http_client().map_err(|e| (e, FailReason::Error))?;
    let tags_url = format!("{}/api/tags", provider.base_url.trim_end_matches('/'));
    if client.get(&tags_url).send().is_err() {
        return Err((
            "Ollama is not running. Start it with `ollama serve` or install it from \
             https://ollama.com/."
                .into(),
            FailReason::Error,
        ));
    }
    let url = format!("{}/api/generate", provider.base_url.trim_end_matches('/'));
    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
    });
    if let Some(sys) = system {
        if !sys.is_empty() {
            body["system"] = serde_json::Value::String(sys.to_string());
        }
    }
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| {
            let reason = if e.is_timeout() {
                FailReason::Timeout
            } else {
                FailReason::Error
            };
            (format!("ollama request failed: {}", e), reason)
        })?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        let reason = FailReason::from_http_status(status.as_u16());
        return Err((
            format!("ollama {}: {}", status, truncate(&text, 200)),
            reason,
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| (format!("parse ollama response: {}", e), FailReason::Error))?;
    let out = v
        .get("response")
        .and_then(|r| r.as_str())
        .unwrap_or("(no response field)")
        .to_string();
    let usage = TokenUsage {
        input_tokens: v
            .get("prompt_eval_count")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        output_tokens: v.get("eval_count").and_then(|x| x.as_u64()).unwrap_or(0),
    };
    Ok(CallOutcome { text: out, usage })
}

// ---------------------------------------------------------------------------
// Assignment call (with retry)
// ---------------------------------------------------------------------------

/// Try a single provider+model assignment with up to 3 retries for transient
/// errors on cloud providers. CLI and local providers are not retried.
///
/// Returns `(CallOutcome, retry_count)` on success; `(error_msg, FailReason)`
/// on terminal failure.
pub(crate) fn try_assignment_call(
    assignment: &ZoneAssignment,
    prompt: &str,
    system_prompt: Option<&str>,
) -> Result<(CallOutcome, u32), (String, FailReason)> {
    let providers = load_providers().map_err(|e| (e, FailReason::Error))?;
    let provider = providers
        .iter()
        .find(|p| p.id == assignment.provider_id)
        .ok_or_else(|| {
            (
                format!("unknown provider '{}'", assignment.provider_id),
                FailReason::Error,
            )
        })?
        .clone();

    match provider.kind {
        ProviderKind::Cli => {
            let cmd = provider.cli_command.as_deref().unwrap_or("");
            if cmd.is_empty() || !detect_cli(cmd) {
                let install_hint = match cmd {
                    "codex" => "Install with: npm install -g @openai/codex",
                    "gemini" => "Install with: npm install -g @google/gemini-cli",
                    _ => "Install the CLI and ensure it is on PATH",
                };
                return Err((
                    format!("CLI '{}' not found on PATH. {}", cmd, install_hint),
                    FailReason::Error,
                ));
            }
            return call_cli(&provider, prompt).map(|co| (co, 0));
        }
        ProviderKind::Cloud if !provider.key_env_var.is_empty() => {
            match std::env::var(&provider.key_env_var) {
                Ok(v) if !v.trim().is_empty() && !looks_like_placeholder(&v) => {}
                _ => {
                    return Err((
                        format!(
                            "Provider '{}' has no API key. \
                             Set {} or configure it in Settings > AI Router.",
                            assignment.provider_id, provider.key_env_var
                        ),
                        FailReason::Error,
                    ));
                }
            }
        }
        _ => {}
    }

    const MAX_RETRIES: u32 = 3;
    match provider.id.as_str() {
        "claude-haiku" => with_retry(MAX_RETRIES, || {
            call_anthropic(
                &provider,
                &assignment.model,
                prompt,
                system_prompt,
                assignment.max_tokens,
            )
        }),
        "codex" | "groq" | "deepseek" => with_retry(MAX_RETRIES, || {
            call_openai_compat(
                &provider,
                &assignment.model,
                prompt,
                system_prompt,
                assignment.max_tokens,
            )
        }),
        "gemini" => with_retry(MAX_RETRIES, || {
            call_gemini(
                &provider,
                &assignment.model,
                prompt,
                system_prompt,
                assignment.max_tokens,
            )
        }),
        "ollama" => with_retry(MAX_RETRIES, || {
            call_ollama(
                &provider,
                &assignment.model,
                prompt,
                system_prompt,
                assignment.max_tokens,
            )
        }),
        other => Err((
            format!("no wrapper implemented for provider '{}'", other),
            FailReason::Error,
        )),
    }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/// Una muestra de métricas tras un intento de ruta.
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
        *pm = super::types::ClassMetrics::default();
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
        *mm = super::types::ModelMetrics::default();
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
        super::store::read_json(&path).unwrap_or_default()
    } else {
        RouterMetrics::default()
    };
    metrics.routes_total = metrics.routes_total.saturating_add(1);
    if used_fallback {
        metrics.real_fallback_count = metrics.real_fallback_count.saturating_add(1);
    }
    write_json(&path, &metrics)
}

// ---------------------------------------------------------------------------
// Route function
// ---------------------------------------------------------------------------

/// Public read-only accessor: the primary model id configured for a zone.
/// `None` if the zone is unknown or zones cannot be loaded.
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
