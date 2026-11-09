use super::*;
use crate::sesiones::motor_eventos::ConstructorTurno;
use crate::sesiones::types::Block;
use serde_json::json;

fn reproducir() -> (Vec<EventoMotor>, Vec<crate::sesiones::types::ChatMessage>) {
    let mut eventos = Vec::new();
    for linea in include_str!("fixtures/acp-agy-1.5.0-turno.ndjson").lines() {
        let Some(json) = linea.strip_prefix("< ") else {
            continue;
        };
        let valor: Value = serde_json::from_str(json).unwrap();
        match valor["method"].as_str() {
            Some("session/update") => eventos.extend(normalizar(&valor["params"])),
            Some("session/request_permission") => eventos.push(permiso("1", &valor["params"])),
            None if valor["id"] == 2 => eventos.extend(configuracion(&valor["result"])),
            None if valor["id"] == 3 => eventos.push(fin_turno(&valor["result"])),
            _ => {}
        }
    }
    let mut constructor = ConstructorTurno::nuevo("turno-fixture");
    for evento in &eventos {
        constructor.aplicar(evento.clone());
    }
    (eventos, constructor.mensajes())
}

#[test]
fn fixture_produce_pensamiento_herramientas_permiso_y_uso() {
    let (eventos, mensajes) = reproducir();
    assert!(eventos.iter().any(|e| matches!(e, EventoMotor::PeticionPermiso { herramienta, opciones, .. } if herramienta == "git status" && opciones.len() == 2)));
    let bloques: Vec<_> = mensajes.iter().flat_map(|m| &m.blocks).collect();
    assert!(bloques
        .iter()
        .any(|b| matches!(b, Block::Thinking {text} if text.contains("notas.md"))));
    let resumenes: Vec<_> = bloques
        .iter()
        .filter_map(|b| match b {
            Block::ToolUse { summary, .. } => Some(summary.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(resumenes, ["Leer notas.md", "git status"]);
    assert_eq!(
        bloques
            .iter()
            .filter(|b| matches!(b, Block::ToolResult { .. }))
            .count(),
        2
    );
    assert!(mensajes
        .iter()
        .filter(|m| m
            .blocks
            .iter()
            .any(|b| matches!(b, Block::ToolResult { .. })))
        .all(|m| m.role == "user"));
    let uso = mensajes.last().unwrap().usage.as_ref().unwrap();
    assert_eq!((uso.input, uso.output), (6986, 331));
    assert!(eventos
        .iter()
        .any(|e| matches!(e, EventoMotor::Comandos(c) if c.len() == 11)));
    assert!(eventos
        .iter()
        .any(|e| matches!(e, EventoMotor::Modo {disponibles, ..} if disponibles.len() == 3)));
    assert!(eventos
        .iter()
        .any(|e| matches!(e, EventoMotor::Modelos {disponibles, ..} if disponibles.len() == 3)));
}

#[test]
fn fixture_repetida_conserva_los_uuid() {
    assert_eq!(reproducir().1, reproducir().1);
}

#[test]
fn deltas_plan_modo_y_desconocidos() {
    let delta = normalizar(
        &json!({"update":{"sessionUpdate":"agent_message_chunk", "content":{"type":"text","text":"Hola"}}}),
    );
    assert_eq!(
        delta,
        vec![EventoMotor::MensajeDelta {
            texto: "Hola".into()
        }]
    );
    assert!(
        matches!(&normalizar(&json!({"update":{"sessionUpdate":"current_mode_update","currentModeId":"plan"}}))[0], EventoMotor::Modo {actual, ..} if actual == "plan")
    );
    assert!(
        matches!(&normalizar(&json!({"update":{"sessionUpdate":"plan","entries":[{"content":"Revisar", "status":"pending"}]}}))[0], EventoMotor::MensajeDelta {texto} if texto.contains("Revisar"))
    );
    assert!(normalizar(&json!({"update":{"sessionUpdate":"futuro"}})).is_empty());
    assert!(normalizar(&json!({"update":{"sessionUpdate":"user_message_chunk"}})).is_empty());
}

#[test]
fn resultado_extrae_texto_y_error_sin_finalizar_estados_intermedios() {
    let base = json!({"update":{"sessionUpdate":"tool_call_update","toolCallId":"h","status":"failed","content":[{"type":"content","content":{"type":"text","text":"rechazado"}}]}});
    assert_eq!(
        normalizar(&base),
        vec![EventoMotor::HerramientaFin {
            id: "h".into(),
            error: true,
            salida: "rechazado".into()
        }]
    );
    let mut pendiente = base;
    pendiente["update"]["status"] = json!("pending");
    assert!(normalizar(&pendiente).is_empty());
}
