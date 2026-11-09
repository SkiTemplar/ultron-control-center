// sesiones/tests_pagina.rs — Tests del historial paginado (CONTRATO-v3 §7)
// con transcripts sintéticos en un directorio temporal.

use super::*;

fn prompt(i: usize) -> String {
    format!(
        r#"{{"type":"user","uuid":"u{i}","timestamp":"t","message":{{"role":"user","content":"pregunta {i}"}}}}"#
    )
}

fn respuesta(i: usize, j: usize) -> String {
    format!(
        r#"{{"type":"assistant","uuid":"a{i}-{j}","timestamp":"t","message":{{"id":"m{i}-{j}","role":"assistant","content":[{{"type":"text","text":"respuesta {j}"}}]}}}}"#
    )
}

fn encolado(i: usize) -> String {
    format!(
        r#"{{"type":"attachment","uuid":"q{i}","timestamp":"t","attachment":{{"type":"queued_command","prompt":"a mitad {i}","commandMode":"prompt","origin":{{"kind":"human"}}}}}}"#
    )
}

/// `turnos` turnos de un prompt y `respuestas` respuestas cada uno.
fn transcript(turnos: usize, respuestas: usize) -> String {
    let mut lineas = Vec::new();
    for i in 0..turnos {
        lineas.push(prompt(i));
        lineas.extend((0..respuestas).map(|j| respuesta(i, j)));
    }
    lineas.join("\n") + "\n"
}

fn escribir(dir: &tempfile::TempDir, texto: &str) -> std::path::PathBuf {
    let p = dir.path().join("t.jsonl");
    std::fs::write(&p, texto).expect("escribir");
    p
}

fn uuids(p: &HistoryPage) -> Vec<&str> {
    p.messages.iter().map(|m| m.uuid.as_str()).collect()
}

#[test]
fn el_limite_se_recorta_al_rango() {
    assert_eq!(limite(None), LIMITE_POR_DEFECTO);
    assert_eq!(limite(Some(0)), 1);
    assert_eq!(limite(Some(50_000)), LIMITE_MAXIMO);
    assert_eq!(limite(Some(7)), 7);
}

#[test]
fn la_ultima_pagina_no_parte_el_turno_y_se_encadena() {
    let dir = tempfile::tempdir().expect("tempdir");
    let p = escribir(&dir, &transcript(10, 4));
    let pag = leer(Some(&p), None, None, Some(7)).expect("página");
    assert_eq!(
        pag.messages.len(),
        10,
        "retrocede hasta el prompt del turno"
    );
    assert_eq!(pag.messages[0].uuid, "u8");
    assert_eq!(pag.messages[9].uuid, "a9-3");
    assert!(pag.has_more);
    let antes = pag.messages[0].uuid.clone();
    let pag2 = leer(Some(&p), None, Some(&antes), Some(7)).expect("página 2");
    assert_eq!(pag2.messages[0].uuid, "u6");
    assert_eq!(pag2.messages.last().map(|m| m.uuid.as_str()), Some("a7-3"));
    let todo = leer(Some(&p), None, None, Some(2_000)).expect("todo");
    assert_eq!(todo.messages.len(), 50);
    assert!(!todo.has_more, "sin nada antes, sin más páginas");
}

#[test]
fn un_cursor_que_no_existe_es_history_cursor_gone() {
    let dir = tempfile::tempdir().expect("tempdir");
    let p = escribir(&dir, &transcript(3, 1));
    let e = leer(Some(&p), None, Some("no-existe"), None).expect_err("cursor perdido");
    assert_eq!(e, CURSOR_PERDIDO);
    let e = leer(Some(&p), None, Some(""), None).expect_err("cursor vacío");
    assert_eq!(e, CURSOR_PERDIDO);
    let sin_fichero = dir.path().join("nada.jsonl");
    let e = leer(Some(&sin_fichero), None, Some("u1"), None).expect_err("sin fichero");
    assert_eq!(e, CURSOR_PERDIDO);
    let vacia = leer(Some(&sin_fichero), None, None, None).expect("vacía");
    assert!(vacia.messages.is_empty() && !vacia.has_more);
}

#[test]
fn un_turno_mas_largo_que_dos_paginas_se_corta_en_el_limite() {
    let msgs = super::transcript::parse_all(&transcript(2, 10), None);
    let pag = paginar(msgs, None, 3).expect("página");
    assert_eq!(uuids(&pag), ["a1-7", "a1-8", "a1-9"], "sin prompt a mano");
    assert!(pag.has_more);
}

#[test]
fn el_principio_del_transcript_es_frontera_de_turno() {
    let mut texto = String::from(&respuesta(0, 0));
    texto.push('\n');
    texto.push_str(&respuesta(0, 1));
    texto.push('\n');
    texto.push_str(&respuesta(0, 2));
    let msgs = super::transcript::parse_all(&texto, None);
    let pag = paginar(msgs, None, 2).expect("página");
    assert_eq!(uuids(&pag), ["a0-0", "a0-1", "a0-2"]);
    assert!(!pag.has_more);
}

#[test]
fn un_prompt_encolado_no_abre_turno() {
    let texto = [prompt(0), respuesta(0, 0), encolado(1), respuesta(0, 1)].join("\n");
    let msgs = super::transcript::parse_all(&texto, None);
    assert!(msgs.iter().any(|m| m.uuid == "q1" && m.queued));
    let pag = paginar(msgs, None, 2).expect("página");
    assert_eq!(uuids(&pag), ["u0", "a0-0", "q1", "a0-1"]);
}

#[test]
fn la_pagina_de_un_subagente_lleva_su_agent_id() {
    let dir = tempfile::tempdir().expect("tempdir");
    let p = escribir(&dir, &transcript(3, 2));
    let pag = leer(Some(&p), Some("ag1"), None, Some(3)).expect("página");
    assert_eq!(uuids(&pag), ["u2", "a2-0", "a2-1"]);
    assert!(pag
        .messages
        .iter()
        .all(|m| m.agent_id.as_deref() == Some("ag1")));
}

#[test]
fn la_pagina_viaja_en_camel_case() {
    let pag = HistoryPage {
        messages: Vec::new(),
        has_more: true,
    };
    let v = serde_json::to_value(&pag).expect("json");
    assert_eq!(v, serde_json::json!({ "messages": [], "hasMore": true }));
}

fn grande(i: usize, kb: usize) -> String {
    let texto = "g".repeat(kb * 1_000);
    format!(
        r#"{{"type":"assistant","uuid":"g{i}","timestamp":"t","message":{{"id":"mg{i}","role":"assistant","content":[{{"type":"text","text":"{texto}"}}]}}}}"#
    )
}

#[test]
fn el_peso_corta_la_pagina_y_la_siguiente_continua() {
    let lineas: Vec<String> = std::iter::once(prompt(0))
        .chain((0..10).map(|i| grande(i, 100)))
        .collect();
    let msgs = super::transcript::parse_all(&lineas.join("\n"), None);
    let pag = paginar_con(msgs.clone(), None, 400, 350_000).expect("página");
    assert_eq!(
        uuids(&pag),
        ["g7", "g8", "g9"],
        "tres de 100 KB caben en 350 KB"
    );
    assert!(pag.has_more);
    let pag2 = paginar_con(msgs.clone(), Some("g7"), 400, 350_000).expect("página 2");
    assert_eq!(uuids(&pag2), ["g4", "g5", "g6"]);
    let ultima = paginar_con(msgs, Some("g1"), 400, 350_000).expect("última");
    assert_eq!(uuids(&ultima), ["u0", "g0"], "retrocede al prompt si cabe");
    assert!(!ultima.has_more);
}

#[test]
fn un_mensaje_mas_pesado_que_el_tope_viaja_solo() {
    let texto = [prompt(0), grande(0, 50), grande(1, 500)].join("\n");
    let msgs = super::transcript::parse_all(&texto, None);
    let pag = paginar_con(msgs, None, 400, 100_000).expect("página");
    assert_eq!(
        uuids(&pag),
        ["g1"],
        "nunca vacía; sin retroceso por encima del tope"
    );
    assert!(pag.has_more);
}
