use super::*;
use serde_json::json;

fn inicio() -> EventoMotor {
    EventoMotor::HerramientaInicio {
        id: "lectura".into(),
        titulo: "read_file".into(),
        tipo: "read".into(),
        entrada: json!({"Path": "documentos/notas.md"}),
    }
}

fn fin() -> EventoMotor {
    EventoMotor::HerramientaFin {
        id: "lectura".into(),
        error: false,
        salida: "Contenido".into(),
    }
}

#[test]
fn concatena_deltas_consecutivos_y_preserva_orden_de_bloques() {
    let mut turno = ConstructorTurno::nuevo("turno");
    for texto in ["Pienso ", "primero"] {
        turno.aplicar(EventoMotor::PensamientoDelta {
            texto: texto.into(),
        });
    }
    for texto in ["Hola", " mundo"] {
        turno.aplicar(EventoMotor::MensajeDelta {
            texto: texto.into(),
        });
    }
    assert_eq!(
        turno.mensajes()[0].blocks,
        vec![
            Block::Thinking {
                text: "Pienso primero".into()
            },
            Block::Text {
                text: "Hola mundo".into()
            },
        ]
    );
}

#[test]
fn resultados_user_separan_mensajes_assistant_y_uso_va_al_ultimo() {
    let mut turno = ConstructorTurno::nuevo("turno");
    turno.aplicar(inicio());
    turno.aplicar(fin());
    turno.aplicar(EventoMotor::MensajeDelta {
        texto: "Listo".into(),
    });
    let uso = Usage {
        input: 6986,
        output: 331,
        cache_read: 0,
        cache_write: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        speed: None,
        model: None,
    };
    turno.aplicar(EventoMotor::FinTurno {
        motivo: "end_turn".into(),
        uso: Some(uso.clone()),
    });
    let mensajes = turno.mensajes();
    assert_eq!(
        mensajes.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
        vec!["assistant", "user", "assistant"]
    );
    assert_eq!(mensajes[1].kind, MessageKind::Meta);
    assert!(matches!(&mensajes[1].blocks[0], Block::ToolResult {
        tool_use_id, is_error: false, text, ..
    } if tool_use_id == "lectura" && text == "Contenido"));
    assert!(mensajes[..2].iter().all(|m| m.usage.is_none()));
    assert_eq!(mensajes[2].usage, Some(uso));
}

#[test]
fn uuid_estables_entre_reproducciones_y_distintos_por_mensaje_y_turno() {
    let reproducir = |id| {
        let mut turno = ConstructorTurno::nuevo(id);
        turno.aplicar(inicio());
        turno.aplicar(fin());
        turno.mensajes()
    };
    let primera = reproducir("turno-uno");
    assert_eq!(primera, reproducir("turno-uno"));
    assert_ne!(primera[0].uuid, primera[1].uuid);
    assert_ne!(primera[0].uuid, reproducir("turno-dos")[0].uuid);
    assert!(Uuid::parse_str(&primera[0].uuid).is_ok());
}

#[test]
fn resumen_legible_de_lectura_y_comando() {
    assert_eq!(
        resumen_herramienta("read_file", "read", &json!({"Path":"notas.md"})),
        "Leer notas.md"
    );
    assert_eq!(
        resumen_herramienta(
            "run_command",
            "execute",
            &json!({"CommandLine":"git status"})
        ),
        "git status"
    );
    assert_eq!(
        resumen_herramienta("Buscar texto", "search", &json!({})),
        "Buscar texto"
    );
}

#[test]
fn metadatos_y_permisos_no_crean_mensajes_del_chat() {
    let mut turno = ConstructorTurno::nuevo("turno");
    turno.aplicar(EventoMotor::Titulo("Título".into()));
    turno.aplicar(EventoMotor::Comandos(vec![]));
    turno.aplicar(EventoMotor::PeticionPermiso {
        id_peticion: "permiso".into(),
        entrada: serde_json::Value::Null,
        herramienta: "git status".into(),
        tipo: "execute".into(),
        opciones: vec![],
    });
    turno.aplicar(EventoMotor::MensajeDelta {
        texto: String::new(),
    });
    assert!(turno.mensajes().is_empty());
}

#[test]
fn pensamiento_nuevo_tras_herramienta_no_se_fusiona_con_el_anterior() {
    let mut turno = ConstructorTurno::nuevo("turno");
    turno.aplicar(EventoMotor::PensamientoDelta {
        texto: "Antes".into(),
    });
    turno.aplicar(inicio());
    turno.aplicar(EventoMotor::PensamientoDelta {
        texto: "Después".into(),
    });
    assert_eq!(turno.mensajes()[0].blocks.len(), 3);
}
