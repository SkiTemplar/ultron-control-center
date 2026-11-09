// sesiones/tests_persistencia_en_vuelo.rs — Envíos en `sending` al cerrar
// ULTRON cruzados con el transcript al restaurar (hallazgo #35).

use super::*;
use crate::sesiones::types::QueueOrigin;

fn guardado(client_id: &str, text: &str, kind: QueueItemKind, en_vuelo: bool) -> Guardado {
    Guardado {
        client_id: client_id.into(),
        text: text.into(),
        attachments: Vec::new(),
        delegate: false,
        kind,
        origin: QueueOrigin::Ultron,
        state: QueueState::Queued,
        created_at: "2026-10-14T00:00:00.000Z".into(),
        error: en_vuelo.then(|| AVISO_SENDING.to_string()),
    }
}

fn prompt(uuid: &str, texto: &str) -> String {
    serde_json::json!({
        "type": "user", "uuid": uuid, "timestamp": "t",
        "message": { "role": "user", "content": texto }
    })
    .to_string()
}

fn transcript(lineas: &[String]) -> (tempfile::TempDir, std::path::PathBuf) {
    let d = tempfile::tempdir().expect("tempdir");
    let p = d.path().join("t.jsonl");
    std::fs::write(&p, lineas.join("\n") + "\n").expect("transcript");
    (d, p)
}

fn ids(r: &Reparto) -> Vec<(&str, Option<&str>)> {
    r.cola
        .iter()
        .map(|g| (g.client_id.as_str(), g.error.as_deref()))
        .collect()
}

/// El último prompt del transcript es el envío en vuelo: ya llegó y no se
/// repone (si se repusiera, la máquina lo drenaría y se duplicaría).
#[test]
fn un_envio_que_consta_en_el_transcript_no_se_repone() {
    let (_d, p) = transcript(&[prompt("u1", "antes"), prompt("u2", "haz   el\ncambio")]);
    let cola = [
        guardado("s1", "haz el cambio", QueueItemKind::Prompt, true),
        guardado("q1", "después", QueueItemKind::Prompt, false),
    ];
    let r = resolver(&cola, &p);
    assert_eq!(ids(&r), [("q1", None)]);
    assert_eq!((r.llegados, r.no_llegados, r.sin_comprobar), (1, 0, 0));
}

/// Caso negativo: el último prompt es otro, así que no llegó y se repone sin
/// aviso.
#[test]
fn un_envio_que_no_consta_se_repone_sin_aviso() {
    let (_d, p) = transcript(&[prompt("u1", "haz el cambio"), prompt("u2", "otra cosa")]);
    let cola = [guardado("s1", "haz el cambio", QueueItemKind::Prompt, true)];
    let r = resolver(&cola, &p);
    assert_eq!(ids(&r), [("s1", None)]);
    assert_eq!((r.llegados, r.no_llegados, r.sin_comprobar), (0, 1, 0));
}

/// Un pegado largo que la CLI guarda envuelto en `<pasted_content>` también
/// cuenta como llegado (mismo criterio que el emparejado de la cola).
#[test]
fn un_pegado_envuelto_cuenta_como_llegado() {
    let largo = "línea de un pegado largo que ocupa bastante texto ".repeat(4);
    let envuelto = format!("\n\n<pasted_content id=\"7\">\n{largo}\n</pasted_content id=\"7\">\n");
    let (_d, p) = transcript(&[prompt("u1", &envuelto)]);
    let cola = [guardado("s1", &largo, QueueItemKind::Prompt, true)];
    assert_eq!(resolver(&cola, &p).llegados, 1);
}

/// Un prompt que solo empieza igual (una plantilla) no prueba la entrega: se
/// repone con aviso. Antes se daba por llegado y el mensaje se perdía.
#[test]
fn un_prompt_que_solo_empieza_igual_no_da_el_envio_por_llegado() {
    let plantilla = "revisa este módulo con el formato de siempre y dime";
    let (_d, p) = transcript(&[prompt("u1", &format!("{plantilla} qué falla en A"))]);
    let cola = [guardado(
        "s1",
        &format!("{plantilla} qué falla en B"),
        QueueItemKind::Prompt,
        true,
    )];
    let r = resolver(&cola, &p);
    assert_eq!(r.llegados, 0);
    assert_eq!(ids(&r), [("s1", Some(AVISO_SIN_COMPROBAR))]);
}

/// Caso negativo: contenido entero en lo recibido sí es evidencia de entrega.
#[test]
fn un_prompt_que_contiene_el_envio_si_cuenta_como_llegado() {
    let (_d, p) = transcript(&[prompt("u1", "Contexto previo. haz el cambio pendiente")]);
    let cola = [guardado(
        "s1",
        "haz el cambio pendiente",
        QueueItemKind::Prompt,
        true,
    )];
    assert_eq!(resolver(&cola, &p).llegados, 1);
}

/// Sin prompts en el transcript, sin transcript o con un comando de barra no
/// se puede comprobar: se repone con un aviso que no promete margen.
#[test]
fn sin_poder_comprobar_se_repone_con_aviso() {
    let (_d, p) = transcript(&["{}".to_string()]);
    let cola = [guardado("s1", "hola", QueueItemKind::Prompt, true)];
    let r = resolver(&cola, &p);
    assert_eq!(ids(&r), [("s1", Some(AVISO_SIN_COMPROBAR))]);
    assert!(!AVISO_SIN_COMPROBAR.contains("antes de que salga"));
    let r = resolver(&cola, &p.with_file_name("no-existe.jsonl"));
    assert_eq!(r.sin_comprobar, 1);
    let (_d2, p2) = transcript(&[prompt("u1", "/compact")]);
    let cmd = [guardado("c1", "/compact", QueueItemKind::Command, true)];
    assert_eq!(resolver(&cmd, &p2).sin_comprobar, 1);
}

/// Un `!comando` se compara con el `<bash-input>` del transcript.
#[test]
fn un_bash_en_vuelo_se_compara_con_su_bash_input() {
    let (_d, p) = transcript(&[prompt("u1", "<bash-input>git status</bash-input>")]);
    let cola = [guardado("b1", "!git status", QueueItemKind::Bash, true)];
    assert_eq!(resolver(&cola, &p).llegados, 1);
    let otro = [guardado("b2", "!git log", QueueItemKind::Bash, true)];
    assert_eq!(resolver(&otro, &p).no_llegados, 1);
}

/// Con varios envíos en vuelo, el mensaje solo da por llegado a uno; el resto
/// no se puede afirmar que no llegara.
#[test]
fn varios_en_vuelo_solo_uno_llega_y_el_resto_queda_sin_comprobar() {
    let (_d, p) = transcript(&[prompt("u1", "uno")]);
    let cola = [
        guardado("s1", "uno", QueueItemKind::Prompt, true),
        guardado("s2", "uno", QueueItemKind::Prompt, true),
    ];
    let r = resolver(&cola, &p);
    assert_eq!(ids(&r), [("s2", Some(AVISO_SIN_COMPROBAR))]);
    assert_eq!((r.llegados, r.sin_comprobar), (1, 1));
}

/// Sin envíos en vuelo la cola pasa tal cual y no se lee el transcript; un
/// aviso de «sin comprobar» de un arranque anterior no vuelve a cruzarse.
#[test]
fn sin_envios_en_vuelo_la_cola_pasa_tal_cual() {
    let mut previo = guardado("q2", "x", QueueItemKind::Prompt, false);
    previo.error = Some(AVISO_SIN_COMPROBAR.to_string());
    let cola = [guardado("q1", "hola", QueueItemKind::Prompt, false), previo];
    let r = resolver(&cola, Path::new("no-existe.jsonl"));
    assert_eq!(
        r,
        Reparto {
            cola: cola.to_vec(),
            ..Reparto::default()
        }
    );
}

/// Solo se leen los últimos bytes y se descarta la línea cortada.
#[test]
fn la_cola_del_transcript_descarta_la_linea_cortada() {
    let (_d, p) = transcript(&[prompt("u1", "primero"), prompt("u2", "último")]);
    let largo = std::fs::metadata(&p).expect("meta").len();
    let ultima = prompt("u2", "último").len() as u64 + 1;
    let texto = leer_cola(&p, ultima + 5).expect("cola");
    assert_eq!(texto.trim_end(), prompt("u2", "último"));
    assert_eq!(leer_cola(&p, largo).expect("entero").lines().count(), 2);
}
