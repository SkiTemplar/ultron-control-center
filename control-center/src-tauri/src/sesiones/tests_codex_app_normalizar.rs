use super::*;
use crate::sesiones::motor_eventos::ConstructorTurno;
use crate::sesiones::types::Block;
use serde_json::json;

fn reproducir() -> (Vec<EventoMotor>, Vec<crate::sesiones::types::ChatMessage>) {
    let mut flujo = FlujoCodex::default();
    let mut turno = ConstructorTurno::nuevo("turno-fixture");
    let mut eventos = Vec::new();
    for linea in include_str!("fixtures/codex-app-server-0.162.1-turno.ndjson").lines() {
        let Some(linea) = linea.strip_prefix("< ") else {
            continue;
        };
        let aviso: Value = serde_json::from_str(linea).unwrap();
        let Some(metodo) = aviso["method"].as_str() else {
            continue;
        };
        let nuevos = if let Some(id) = aviso.get("id") {
            vec![permiso(&id.to_string(), metodo, &aviso["params"])]
        } else {
            flujo.aplicar(metodo, &aviso["params"])
        };
        for evento in nuevos {
            turno.aplicar(evento.clone());
            eventos.push(evento);
        }
    }
    (eventos, turno.mensajes())
}

#[test]
fn fixture_conserva_comentario_herramientas_rechazos_y_respuesta() {
    let (eventos, mensajes) = reproducir();
    assert_eq!(
        eventos
            .iter()
            .filter(|e| matches!(e, EventoMotor::PeticionPermiso { .. }))
            .count(),
        2
    );
    let bloques: Vec<_> = mensajes.iter().flat_map(|m| &m.blocks).collect();
    let textos: Vec<_> = bloques
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(textos.len(), 2);
    assert!(textos[0].starts_with("Voy a leer"));
    assert!(textos[1].starts_with("No pude leer"));
    assert_eq!(
        bloques
            .iter()
            .filter(|b| matches!(b, Block::ToolUse { name, .. } if name == "Bash"))
            .count(),
        2
    );
    assert_eq!(
        bloques
            .iter()
            .filter(
                |b| matches!(b, Block::ToolResult { is_error: true, text, .. } if !text.is_empty())
            )
            .count(),
        2
    );
    assert!(bloques.iter().all(
        |b| !matches!(b, Block::ToolUse { summary, .. } if summary.contains("powershell.exe"))
    ));
}

#[test]
fn fixture_uso_del_ultimo_last_y_uuid_estables() {
    let (_, mensajes) = reproducir();
    let (_, repetidos) = reproducir();
    assert_eq!(
        mensajes.iter().map(|m| &m.uuid).collect::<Vec<_>>(),
        repetidos.iter().map(|m| &m.uuid).collect::<Vec<_>>()
    );
    let uso = mensajes.last().unwrap().usage.as_ref().unwrap();
    assert_eq!((uso.input, uso.output, uso.cache_read), (24601, 49, 24320));
}

#[test]
fn normaliza_pensamiento_y_ignora_ecos_y_desconocidos() {
    assert_eq!(
        normalizar(
            "item/reasoning/summaryTextDelta",
            &json!({"delta":"Pensando"})
        ),
        vec![EventoMotor::PensamientoDelta {
            texto: "Pensando".into()
        }]
    );
    let mut flujo = FlujoCodex::default();
    flujo.aplicar(
        "item/agentMessage/delta",
        &json!({"itemId":"mensaje","delta":"eco"}),
    );
    assert!(flujo
        .aplicar(
            "item/completed",
            &json!({"item":{"id":"mensaje","type":"agentMessage","text":"eco"}})
        )
        .is_empty());
    assert!(normalizar("desconocido", &json!({})).is_empty());
}

#[test]
fn textos_completos_sin_deltas_se_conservan() {
    assert_eq!(
        normalizar(
            "item/completed",
            &json!({"item":{"type":"agentMessage","text":"comentario","phase":"commentary"}})
        ),
        vec![EventoMotor::MensajeDelta {
            texto: "comentario".into()
        }]
    );
    assert_eq!(
        normalizar(
            "item/completed",
            &json!({"item":{"type":"reasoning","summary":["Primero","Después"]}})
        ),
        vec![EventoMotor::PensamientoDelta {
            texto: "Primero\nDespués".into()
        }]
    );
}

#[test]
fn normaliza_edicion_y_escritura_con_rutas() {
    for (tipo, nombre) in [("add", "Write"), ("update", "Edit")] {
        let eventos = normalizar(
            "item/started",
            &json!({"item":{"id":"f","type":"fileChange","changes":[{"path":"notas.md","kind":{"type":tipo},"diff":"+hola"}]}}),
        );
        assert!(
            matches!(&eventos[0], EventoMotor::HerramientaInicio { titulo, entrada, .. } if titulo == nombre && entrada["file_path"] == "notas.md")
        );
    }
}

#[test]
fn uso_total_es_reserva_y_se_limpia_entre_turnos() {
    let mut flujo = FlujoCodex::default();
    flujo.aplicar(
        "thread/tokenUsage/updated",
        &json!({"tokenUsage":{"total":{"inputTokens":12,"outputTokens":3}}}),
    );
    assert!(
        matches!(&flujo.aplicar("turn/completed", &json!({"turn":{"status":"completed"}}))[0], EventoMotor::FinTurno { uso: Some(u), .. } if u.input == 12)
    );
    assert!(matches!(
        &flujo.aplicar("turn/completed", &json!({}))[0],
        EventoMotor::FinTurno { uso: None, .. }
    ));
}

#[test]
fn resultados_mcp_y_comando_no_duplican_salida_incremental() {
    assert!(normalizar("item/commandExecution/outputDelta", &json!({"delta":"eco"})).is_empty());
    let eventos = normalizar(
        "item/completed",
        &json!({"item":{"id":"m","type":"mcpToolCall","status":"failed","error":{"message":"rechazo"}}}),
    );
    assert!(
        matches!(&eventos[0], EventoMotor::HerramientaFin { error: true, salida, .. } if salida.contains("rechazo"))
    );
}
