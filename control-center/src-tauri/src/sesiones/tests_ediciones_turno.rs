// Tests de `ediciones_turno`: cuenta sobre el transcript del hilo principal y
// de los subagentes, sin depender de lo que conserve la ventana.

use super::*;
use serde_json::json;
use std::path::PathBuf;

const INICIO: &str = "2026-10-19T12:00:00.000Z";

fn desde() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(INICIO)
        .expect("fecha")
        .with_timezone(&Utc)
}

fn edicion(ts: &str, herramienta: &str, ruta: &str) -> String {
    let clave = if herramienta == "NotebookEdit" {
        "notebook_path"
    } else {
        "file_path"
    };
    json!({
        "type": "assistant",
        "timestamp": ts,
        "message": { "content": [
            { "type": "text", "text": "hecho" },
            { "type": "tool_use", "id": "t", "name": herramienta, "input": { clave: ruta } }
        ]}
    })
    .to_string()
}

fn usuario(ts: &str) -> String {
    json!({ "type": "user", "timestamp": ts, "message": { "content": "sigue" } }).to_string()
}

fn escribir(dir: &Path, nombre: &str, lineas: &[String]) -> PathBuf {
    let p = dir.join(nombre);
    std::fs::create_dir_all(p.parent().expect("padre")).expect("dir");
    std::fs::write(&p, lineas.join("\n") + "\n").expect("escribir");
    p
}

#[test]
fn cuenta_solo_las_ediciones_del_turno_sin_duplicados() {
    let dir = tempfile::tempdir().expect("tempdir");
    let main = escribir(
        dir.path(),
        "s.jsonl",
        &[
            edicion("2026-10-19T11:00:00.000Z", "Write", "C:/p/viejo.rs"),
            usuario(INICIO),
            edicion("2026-10-19T12:00:01.000Z", "Edit", "C:/p/a.rs"),
            edicion("2026-10-19T12:00:02.000Z", "MultiEdit", "C:/p/b.rs"),
            edicion("2026-10-19T12:00:03.000Z", "Edit", "C:/p/a.rs"),
            edicion("2026-10-19T12:00:04.000Z", "NotebookEdit", "C:/p/n.ipynb"),
            edicion("2026-10-19T12:00:05.000Z", "Read", "C:/p/leido.rs"),
        ],
    );
    let r = editados(Some(&main), None, desde());
    assert_eq!(r, ["C:/p/a.rs", "C:/p/b.rs", "C:/p/n.ipynb"]);
}

#[test]
fn un_turno_mas_largo_que_la_primera_ventana_se_cuenta_entero() {
    let dir = tempfile::tempdir().expect("tempdir");
    let relleno = "x".repeat(4_000);
    let mut lineas = vec![usuario("2026-10-19T11:59:59.000Z")];
    lineas.push(edicion(
        "2026-10-19T12:00:01.000Z",
        "Write",
        "C:/p/primero.rs",
    ));
    for i in 0..200 {
        let ts = format!("2026-10-19T12:{:02}:{:02}.000Z", 1 + i / 60, i % 60);
        lineas.push(
            json!({ "type": "assistant", "timestamp": ts,
                    "message": { "content": [{ "type": "text", "text": relleno }] } })
            .to_string(),
        );
    }
    lineas.push(edicion(
        "2026-10-19T12:05:00.000Z",
        "Edit",
        "C:/p/ultimo.rs",
    ));
    let main = escribir(dir.path(), "s.jsonl", &lineas);
    assert!(
        std::fs::metadata(&main).expect("meta").len() > lectura_final::VENTANA_INICIAL,
        "el turno no cabe en la primera ventana"
    );
    let r = editados(Some(&main), None, desde());
    assert_eq!(r, ["C:/p/primero.rs", "C:/p/ultimo.rs"]);
}

#[test]
fn suma_los_subagentes_escritos_durante_el_turno() {
    let dir = tempfile::tempdir().expect("tempdir");
    let main = escribir(
        dir.path(),
        "s.jsonl",
        &[
            usuario(INICIO),
            edicion("2026-10-19T12:00:01.000Z", "Edit", "C:/p/a.rs"),
        ],
    );
    let sub = dir.path().join("s").join("subagents");
    escribir(
        &sub,
        "agent-a1.jsonl",
        &[edicion("2026-10-19T12:00:02.000Z", "Write", "C:/p/sub.rs")],
    );
    escribir(
        &sub,
        "workflows/wf_1/agent-a2.jsonl",
        &[edicion("2026-10-19T12:00:03.000Z", "Edit", "C:/p/wf.rs")],
    );
    let r = editados(Some(&main), Some(&sub), desde());
    assert_eq!(r, ["C:/p/a.rs", "C:/p/sub.rs", "C:/p/wf.rs"]);
}

#[test]
fn un_subagente_de_un_turno_anterior_no_cuenta() {
    let dir = tempfile::tempdir().expect("tempdir");
    let sub = dir.path().join("subagents");
    escribir(
        &sub,
        "agent-viejo.jsonl",
        &[edicion(
            "2026-10-19T11:00:00.000Z",
            "Write",
            "C:/p/viejo.rs",
        )],
    );
    assert!(editados(None, Some(&sub), desde()).is_empty());
}

#[test]
fn sin_transcript_ni_subagentes_no_hay_ficheros() {
    let dir = tempfile::tempdir().expect("tempdir");
    let nada = dir.path().join("no-existe.jsonl");
    assert!(editados(Some(&nada), Some(&dir.path().join("sub")), desde()).is_empty());
}

#[test]
fn las_lineas_rotas_o_sin_fecha_no_rompen_la_cuenta() {
    let dir = tempfile::tempdir().expect("tempdir");
    let sin_fecha = json!({ "type": "assistant", "message": { "content": [
        { "type": "tool_use", "name": "Write", "input": { "file_path": "C:/p/sin-fecha.rs" } }
    ]}})
    .to_string();
    let main = escribir(
        dir.path(),
        "s.jsonl",
        &[
            usuario(INICIO),
            "{ no es json".to_string(),
            sin_fecha,
            edicion("2026-10-19T12:00:01.000Z", "Write", ""),
            edicion("2026-10-19T12:00:02.000Z", "Write", "C:/p/ok.rs"),
        ],
    );
    assert_eq!(editados(Some(&main), None, desde()), ["C:/p/ok.rs"]);
}

#[test]
fn el_tope_corta_la_lista() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut lineas = vec![usuario(INICIO)];
    for i in 0..(MAX_FICHEROS + 20) {
        lineas.push(edicion(
            "2026-10-19T12:00:01.000Z",
            "Write",
            &format!("C:/p/f{i}.rs"),
        ));
    }
    let main = escribir(dir.path(), "s.jsonl", &lineas);
    assert_eq!(editados(Some(&main), None, desde()).len(), MAX_FICHEROS);
}
