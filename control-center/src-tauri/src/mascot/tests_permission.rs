use super::*;

#[test]
fn el_resumen_prefiere_comando_ruta_o_url() {
    assert_eq!(
        summary("Bash", &json!({"command": "git push", "description": "x"})),
        "git push"
    );
    assert_eq!(
        summary(
            "Edit",
            &json!({"file_path": "C:/a/b.rs", "old_string": "x"})
        ),
        "C:/a/b.rs"
    );
    assert_eq!(
        summary("WebFetch", &json!({"url": "https://e.com", "prompt": "p"})),
        "https://e.com"
    );
    // Sin campo conocido: la entrada entera; sin entrada, el nombre.
    assert_eq!(summary("mcp__x__y", &json!({"a": 1})), r#"{"a":1}"#);
    assert_eq!(summary("Raro", &Value::Null), "Raro");
}

#[test]
fn el_resumen_largo_se_recorta_y_dice_cuanto_falta() {
    let largo = "x".repeat(MAX_SUMMARY + 10);
    let s = summary("Bash", &json!({ "command": largo }));
    assert!(s.starts_with(&"x".repeat(MAX_SUMMARY)));
    assert!(s.ends_with("… [+10 caracteres sin mostrar]"), "{s}");
    // Caso negativo: lo que cabe no lleva marca.
    let corto = summary("Bash", &json!({ "command": "git status" }));
    assert_eq!(corto, "git status");
}

#[test]
fn el_mismo_tope_que_el_freno_y_el_mcp() {
    assert_eq!(MAX_SUMMARY, 8_000);
}

#[test]
fn write_y_edit_ensenan_lo_que_escriben() {
    let w = summary(
        "Write",
        &json!({"file_path": "C:/a/b.rs", "content": "fn main() {}"}),
    );
    assert_eq!(w, "C:/a/b.rs\nfn main() {}");
    let e = summary(
        "Edit",
        &json!({"file_path": "C:/a/b.rs", "old_string": "x", "new_string": "y"}),
    );
    assert_eq!(e, "C:/a/b.rs\ny");
    // Caso negativo: una lectura sigue enseñando solo la ruta.
    assert_eq!(
        summary("Read", &json!({"file_path": "C:/a/b.rs"})),
        "C:/a/b.rs"
    );
}

#[test]
fn el_origen_es_la_carpeta_de_trabajo() {
    assert_eq!(origin(r"C:\Users\R\.ultron\"), "Claude Code · .ultron");
    assert_eq!(origin("/home/r/proyecto"), "Claude Code · proyecto");
    assert_eq!(origin(""), "Claude Code");
}

#[test]
fn lo_ultimo_que_dijo_claude_salta_herramientas_y_subagentes() {
    let jsonl = [
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Primero miro"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Ahora lo subo"},{"type":"tool_use","name":"Bash"}]}}"#,
        r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"del subagente"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#,
        r#"{"type":"user","message":{"content":"hola"}}"#,
        "{cortada",
    ]
    .join("\n");
    assert_eq!(last_reply_in(&jsonl).as_deref(), Some("Ahora lo subo"));
    // Caso negativo: sin texto del asistente no se inventa contexto.
    assert_eq!(
        last_reply_in(r#"{"type":"user","message":{"content":"x"}}"#),
        None
    );
}

#[test]
fn sin_decision_la_salida_va_vacia_y_manda_la_terminal() {
    assert_eq!(hook_output(None), json!({}));
    let allow = hook_output(Some(true));
    assert_eq!(
        allow["hookSpecificOutput"]["hookEventName"],
        "PermissionRequest"
    );
    assert_eq!(allow["hookSpecificOutput"]["decision"]["behavior"], "allow");
    let deny = hook_output(Some(false));
    assert_eq!(deny["hookSpecificOutput"]["decision"]["behavior"], "deny");
    assert!(deny["hookSpecificOutput"]["decision"]["message"]
        .as_str()
        .unwrap()
        .contains("Pupus"));
}
