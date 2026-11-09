// Tests de `opencode_parse::fallo_stderr` con la lógica invertida: solo
// abortan los reintentos agotados y los errores no reintentables reconocibles.

use super::fallo_stderr;

/// Línea de `halt` del procesador de turnos con `error` como causa.
fn halt(error: &str) -> String {
    let error = error.replace('"', "\\\"");
    format!(
        r#"timestamp=2026-10-26T18:28:53.850Z level=ERROR run=6d80f16c message=process session.id=ses_e86870ca messageID=msg_1 error="{error}" stack="AI_APICallError\n    at <anonymous> (B:/~BUN/root/chunk.js:401:14263)""#
    )
}

/// `stream error` del modelo principal o del pequeño con `error` como causa.
fn stream(small: bool, error: &str) -> String {
    let error = error.replace('"', "\\\"");
    format!(
        r#"timestamp=2026-10-26T18:28:53.847Z level=ERROR run=6d80f16c message="stream error" providerID=x modelID=y session.id=ses_e86870ca small={small} agent=build mode=primary error.error="{error}""#
    )
}

#[test]
fn los_reintentos_agotados_abortan_en_el_halt_y_en_el_stream_principal() {
    let e = "AI_RetryError: Failed after 3 attempts. Last error: Free usage limit reached";
    assert!(fallo_stderr(&halt(e)).is_some());
    assert!(
        fallo_stderr(&stream(false, e)).is_some(),
        "como delegate.mjs"
    );
    assert!(fallo_stderr(&stream(true, e)).is_none(), "modelo pequeño");
    let sin_nombre = "Failed after 5 attempts. Last error: Service Unavailable";
    assert!(fallo_stderr(&halt(sin_nombre)).is_some());
}

#[test]
fn los_errores_no_reintentables_reales_abortan() {
    let reales = [
        // Gemini con el contexto excedido.
        "AI_APICallError: The input token count (1201234) exceeds the maximum number of tokens allowed (1048576).",
        // Anthropic: request_too_large.
        r#"AI_APICallError: {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}"#,
        // Groq: tokens por minuto (un 429 que no se arregla reintentando).
        "Request too large for model llama-3.3-70b-versatile on tokens per minute (TPM): Limit 12000, Requested 20000",
        "AI_APICallError: This model's maximum context length is 131072 tokens",
        "Insufficient Balance",
        "AI_APICallError: Payment Required",
        "Request failed with status code 401",
        "AI_APICallError: 403 Forbidden",
    ];
    for e in reales {
        let c = fallo_stderr(&halt(e)).unwrap_or_else(|| panic!("no abortó: {e}"));
        assert!(c.contains(e.trim_start_matches("AI_APICallError: ")), "{c}");
    }
}

#[test]
fn los_errores_reintentables_no_abortan() {
    let reintentables = [
        "AI_APICallError: Service Unavailable",
        "AI_APICallError: 503 This model is currently experiencing high demand. Please try again later.",
        "AI_APICallError: 429 Too Many Requests: rate limit exceeded",
        "AI_APICallError: overloaded_error",
        "prompt is too long: 210000 tokens",
    ];
    for e in reintentables {
        assert!(fallo_stderr(&halt(e)).is_none(), "abortó: {e}");
        assert!(fallo_stderr(&stream(false, e)).is_none(), "abortó: {e}");
    }
}

#[test]
fn un_codigo_dentro_de_otro_numero_o_en_la_traza_no_cuenta() {
    assert!(fallo_stderr(&halt("AI_APICallError: upstream 14013 reset")).is_none());
    assert!(
        fallo_stderr(&halt("AI_APICallError: Bad Gateway")).is_none(),
        "la traza lleva chunk.js:401"
    );
}
