// Tests de `opencode_parse` y de los argumentos de `opencode`. Las líneas
// tienen la forma observada en OpenCode 1.19.4 (contenido recortado).

use super::*;

const STEP: &str =
    r#"{"type":"step_start","timestamp":1,"sessionID":"ses_a1","part":{"type":"step-start"}}"#;
const WRITE: &str = r#"{"type":"tool_use","timestamp":2,"sessionID":"ses_a1","part":{"type":"tool","tool":"write","state":{"status":"completed","input":{"filePath":"hola.txt","content":"hola"},"output":"Wrote file successfully.","metadata":{"filepath":"C:\\p\\hola.txt"},"title":"hola.txt"}}}"#;
const BASH_KO: &str = r#"{"type":"tool_use","timestamp":2,"sessionID":"ses_a1","part":{"type":"tool","tool":"bash","state":{"status":"error","input":{"command":"cargo test"},"error":"x"}}}"#;
const FIN_TOOLS: &str = r#"{"type":"step_finish","timestamp":3,"sessionID":"ses_a1","part":{"reason":"tool-calls","type":"step-finish","tokens":{"total":30626,"input":30537,"output":39,"reasoning":50,"cache":{"write":0,"read":0}},"cost":0}}"#;
const TEXTO: &str = r#"{"type":"text","timestamp":4,"sessionID":"ses_a1","part":{"type":"text","text":"hecho\n","time":{"start":1,"end":2}}}"#;
const FIN_STOP: &str = r#"{"type":"step_finish","timestamp":5,"sessionID":"ses_a1","part":{"reason":"stop","type":"step-finish","tokens":{"total":30664,"input":1303,"output":4,"reasoning":13,"cache":{"write":0,"read":29344}},"cost":0}}"#;
const ERROR: &str = r#"{"type":"error","timestamp":6,"sessionID":"ses_b2","error":{"name":"APIError","data":{"message":"Authentication Fails, Your api key: ****lida is invalid","statusCode":401}}}"#;

#[test]
fn un_turno_completo_da_respuesta_hilo_ediciones_y_tokens_acumulados() {
    let mut p = OpencodeParser::default();
    assert_eq!(p.line(STEP).thread_id.as_deref(), Some("ses_a1"));
    let w = p.line(WRITE).event.expect("evento");
    assert_eq!(
        (w.kind.as_str(), w.text.as_str()),
        ("patch", "update C:\\p\\hola.txt")
    );
    let f1 = p.line(FIN_TOOLS);
    assert!(!f1.completed, "tool-calls no cierra el turno");
    let t = p.line(TEXTO);
    assert_eq!(t.message.as_deref(), Some("hecho"));
    let fin = p.line(FIN_STOP);
    assert!(fin.completed);
    let u = fin.usage.expect("tokens");
    assert_eq!(u.input_tokens, 30537 + 1303 + 29344);
    assert_eq!(u.cached_input_tokens, 29344);
    assert_eq!(u.output_tokens, 39 + 50 + 4 + 13);
}

#[test]
fn un_error_marca_la_tarea_fallida_con_el_mensaje_del_proveedor() {
    let o = OpencodeParser::default().line(ERROR);
    assert!(o.failed);
    assert_eq!(o.thread_id.as_deref(), Some("ses_b2"));
    let e = o.event.expect("evento");
    assert_eq!(e.kind, "error");
    assert!(e.text.contains("Authentication Fails"), "{}", e.text);
}

#[test]
fn una_herramienta_fallida_se_ve_como_comando_con_error() {
    let e = OpencodeParser::default()
        .line(BASH_KO)
        .event
        .expect("evento");
    assert_eq!(e.text, "bash: cargo test (error)");
}

#[test]
fn una_linea_que_no_es_json_no_hace_nada() {
    assert_eq!(
        OpencodeParser::default().line("INFO arrancando"),
        LineOutcome::default()
    );
}

// Líneas reales de OpenCode 1.19.4 (clave inválida de DeepSeek, 2026-10-26).
const STREAM_PRINCIPAL: &str = r#"timestamp=2026-10-26T18:28:53.847Z level=ERROR run=6d80f16c message="stream error" providerID=deepseek modelID=deepseek-flash session.id=ses_e86870ca small=false agent=build mode=primary error.error="AI_APICallError: Service Unavailable""#;
const STREAM_PEQUENO: &str = r#"timestamp=2026-10-26T18:28:53.847Z level=ERROR run=6d80f16c message="stream error" providerID=openrouter modelID=x session.id=ses_e86870ca small=true agent=title mode=primary error.error="AI_RetryError: Key limit exceeded""#;
const FINAL: &str = r#"timestamp=2026-10-26T18:28:53.850Z level=ERROR run=6d80f16c message=process session.id=ses_e86870ca messageID=msg_1 error="Authentication Fails, Your api key: ****lida is invalid" stack="AI_APICallError: Authentication Fails\n    at <anonymous> (B:/~BUN/root/chunk.js:6:14263)""#;

#[test]
fn un_stream_error_que_opencode_reintentara_no_es_fallo() {
    assert!(
        fallo_stderr(STREAM_PRINCIPAL).is_none(),
        "falta el reintento"
    );
}

#[test]
fn un_fallo_del_modelo_pequeno_no_corta_el_turno() {
    assert!(fallo_stderr(STREAM_PEQUENO).is_none());
}

#[test]
fn el_fallo_final_del_turno_se_detecta_con_su_causa() {
    let c = fallo_stderr(FINAL).expect("fallo final");
    assert!(c.contains("Authentication Fails, Your api key"), "{c}");
    assert!(!c.contains("stack"), "{c}");
}

#[test]
fn un_desbordamiento_de_contexto_o_una_interrupcion_no_son_finales() {
    let compacta = FINAL.replace(
        "Authentication Fails, Your api key: ****lida is invalid",
        "prompt is too long: 210000 tokens",
    );
    assert!(
        fallo_stderr(&compacta).is_none(),
        "OpenCode compacta y sigue"
    );
    let cancelado = r#"level=ERROR message=process session.id=ses_a error="Aborted""#;
    assert!(fallo_stderr(cancelado).is_none());
}

#[test]
fn otras_lineas_de_stderr_no_cuentan_como_fallo() {
    assert!(fallo_stderr("level=INFO message=process error=\"x\"").is_none());
    let otro = r#"level=ERROR run=1 message=failed error="ProviderModelNotFoundError: x""#;
    assert!(
        fallo_stderr(otro).is_none(),
        "ese sale solo y lo cuenta stdout"
    );
    assert!(fallo_stderr("cualquier cosa").is_none());
}

#[test]
fn el_valor_admite_comillas_escapadas() {
    // Error definitivo (401): solo esos cortan el proceso; los transitorios los reintenta OpenCode.
    let l = r#"level=ERROR message=process error="AI_X: 401 dijo \"no\" y salió" stack="x""#;
    assert!(fallo_stderr(l)
        .expect("fallo")
        .ends_with(r#"AI_X: 401 dijo "no" y salió"#));
}
