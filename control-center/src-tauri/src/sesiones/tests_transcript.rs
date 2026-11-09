// sesiones/tests_transcript.rs — Tests del parser de transcripts con
// fixtures anonimizados (fixtures/*.jsonl).

use super::senales::Senal;
use super::transcript::clases::{self, OpCola};
use super::transcript::{
    first_user_text, is_main_turn_end, parse_all, parse_fichero, parse_line, summarize_tool,
    truncate_chars, ParseState, TOOL_RESULT_MAX_CHARS,
};
use super::types::{Block, ChatMessage, MessageKind, Usage};

const MAIN: &str = include_str!("fixtures/transcript.jsonl");
const SUB: &str = include_str!("fixtures/subagente.jsonl");

#[test]
fn ignora_lineas_que_no_son_mensajes() {
    let msgs = parse_all(MAIN, None);
    let uuids: Vec<&str> = msgs.iter().map(|m| m.uuid.as_str()).collect();
    assert_eq!(
        uuids,
        ["u-1", "a-2", "a-3", "u-2", "a-4", "u-3", "u-4", "a-5"],
        "sin queue-operation, attachment, system, last-prompt ni ai-title; sin pensamiento vacío"
    );
}

#[test]
fn roles_y_texto() {
    let msgs = parse_all(MAIN, None);
    assert!(
        msgs.iter().all(|m| m.uuid != "u-meta-1"),
        "isMeta no se emite"
    );
    assert_eq!(msgs[0].role, "user");
    assert_eq!(
        msgs[0].blocks,
        vec![Block::Text {
            text: "Lista los ficheros del proyecto".into()
        }]
    );
    assert_eq!(
        first_user_text(&msgs[0]).as_deref(),
        Some("Lista los ficheros del proyecto")
    );
    assert!(msgs
        .iter()
        .all(|m| m.kind != MessageKind::Meta || m.role == "user"));
    assert_eq!(msgs[7].role, "assistant");
    assert_eq!(msgs[7].model.as_deref(), Some("modelo-demo"));
}

#[test]
fn uso_solo_en_la_primera_linea_de_cada_mensaje() {
    let msgs = parse_all(MAIN, None);
    assert_eq!(
        msgs[1].usage,
        Some(Usage {
            input: 10,
            output: 30,
            cache_read: 200,
            cache_write: 100,
            cache_write_5m: 0,
            cache_write_1h: 0,
            speed: None,
            model: None,
        })
    );
    assert!(
        msgs[2].usage.is_none(),
        "mismo message.id: sin uso repetido"
    );
    assert!(msgs[4].usage.is_some(), "message.id nuevo");
}

#[test]
fn pensamiento_y_herramientas() {
    let msgs = parse_all(MAIN, None);
    assert_eq!(
        msgs[1].blocks,
        vec![Block::Thinking {
            text: "Necesito listar el directorio.".into()
        }]
    );
    match &msgs[2].blocks[0] {
        Block::ToolUse {
            id, name, summary, ..
        } => {
            assert_eq!(id, "toolu_1");
            assert_eq!(name, "Bash");
            assert_eq!(summary, "ls -la", "solo la primera línea del comando");
        }
        b => panic!("se esperaba toolUse, llegó {b:?}"),
    }
    match &msgs[3].blocks[0] {
        Block::ToolResult {
            tool_use_id,
            is_error,
            text,
            images,
        } => {
            assert_eq!(tool_use_id, "toolu_1");
            assert!(!is_error);
            assert_eq!(text, "a.txt\nb.txt");
            assert!(images.is_none());
        }
        b => panic!("se esperaba toolResult, llegó {b:?}"),
    }
}

#[test]
fn imagenes_en_resultados_y_en_prompts() {
    let msgs = parse_all(MAIN, None);
    match &msgs[5].blocks[0] {
        Block::ToolResult { images, .. } => assert_eq!(
            images.as_deref(),
            Some(&["data:image/png;base64,iVBORw0KGgo=".to_string()][..])
        ),
        b => panic!("se esperaba toolResult, llegó {b:?}"),
    }
    match &msgs[6].blocks[1] {
        Block::Image {
            media_type,
            data_url,
            path,
        } => {
            assert_eq!(media_type, "image/jpeg");
            assert_eq!(data_url.as_deref(), Some("data:image/jpeg;base64,/9j/4AAQ"));
            assert!(path.is_none());
        }
        b => panic!("se esperaba image, llegó {b:?}"),
    }
}

#[test]
fn subagente_lleva_agent_id() {
    let msgs = parse_all(SUB, None);
    assert_eq!(msgs.len(), 4);
    assert!(msgs
        .iter()
        .all(|m| m.agent_id.as_deref() == Some("a0000demo")));
    match &msgs[1].blocks[0] {
        Block::ToolUse { summary, .. } => assert_eq!(summary, "fn main en src"),
        b => panic!("se esperaba toolUse, llegó {b:?}"),
    }
    assert!(
        first_user_text(&msgs[0]).is_none(),
        "el prompt de un subagente no titula"
    );
}

#[test]
fn agente_por_defecto_si_la_linea_no_lo_trae() {
    let line =
        r#"{"type":"user","uuid":"x","timestamp":"t","message":{"role":"user","content":"hola"}}"#;
    let m = parse_line(line, Some("aX"), &mut ParseState::default()).expect("mensaje");
    assert_eq!(m.agent_id.as_deref(), Some("aX"));
}

#[test]
fn lineas_corruptas_no_rompen() {
    assert!(parse_line("{no es json", None, &mut ParseState::default()).is_none());
    assert!(parse_line("", None, &mut ParseState::default()).is_none());
}

#[test]
fn fin_de_turno_del_hilo_principal() {
    let ends: Vec<bool> = MAIN
        .lines()
        .map(|l| is_main_turn_end(&serde_json::from_str(l).expect("fixture")))
        .collect();
    assert_eq!(ends.iter().filter(|e| **e).count(), 1);
    let sub_ends = SUB
        .lines()
        .filter(|l| is_main_turn_end(&serde_json::from_str(l).expect("fixture")))
        .count();
    assert_eq!(sub_ends, 0, "los subagentes no cierran el turno principal");
}

#[test]
fn resumenes_de_herramientas() {
    let j = |s: &str| serde_json::from_str::<serde_json::Value>(s).expect("json");
    assert_eq!(
        summarize_tool("Edit", &j(r#"{"file_path":"src/a.rs"}"#)),
        "src/a.rs"
    );
    assert_eq!(
        summarize_tool(
            "Agent",
            &j(r#"{"description":"Revisar","subagent_type":"code-reviewer"}"#)
        ),
        "code-reviewer: Revisar"
    );
    assert_eq!(
        summarize_tool("Desconocida", &j(r#"{"x":"valor"}"#)),
        "valor"
    );
    assert_eq!(
        summarize_tool("TodoWrite", &j(r#"{"todos":[1,2]}"#)),
        "2 tareas"
    );
}

#[test]
fn recorte_por_caracteres() {
    assert_eq!(truncate_chars("áéíóú", 10), "áéíóú");
    assert_eq!(truncate_chars("áéíóú", 2), "áé… (recortado)");
}

#[test]
fn el_mensaje_escrito_a_mitad_de_turno_aparece_como_usuario() {
    let jsonl = concat!(
        r#"{"type":"queue-operation","operation":"enqueue","content":"hola"}"#,
        "\n",
        r#"{"type":"attachment","uuid":"q1","timestamp":"2026-10-07T16:24:46.905Z","attachment":{"type":"queued_command","prompt":"cambia el color"}}"#,
        "\n",
        r#"{"type":"attachment","uuid":"q2","attachment":{"type":"total_tokens_reminder"}}"#,
        "\n",
    );
    let msgs = parse_all(jsonl, None);
    assert_eq!(
        msgs.len(),
        1,
        "solo el queued_command; la cola y otros adjuntos no"
    );
    assert_eq!(msgs[0].uuid, "q1");
    assert_eq!(msgs[0].role, "user");
    assert!(matches!(&msgs[0].blocks[0], Block::Text { text } if text == "cambia el color"));
}

// -- Clasificación del contrato de estabilidad (§5.1) --

const CLASES: &str = include_str!("fixtures/transcripts/clases.jsonl");

fn por_uuid<'a>(msgs: &'a [ChatMessage], uuid: &str) -> &'a ChatMessage {
    msgs.iter()
        .find(|m| m.uuid == uuid)
        .unwrap_or_else(|| panic!("falta {uuid}"))
}

#[test]
fn notificaciones_de_tareas_son_de_sistema_y_no_abren_turno() {
    let msgs = parse_all(CLASES, None);
    for uuid in ["q2", "tn1"] {
        let m = por_uuid(&msgs, uuid);
        assert_eq!(
            (m.role.as_str(), m.kind),
            ("system", MessageKind::TaskNotification)
        );
    }
}

#[test]
fn absorbido_a_mitad_de_turno_es_prompt_en_cola() {
    let msgs = parse_all(CLASES, None);
    let q = por_uuid(&msgs, "q1");
    assert_eq!(
        (q.role.as_str(), q.kind, q.queued),
        ("user", MessageKind::Prompt, true)
    );
    assert!(
        !por_uuid(&msgs, "p1").queued,
        "un prompt normal no va marcado"
    );
}

#[test]
fn interrupcion_y_resumen_de_compactacion() {
    let msgs = parse_all(CLASES, None);
    let i = por_uuid(&msgs, "i1");
    assert_eq!(
        (i.role.as_str(), i.kind),
        ("system", MessageKind::Interrupted)
    );
    let c = por_uuid(&msgs, "c1");
    assert_eq!(
        (c.role.as_str(), c.kind),
        ("system", MessageKind::CompactSummary)
    );
    assert!(
        msgs.iter().all(|m| m.uuid != "cav"),
        "el caveat no se emite"
    );
}

#[test]
fn cost_es_un_solo_comando_con_su_salida_sin_ansi() {
    let msgs = parse_all(CLASES, None);
    let cmds: Vec<&ChatMessage> = msgs
        .iter()
        .filter(|m| m.command.as_ref().is_some_and(|c| c.name == "cost"))
        .collect();
    assert_eq!(cmds.len(), 1);
    let c = cmds[0].command.as_ref().expect("comando");
    assert_eq!(
        (cmds[0].uuid.as_str(), cmds[0].kind),
        ("cmd1", MessageKind::Command)
    );
    assert_eq!(c.stdout, "Total cost: $0.10");
    assert!(!c.stdout.contains('\u{1b}'));
    assert!(
        msgs.iter().all(|m| m.uuid != "out1"),
        "la salida no es otro mensaje"
    );
    let u = por_uuid(&msgs, "sys1")
        .command
        .clone()
        .expect("local_command");
    assert_eq!(
        (u.name.as_str(), u.stdout.as_str()),
        ("usage", "Uso del plan")
    );
}

#[test]
fn en_vivo_la_salida_reemite_el_comando_con_el_mismo_uuid() {
    let mut st = ParseState::default();
    let lineas: Vec<&str> = CLASES.lines().collect();
    let cmd = parse_line(lineas[9], None, &mut st).expect("comando");
    assert_eq!(cmd.command.as_ref().map(|c| c.stdout.as_str()), Some(""));
    let out = parse_line(lineas[10], None, &mut st).expect("salida");
    assert_eq!(out.uuid, "cmd1");
    assert_eq!(
        out.command.as_ref().map(|c| c.stdout.as_str()),
        Some("Total cost: $0.10")
    );
}

#[test]
fn bash_con_su_salida() {
    let msgs = parse_all(CLASES, None);
    let b = por_uuid(&msgs, "b1");
    assert_eq!(b.kind, MessageKind::Bash);
    let c = b.command.as_ref().expect("bash");
    assert_eq!(
        (c.args.as_str(), c.stdout.as_str(), c.is_error),
        ("echo hola", "hola", false)
    );
    assert!(msgs.iter().all(|m| m.uuid != "b2"));
}

#[test]
fn uso_con_cache_de_5m_y_1h_separada_y_modo_rapido() {
    let msgs = parse_all(CLASES, None);
    let u = por_uuid(&msgs, "a1").usage.clone().expect("usage");
    assert_eq!(
        (u.cache_write, u.cache_write_5m, u.cache_write_1h),
        (30, 10, 20)
    );
    assert_eq!(u.speed.as_deref(), Some("fast"));
}

#[test]
fn resultado_de_herramienta_no_es_un_prompt() {
    let msgs = parse_all(MAIN, None);
    let r = msgs.iter().find(|m| m.uuid == "u-2").expect("u-2");
    assert_eq!((r.role.as_str(), r.kind), ("user", MessageKind::Meta));
}

#[test]
fn senales_del_hilo_principal() {
    let todas: Vec<Senal> = CLASES
        .lines()
        .flat_map(|l| clases::senales(&serde_json::from_str(l).expect("json")))
        .collect();
    let cuenta = |f: &dyn Fn(&Senal) -> bool| todas.iter().filter(|s| f(s)).count();
    assert_eq!(cuenta(&|s| *s == Senal::TxTurnDuration), 1);
    assert_eq!(
        cuenta(&|s| *s == Senal::TxSalidaLocal),
        2,
        "stdout y local_command"
    );
    assert_eq!(cuenta(&|s| *s == Senal::TxSalidaBash), 1);
    assert_eq!(cuenta(&|s| *s == Senal::TxEndTurn), 1);
    assert_eq!(
        cuenta(&|s| *s == Senal::TxInterrumpido),
        1,
        "la del subagente no"
    );
    let prompts: Vec<&Senal> = todas
        .iter()
        .filter(|s| matches!(s, Senal::TxPromptUsuario { .. }))
        .collect();
    let esperado = Senal::TxPromptUsuario {
        texto: "primer mensaje".into(),
    };
    assert_eq!(prompts, vec![&esperado]);
    assert!(todas.contains(&Senal::ModoPermisos {
        modo: "acceptEdits".into()
    }));
}

#[test]
fn operaciones_de_la_cola_nativa() {
    let ops: Vec<OpCola> = CLASES
        .lines()
        .filter_map(|l| clases::op_cola(&serde_json::from_str(l).expect("json")))
        .collect();
    assert_eq!(
        ops,
        vec![
            OpCola::Enqueue("segundo".into()),
            OpCola::Remove("segundo".into())
        ]
    );
}

#[test]
fn quita_ansi_csi_y_osc() {
    assert_eq!(clases::sin_ansi("\u{1b}[31mrojo\u{1b}[0m"), "rojo");
    assert_eq!(
        clases::sin_ansi("\u{1b}]8;;http://x\u{7}enlace\u{1b}]8;;\u{7}"),
        "enlace"
    );
    assert_eq!(clases::sin_ansi("sin escapes"), "sin escapes");
}

#[test]
fn los_input_de_tool_use_se_recortan_como_los_resultados() {
    let largo = "x".repeat(TOOL_RESULT_MAX_CHARS + 50);
    let linea = serde_json::json!({
        "type": "assistant", "uuid": "a1", "timestamp": "t",
        "message": {"id": "m1", "role": "assistant", "content": [{
            "type": "tool_use", "id": "t1", "name": "Write",
            "input": {"file_path": "C:/demo/f.txt", "content": largo,
                      "edits": [{"old_string": largo, "n": 3}]}
        }]}
    })
    .to_string();
    let m = parse_line(&linea, None, &mut ParseState::default()).expect("mensaje");
    let Block::ToolUse { input, summary, .. } = &m.blocks[0] else {
        panic!("se esperaba tool_use");
    };
    let recortado = truncate_chars(&largo, TOOL_RESULT_MAX_CHARS);
    assert!(recortado.ends_with("(recortado)"));
    assert_eq!(input["content"], recortado.as_str());
    assert_eq!(
        input["edits"][0]["old_string"],
        recortado.as_str(),
        "también anidadas"
    );
    assert_eq!(input["edits"][0]["n"], 3, "lo que no es cadena no cambia");
    assert_eq!(input["file_path"], "C:/demo/f.txt", "las cortas no cambian");
    assert_eq!(summary, "C:/demo/f.txt");
}

#[test]
fn parse_all_y_parse_fichero_dan_lo_mismo() {
    let dir = tempfile::tempdir().expect("tempdir");
    let p = dir.path().join("t.jsonl");
    let texto = format!("{MAIN}\n{CLASES}");
    std::fs::write(&p, &texto).expect("escribir");
    let fichero = parse_fichero(&p, None).expect("parsear");
    assert_eq!(fichero, parse_all(&texto, None));
    assert!(!fichero.is_empty());
}

/// Medida a mano con un transcript real grande:
/// `ULTRON_BIG_JSONL=<ruta> cargo test --release medida_transcript_grande -- --ignored --nocapture`
/// Mide el parseo entero (lo que viajaba antes por IPC) y la primera página
/// de `sesiones_history` (CONTRATO-v3 §7).
#[test]
#[ignore]
fn medida_transcript_grande() {
    let Ok(ruta) = std::env::var("ULTRON_BIG_JSONL") else {
        return;
    };
    let text = std::fs::read_to_string(&ruta).expect("leer");
    let t = std::time::Instant::now();
    let msgs = parse_all(&text, None);
    let parse = t.elapsed();
    let json = serde_json::to_string(&msgs).expect("json");
    eprintln!(
        "entero: bytes={} mensajes={} parse={:?} json={:.2} MB",
        text.len(),
        msgs.len(),
        parse,
        json.len() as f64 / 1e6
    );
    let t = std::time::Instant::now();
    let pag =
        super::pagina::leer(Some(std::path::Path::new(&ruta)), None, None, None).expect("página");
    let json = serde_json::to_string(&pag).expect("json");
    eprintln!(
        "primera página: mensajes={} hasMore={} ms={} json={:.2} MB",
        pag.messages.len(),
        pag.has_more,
        t.elapsed().as_millis(),
        json.len() as f64 / 1e6
    );
    assert!(
        json.len() < 3_000_000,
        "la primera página debe pesar menos de 3 MB"
    );
}

/// Claude Code 2.1.296 guarda un pegado largo envuelto en
/// `<pasted_content id="…">…</pasted_content id="…">`: la burbuja del chat
/// muestra solo el contenido, y el texto emparejado con la cola es el mismo.
#[test]
fn el_prompt_pegado_se_muestra_sin_las_marcas_de_la_cli() {
    let linea = r#"{"type":"user","uuid":"u-p","timestamp":"t","message":{"role":"user","content":"\n\n<pasted_content id=\"2218\">\npues lo de MCP:\n  ⎿  Failed to reconnect\n</pasted_content id=\"2218\">\n"}}"#;
    let m = parse_line(linea, None, &mut ParseState::default()).expect("mensaje");
    assert_eq!(m.kind, MessageKind::Prompt);
    assert_eq!(
        m.blocks,
        vec![Block::Text {
            text: "pues lo de MCP:\n  ⎿  Failed to reconnect".into()
        }]
    );
    // Caso negativo: un prompt sin marcas no se toca (ni se recorta).
    let normal = r#"{"type":"user","uuid":"u-n","timestamp":"t","message":{"role":"user","content":"  hola <pasted_contents>\n"}}"#;
    let m = parse_line(normal, None, &mut ParseState::default()).expect("mensaje");
    assert_eq!(
        m.blocks,
        vec![Block::Text {
            text: "  hola <pasted_contents>\n".into()
        }]
    );
}
