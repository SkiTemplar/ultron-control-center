// Per-provider HTTP wrappers and utility helpers.
//
// Contains:
//   - truncate, clamp_max_tokens
//   - call_anthropic, call_openai_compat, call_gemini, call_ollama
//   - try_assignment_call

use crate::ai_router::api_format::openai_api_root;
use crate::ai_router::exec::{call_cli, with_retry};
use crate::ai_router::health::http_client;
use crate::ai_router::key_source::resolve_key;
use crate::ai_router::retry_hint;
use crate::ai_router::store::{detect_cli, load_providers, looks_like_placeholder};
use crate::ai_router::types::{
    ApiFormat, CallOutcome, FailReason, Provider, ProviderKind, TokenUsage, ZoneAssignment,
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/// Raw `Retry-After` header, read before the body consumes the response.
fn retry_after_header(resp: &reqwest::blocking::Response) -> Option<String> {
    resp.headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// `[retry-after=Ns]` marker for a rate-limited response, parsed from the
/// header or the FULL body (before truncation); empty otherwise.
fn retry_hint_suffix(reason: FailReason, header: Option<&str>, body: &str) -> String {
    if reason != FailReason::RateLimit {
        return String::new();
    }
    retry_hint::parse_retry_after(header, body)
        .map(retry_hint::marker)
        .unwrap_or_default()
}

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
    let key = resolve_key(&provider.key_env_var).ok_or_else(|| {
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
    let retry_after = retry_after_header(&resp);
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        let reason = FailReason::from_http_status(status.as_u16());
        let hint = retry_hint_suffix(reason, retry_after.as_deref(), &text);
        return Err((
            format!("anthropic {}: {}{}", status, truncate(&text, 200), hint),
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
    // Sin variable de key (p. ej. un servidor local personalizado) no se
    // manda cabecera de autorización.
    let key = if provider.key_env_var.is_empty() {
        None
    } else {
        Some(resolve_key(&provider.key_env_var).ok_or_else(|| {
            (
                format!("missing {} env var", provider.key_env_var),
                FailReason::Error,
            )
        })?)
    };
    let url = format!("{}/chat/completions", openai_api_root(&provider.base_url));
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
    let mut req = client.post(&url);
    if let Some(key) = key {
        req = req.header("Authorization", format!("Bearer {}", key));
    }
    let resp = req
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
    let retry_after = retry_after_header(&resp);
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        let reason = FailReason::from_http_status(status.as_u16());
        let hint = retry_hint_suffix(reason, retry_after.as_deref(), &text);
        return Err((
            format!(
                "{} {}: {}{}",
                provider.id,
                status,
                truncate(&text, 200),
                hint
            ),
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
    let key = resolve_key(&provider.key_env_var).ok_or_else(|| {
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
        // thinkingBudget:0 disables the "thinking" phase on Gemini flash models
        // (verified on gemini-2.5-flash and, again, on gemini-3.8-flash on
        // 2026-09-11) so the model actually writes output tokens instead of
        // burning the entire budget on hidden reasoning and returning an empty
        // candidates[].content.
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
    // (2026-09-16) La clave viaja por la cabecera `x-goog-api-key`, NO por
    // `?key=` en la query string: la API de Gemini admite ambas formas, pero
    // reqwest::Error imprime la URL completa (con query incluida) en su
    // `Display` cuando el envio falla a nivel de red — eso dejaba la clave en
    // claro en el mensaje de error, que `apply_metric_sample` persistia tal
    // cual en `metrics.json` (`by_class.gemini.last_error`). Por cabecera, la
    // URL que reqwest puede llegar a mostrar en un error nunca lleva la clave.
    let resp = client
        .post(&url)
        .header("x-goog-api-key", key)
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
    let retry_after = retry_after_header(&resp);
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        let reason = FailReason::from_http_status(status.as_u16());
        let hint = retry_hint_suffix(reason, retry_after.as_deref(), &text);
        return Err((
            format!("gemini {}: {}{}", status, truncate(&text, 200), hint),
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

/// Cuerpo base de `POST /api/generate` para las llamadas internas a Ollama
/// (captura de memoria, resúmenes, títulos — también las que llegan desde el
/// sidecar que lanzan los hooks de cualquier sesión de Claude Code). Función
/// pura y testeable, separada del `spawn`/HTTP de `call_ollama`.
///
/// `keep_alive` lo decide `ollama_keep_alive`: `0` para un modelo suelto y
/// el plazo del motor para el modelo del motor local activo.
pub(crate) fn build_ollama_generate_body(
    model: &str,
    prompt: &str,
    active_local: Option<(&str, &str)>,
) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "keep_alive": ollama_keep_alive(model, active_local),
    })
}

/// `keep_alive` de una llamada interna a Ollama.
///
/// `0` por defecto: sin él, Ollama aplica SU plazo de 5 minutos, y estas
/// llamadas son sueltas — nadie gana nada con que el modelo se quede en VRAM
/// tras cada una (medido el 2026-09-21: 8,6 GB tomados 5 min tras cerrar la
/// aplicación, visibles con `ollama ps`).
///
/// Si `model` es el del motor local activo (`active_local` = modelo y plazo),
/// se reenvía el plazo del motor (`"5m"`, `"10m"` u `ollamaTab.keepAlive`):
/// con `0` cada despacho del router echaría de VRAM el modelo del
/// autocompletado, y con otro valor alteraría su caducidad (Ollama la
/// reajusta con el `keep_alive` de cada petición).
pub(crate) fn ollama_keep_alive(
    model: &str,
    active_local: Option<(&str, &str)>,
) -> serde_json::Value {
    match active_local {
        Some((active, keep_alive)) if crate::ollama::switch::same_model(active, model) => {
            crate::ollama::editor::keep_alive_json(keep_alive)
        }
        _ => serde_json::Value::from(0),
    }
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
    let active = crate::ollama::engine::active_local_model();
    let mut body = build_ollama_generate_body(
        model,
        prompt,
        active.as_ref().map(|(m, k)| (m.as_str(), k.as_str())),
    );
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
    let retry_after = retry_after_header(&resp);
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        let reason = FailReason::from_http_status(status.as_u16());
        let hint = retry_hint_suffix(reason, retry_after.as_deref(), &text);
        return Err((
            format!("ollama {}: {}{}", status, truncate(&text, 200), hint),
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

/// The model that `try_assignment_call` really dispatches for `assignment`.
///
/// For `ollama` it is the active local model (`ollama::toggle::model_name`:
/// env > editor's local engine > `cockpit/ollama/config.json`), NOT the
/// assignment's fixed model; every other provider gets `assignment.model`.
/// Metrics and the route-decision log use this so they never record a model
/// that was not called (2026-10-23: they logged `qwen2.5-coder:32b`, which is
/// not even installed on this machine).
pub(crate) fn dispatch_model(assignment: &ZoneAssignment) -> String {
    if assignment.provider_id == "ollama" {
        crate::ollama::toggle::model_name()
    } else {
        assignment.model.clone()
    }
}

/// Try a single provider+model assignment with up to 3 retries for transient
/// errors on HTTP providers (cloud and the local ollama). CLI providers are
/// not retried.
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
                format!(
                    "unknown provider '{}' (not in cockpit/ai-router/providers.json; \
                     fix the zone in AI Router > Zones)",
                    assignment.provider_id
                ),
                FailReason::Error,
            )
        })?
        .clone();

    let is_cli = provider.kind == ProviderKind::Cli || provider.api_format == ApiFormat::Cli;
    match provider.kind {
        _ if is_cli => {
            let cmd = provider.cli_command.as_deref().unwrap_or("").trim();
            if cmd.is_empty() {
                return Err((
                    format!(
                        "provider '{}' uses api_format 'cli' but has no cli_command \
                         (set it in cockpit/ai-router/providers.json)",
                        assignment.provider_id
                    ),
                    FailReason::Error,
                ));
            }
            if !detect_cli(cmd) {
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
            return call_cli(&provider, prompt, &assignment.model).map(|co| (co, 0));
        }
        ProviderKind::Cloud if !provider.key_env_var.is_empty() => {
            match resolve_key(&provider.key_env_var) {
                Some(v) if !v.trim().is_empty() && !looks_like_placeholder(&v) => {}
                _ => {
                    return Err((
                        format!(
                            "Provider '{}' has no API key. \
                             Set {} or configure it in Settings > API Keys.",
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
    match provider.api_format {
        ApiFormat::Anthropic => with_retry(MAX_RETRIES, || {
            call_anthropic(
                &provider,
                &assignment.model,
                prompt,
                system_prompt,
                assignment.max_tokens,
            )
        }),
        ApiFormat::OpenaiCompat => with_retry(MAX_RETRIES, || {
            call_openai_compat(
                &provider,
                &assignment.model,
                prompt,
                system_prompt,
                assignment.max_tokens,
            )
        }),
        ApiFormat::Gemini => with_retry(MAX_RETRIES, || {
            call_gemini(
                &provider,
                &assignment.model,
                prompt,
                system_prompt,
                assignment.max_tokens,
            )
        }),
        ApiFormat::Ollama => {
            // (2026-09-16) El modelo local activo lo resuelve
            // `dispatch_model` (precedencia env > modelo del motor local del
            // editor, ver `ollama::engine`), NO el modelo fijo que trae la
            // ZoneAssignment del zones.json: `qwen2.5-coder:32b` no está
            // descargado y no cabe en 8 GB de VRAM en esta máquina. Las
            // métricas y el log de rutas usan la misma función, así que
            // registran el modelo que de verdad se llama.
            let model = dispatch_model(assignment);
            with_retry(MAX_RETRIES, || {
                call_ollama(
                    &provider,
                    &model,
                    prompt,
                    system_prompt,
                    assignment.max_tokens,
                )
            })
        }
        // `Cli` ya salió arriba; queda aquí solo para que el match sea total.
        ApiFormat::Unknown | ApiFormat::Cli => Err((
            format!(
                "no wrapper implemented for provider '{}': unknown api_format; set one of openai_compat, \
                 anthropic, gemini, ollama or cli in cockpit/ai-router/providers.json",
                provider.id
            ),
            FailReason::Error,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_cuerpo_de_ollama_suelta_el_modelo_al_acabar() {
        let body = build_ollama_generate_body("qwen2.5-coder:7b", "hola", None);
        assert_eq!(
            body.get("keep_alive").and_then(|v| v.as_i64()),
            Some(0),
            "sin keep_alive:0 Ollama aplica su plazo por defecto de 5 minutos"
        );
        assert_eq!(
            body.get("model").and_then(|v| v.as_str()),
            Some("qwen2.5-coder:7b")
        );
        assert_eq!(body.get("prompt").and_then(|v| v.as_str()), Some("hola"));
        assert_eq!(body.get("stream").and_then(|v| v.as_bool()), Some(false));
    }

    /// El modelo del motor local activo se reenvía con el plazo del motor:
    /// el router lo usa sin echarlo de VRAM ni cambiar su caducidad.
    #[test]
    fn el_modelo_del_motor_activo_conserva_su_plazo() {
        let body = build_ollama_generate_body(
            "qwen2.5-coder:3b-base",
            "hola",
            Some(("qwen2.5-coder:3b-base", "5m")),
        );
        assert_eq!(body.get("keep_alive"), Some(&serde_json::json!("5m")));
        assert_eq!(
            ollama_keep_alive("llama3", Some(("llama3:latest", "10m"))),
            serde_json::json!("10m")
        );
    }

    /// Caso negativo: ya no se fija indefinidamente (`-1`) el modelo del
    /// motor, salvo que el usuario lo pida con `ollamaTab.keepAlive`.
    #[test]
    fn el_modelo_del_motor_no_se_fija_indefinidamente() {
        let value = ollama_keep_alive("m:3b", Some(("m:3b", "5m")));
        assert_ne!(value, serde_json::json!(-1));
        assert_eq!(
            ollama_keep_alive("m:3b", Some(("m:3b", "-1"))),
            serde_json::json!(-1)
        );
    }

    /// Caso negativo: con OTRO modelo activo (o ninguno), el del router se
    /// suelta igual que antes.
    #[test]
    fn un_modelo_distinto_del_activo_se_suelta() {
        assert_eq!(
            ollama_keep_alive(
                "qwen2.5-coder:7b-base",
                Some(("qwen2.5-coder:3b-base", "5m"))
            ),
            serde_json::json!(0)
        );
        assert_eq!(
            ollama_keep_alive("qwen2.5-coder:3b-base", None),
            serde_json::json!(0)
        );
    }

    /// Caso negativo: un cuerpo construido a mano sin la clave no puede
    /// colarse como si ya soltase el modelo.
    #[test]
    fn un_cuerpo_sin_keep_alive_no_pasa_la_comprobacion() {
        let body = serde_json::json!({
            "model": "qwen2.5-coder:7b",
            "prompt": "hola",
            "stream": false,
        });
        assert_eq!(body.get("keep_alive"), None);
    }
}
