// sesiones/tests_codex.rs — Tests del parser de `codex exec --json`.
// Líneas con la forma observada en codex-cli 0.154 (contenido inventado).

use super::*;

#[test]
fn mensaje_del_agente_es_resumen() {
    let o = parse_exec_line(
        r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"listo\n"}}"#,
    );
    assert_eq!(o.message.as_deref(), Some("listo"));
    assert_eq!(
        o.event,
        Some(CodexEvent {
            kind: "message".into(),
            text: "listo".into()
        })
    );
    assert!(!o.failed);
}

#[test]
fn comandos_en_curso_y_terminados() {
    let started = parse_exec_line(
        r#"{"type":"item.started","item":{"id":"i","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}"#,
    );
    assert_eq!(started.event.map(|e| e.text), Some("en curso: ls".into()));
    let done = parse_exec_line(
        r#"{"type":"item.completed","item":{"id":"i","type":"command_execution","command":"ls","aggregated_output":"","exit_code":0,"status":"completed"}}"#,
    );
    let e = done.event.expect("evento");
    assert_eq!(
        (e.kind.as_str(), e.text.as_str()),
        ("command", "ls (salida 0)")
    );
}

#[test]
fn cambios_de_ficheros() {
    let o = parse_exec_line(
        r#"{"type":"item.completed","item":{"id":"i","type":"file_change","changes":[{"path":"a.txt","kind":"add"},{"path":"b.rs","kind":"update"}],"status":"completed"}}"#,
    );
    let e = o.event.expect("evento");
    assert_eq!(e.kind, "patch");
    assert_eq!(e.text, "add a.txt\nupdate b.rs");
}

#[test]
fn errores_y_fallos() {
    let f = parse_exec_line(r#"{"type":"turn.failed","error":{"message":"sin cuota"}}"#);
    assert!(f.failed);
    assert_eq!(f.event.map(|e| e.text), Some("sin cuota".into()));
    let e = parse_exec_line(r#"{"type":"error","message":"desconectado"}"#);
    assert!(!e.failed, "un error de primer nivel se decide al final");
    assert_eq!(e.provisional_error.as_deref(), Some("desconectado"));
    let aviso = parse_exec_line(
        r#"{"type":"item.completed","item":{"id":"i","type":"error","message":"aviso"}}"#,
    );
    assert!(
        !aviso.failed,
        "un item de error es un aviso, no hace fallar la tarea"
    );
    assert_eq!(aviso.event.map(|e| e.kind), Some("warning".into()));
}

#[test]
fn el_hilo_se_guarda_para_reanudar() {
    let o = parse_exec_line(r#"{"type":"thread.started","thread_id":"x"}"#);
    assert_eq!(o.thread_id.as_deref(), Some("x"));
    assert_eq!(o.event, None);
    assert!(!o.failed);
}

#[test]
fn los_tokens_del_turno_se_guardan() {
    let o = parse_exec_line(
        r#"{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":800,"output_tokens":95}}"#,
    );
    assert_eq!(
        o.usage,
        Some(crate::sesiones::types::EngineUsage {
            input_tokens: 1200,
            cached_input_tokens: 800,
            output_tokens: 95,
        })
    );
    assert_eq!(o.event, None);
    // Caso negativo: sin contadores no hay uso.
    let vacio = parse_exec_line(r#"{"type":"turn.completed","usage":{}}"#);
    assert_eq!(vacio.usage, None);
}

fn veredicto_de(lineas: &[&str]) -> Veredicto {
    let mut v = Veredicto::default();
    for l in lineas {
        v.anotar(&parse_exec_line(l));
    }
    v
}

/// Un reintento de stream («Reconnecting... 1/5») seguido de `turn.completed`
/// no es un fallo; el mismo error sin turno completado sí lo es.
#[test]
fn un_reintento_seguido_de_turno_completado_no_es_fallo() {
    let reintento = r#"{"type":"error","message":"Reconnecting... 1/5"}"#;
    let completado = r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}"#;
    let o = parse_exec_line(reintento);
    assert_eq!(o.event.map(|e| e.kind), Some("warning".into()));
    let bien = veredicto_de(&[reintento, completado]);
    assert!(!bien.fallido(), "el turno terminó bien");
    assert_eq!(bien.error_pendiente(), None);
    let mal = veredicto_de(&[reintento]);
    assert!(mal.fallido(), "sin turno completado, el error cuenta");
    assert_eq!(mal.error_pendiente(), Some("Reconnecting... 1/5"));
    let tarde = veredicto_de(&[completado, reintento]);
    assert!(tarde.fallido(), "un error después del turno no se perdona");
    let fallido = veredicto_de(&[
        r#"{"type":"turn.failed","error":{"message":"x"}}"#,
        completado,
    ]);
    assert!(fallido.fallido(), "turn.failed es definitivo");
}

#[test]
fn el_turno_completado_se_marca() {
    assert!(parse_exec_line(r#"{"type":"turn.completed"}"#).completed);
}

#[test]
fn lineas_ignoradas() {
    for l in [
        r#"{"type":"turn.started"}"#,
        r#"{"type":"item.completed","item":{"type":"reasoning","text":"x"}}"#,
        "texto que no es JSON",
    ] {
        assert_eq!(parse_exec_line(l), LineOutcome::default(), "{l}");
    }
}

#[test]
fn id_de_tarea_cloud() {
    assert_eq!(
        extract_cloud_task_id(
            "Created task_e_123abc\nhttps://chatgpt.com/codex/tasks/task_e_123abc"
        ),
        Some("task_e_123abc".into())
    );
    assert_eq!(
        extract_cloud_task_id("https://example.invalid/codex/tasks/abc-123"),
        Some("abc-123".into())
    );
    assert!(extract_cloud_task_id("nada").is_none());
}
