// Per-provider HTTP wrappers and utility helpers.
//
// Contains:
//   - truncate, clamp_max_tokens
//   - call_anthropic, call_openai_compat, call_gemini, call_ollama
//   - try_assignment_call

use crate::ai_router::exec::{call_cli, with_retry};
use crate::ai_router::health::http_client;
use crate::ai_router::store::{detect_cli, load_providers, looks_like_placeholder};
use crate::ai_router::types::{
    CallOutcome, FailReason, Provider, ProviderKind, TokenUsage, ZoneAssignment,
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
        "claude" | "claude-haiku" => with_retry(MAX_RETRIES, || {
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
