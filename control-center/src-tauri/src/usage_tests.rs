// Tests del recálculo de Usage desde los transcripts (`usage.rs`).

use super::*;
use serde_json::json;

fn assistant(id: &str, model: &str, input: u64, output: u64, block: serde_json::Value) -> String {
    json!({
        "type": "assistant",
        "timestamp": "2026-10-16T09:30:00.000Z",
        "message": {
            "id": id,
            "model": model,
            "content": [block],
            "usage": {
                "input_tokens": input,
                "output_tokens": output,
                "cache_read_input_tokens": 100,
                "cache_creation_input_tokens": 0
            }
        }
    })
    .to_string()
}

fn user(content: serde_json::Value) -> String {
    json!({
        "type": "user",
        "timestamp": "2026-10-16T09:29:00.000Z",
        "message": { "role": "user", "content": content }
    })
    .to_string()
}

fn tool_use(id: &str) -> serde_json::Value {
    json!({ "type": "tool_use", "id": id, "name": "Read", "input": {} })
}

fn tool_result(id: &str) -> serde_json::Value {
    json!([{ "type": "tool_result", "tool_use_id": id, "content": "ok" }])
}

#[test]
fn deduplica_las_lineas_de_un_mismo_mensaje_por_id() {
    // Un mensaje con tres bloques llega en tres líneas con el mismo id.
    let lines = vec![
        assistant(
            "msg_1",
            "claude-opus-5-5",
            10,
            5,
            json!({"type": "thinking"}),
        ),
        assistant("msg_1", "claude-opus-5-5", 10, 5, json!({"type": "text"})),
        assistant("msg_1", "claude-opus-5-5", 10, 40, tool_use("tu_1")),
        assistant("msg_2", "claude-opus-5-5", 7, 3, json!({"type": "text"})),
    ];
    let mut acc = LiveAcc::default();
    acc.absorb(aggregate_transcript(lines), Some("s1"));
    let stats = acc.into_stats();
    let m = &stats.model_usage["claude-opus-5-5"];
    assert_eq!(m.input_tokens, 17, "sin dedupe serían 37");
    assert_eq!(
        m.output_tokens, 43,
        "se queda la línea de más output_tokens"
    );
    assert_eq!(m.cache_read_input_tokens, 200);
    let day = &stats.daily_model_tokens[0];
    assert_eq!(day.tokens_by_model["claude-opus-5-5"], 17 + 43 + 200);
}

#[test]
fn las_filas_tool_result_y_meta_no_cuentan_como_mensajes() {
    let mut meta: serde_json::Value = serde_json::from_str(&user(json!("caveat"))).unwrap();
    meta["isMeta"] = json!(true);
    let mut compact: serde_json::Value =
        serde_json::from_str(&user(json!("This session is being continued..."))).unwrap();
    compact["isCompactSummary"] = json!(true);
    let lines = vec![
        user(json!("arregla el test")),
        user(json!([{ "type": "text", "text": "y el lint" }])),
        user(tool_result("tu_1")),
        user(tool_result("tu_2")),
        meta.to_string(),
        compact.to_string(),
    ];
    let mut acc = LiveAcc::default();
    acc.absorb(aggregate_transcript(lines), Some("s1"));
    let stats = acc.into_stats();
    assert_eq!(stats.total_messages, 2);
    assert_eq!(stats.daily_activity[0].message_count, 2);
    assert_eq!(stats.hour_counts.get("09"), Some(&2));
}

#[test]
fn cuenta_los_bloques_tool_use_una_vez_por_id() {
    let lines = vec![
        assistant("msg_1", "claude-opus-5-5", 1, 1, tool_use("tu_1")),
        assistant("msg_1", "claude-opus-5-5", 1, 2, tool_use("tu_2")),
        // Línea repetida (reintento de escritura): mismo bloque, mismo id.
        assistant("msg_1", "claude-opus-5-5", 1, 2, tool_use("tu_2")),
        assistant("msg_2", "claude-opus-5-5", 1, 1, json!({"type": "text"})),
    ];
    let mut acc = LiveAcc::default();
    acc.absorb(aggregate_transcript(lines), Some("s1"));
    let stats = acc.into_stats();
    assert_eq!(stats.daily_activity[0].tool_call_count, 2);
}

#[test]
fn ignora_los_mensajes_sinteticos_y_las_lineas_rotas() {
    let lines = vec![
        assistant("msg_1", "<synthetic>", 50, 50, json!({"type": "text"})),
        "{no es json".to_string(),
        assistant("msg_2", "claude-sonnet-5-5", 1, 1, json!({"type": "text"})),
    ];
    let mut acc = LiveAcc::default();
    acc.absorb(aggregate_transcript(lines), Some("s1"));
    let stats = acc.into_stats();
    assert!(!stats.model_usage.contains_key("<synthetic>"));
    assert_eq!(stats.model_usage.len(), 1);
}

#[test]
fn incluye_los_tokens_de_subagentes_sin_contarlos_como_sesiones() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let project = tmp.path().join("C--proyecto");
    let sub_dir = project.join("s1").join("subagents");
    fs::create_dir_all(&sub_dir).expect("mkdir");
    let main = [
        user(json!("lanza un agente")),
        assistant("msg_main", "claude-opus-5-5", 10, 10, tool_use("tu_task")),
    ];
    let sub = [
        user(json!("prompt que escribe el agente padre")),
        assistant("msg_sub", "claude-sonnet-5-5", 20, 20, tool_use("tu_sub")),
    ];
    fs::write(project.join("s1.jsonl"), main.join("\n")).expect("write main");
    fs::write(sub_dir.join("agent-a1.jsonl"), sub.join("\n")).expect("write sub");

    let stats = compute_live_usage_in(tmp.path()).expect("stats");
    assert_eq!(
        stats.total_sessions, 1,
        "el transcript del subagente no es una sesión"
    );
    assert_eq!(
        stats.total_messages, 1,
        "el prompt del subagente no es del usuario"
    );
    assert!(
        stats.model_usage.contains_key("claude-sonnet-5-5"),
        "los tokens del subagente tienen que aparecer"
    );
    assert_eq!(stats.daily_activity[0].tool_call_count, 2);
    assert_eq!(stats.daily_activity[0].session_count, 1);
}

#[test]
fn sin_carpeta_de_proyectos_no_hay_recalculo() {
    let tmp = tempfile::tempdir().expect("tempdir");
    assert!(compute_live_usage_in(&tmp.path().join("no-existe")).is_none());
}

#[test]
fn sin_stats_cache_se_recalcula_en_vez_de_fallar() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join("stats-cache.json");
    let vacia = read_stats_cache(&path).expect("ausente no es un error");
    assert!(
        vacia.last_computed_date.is_none(),
        "sin fecha fuerza el recálculo"
    );
    std::fs::write(&path, "{no es json").expect("roto");
    assert!(read_stats_cache(&path)
        .expect_err("corrupto")
        .contains("parse"));
    std::fs::write(&path, r#"{"lastComputedDate":"2026-01-01"}"#).expect("ok");
    let leida = read_stats_cache(&path).expect("válido");
    assert_eq!(leida.last_computed_date.as_deref(), Some("2026-01-01"));
}
