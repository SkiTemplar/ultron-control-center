// sesiones/tests_persistencia_turno.rs — Cerrar a mitad de turno: turnoVivo
// en abiertas.json, lectura tolerante, Workflows vivos en el transcript,
// checkpoint de git y prompt de continuación.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::analisis::analizar;
use super::texto::{continuacion, nota};
use super::*;
use crate::sesiones::persistencia::restaurar::restaurar_todas;
use crate::sesiones::persistencia::{
    entregar_avisos_en, parsear, tomar_avisos, Abierta, Fichero, VERSION,
};
use crate::sesiones::test_sink::MockSink;
use crate::sesiones::types::PermissionMode;
use crate::sesiones::{cola, lanzamiento, registro};

const RUN: &str = "wf_988f9f4d-bf7";
const SHA: &str = "516b0096a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn turno() -> TurnoVivo {
    TurnoVivo {
        desde: Some("2026-10-15T12:30:00.000Z".into()),
        ultimo_prompt: Some("Implementa la pestaña de ajustes".into()),
        herramienta_en_curso: Some("Bash: cargo test".into()),
        workflows_vivos: vec![RUN.into()],
        checkpoint: Some(Checkpoint {
            head: Some(SHA.into()),
            rama: Some("main".into()),
            sucio: true,
        }),
    }
}

fn abierta(id: &str, sid: &str, cwd: &str, t: Option<TurnoVivo>) -> Abierta {
    Abierta {
        id: id.into(),
        project_id: None,
        cwd: cwd.into(),
        title: format!("título {id}"),
        title_auto: false,
        title_source: None,
        claude_session_id: Some(sid.into()),
        transcript: None,
        model: None,
        launch_permission_mode: PermissionMode::Default,
        started_at: "2026-10-15T10:00:00.000Z".into(),
        config: None,
        cola: Vec::new(),
        turno_vivo: t,
    }
}

fn fichero_json(sesion: serde_json::Value) -> String {
    json!({ "version": VERSION, "sesiones": [sesion] }).to_string()
}

fn sesion_json(extra: Option<serde_json::Value>) -> serde_json::Value {
    let mut s = json!({
        "id": "s1", "projectId": null, "cwd": "C:/x", "title": "t",
        "claudeSessionId": null, "transcript": null, "model": null,
        "launchPermissionMode": "default", "startedAt": "2026-10-15T10:00:00.000Z",
        "config": null
    });
    if let Some(v) = extra {
        s["turnoVivo"] = v;
    }
    s
}

// ---------------------------------------------------------------------------
// Persistencia y lectura tolerante
// ---------------------------------------------------------------------------

#[test]
fn turno_vivo_se_guarda_y_se_lee_de_vuelta() {
    let f = Fichero {
        version: VERSION,
        sesiones: vec![abierta("s1", "sid", "C:/x", Some(turno()))],
    };
    let texto = serde_json::to_string_pretty(&f).expect("json");
    assert!(texto.contains("\"turnoVivo\"") && texto.contains("\"workflowsVivos\""));
    assert_eq!(parsear(&texto).expect("leído"), f);
}

#[test]
fn sin_turno_vivo_no_se_escribe_el_campo() {
    let f = Fichero {
        version: VERSION,
        sesiones: vec![abierta("s1", "sid", "C:/x", None)],
    };
    let texto = serde_json::to_string(&f).expect("json");
    assert!(!texto.contains("turnoVivo"));
}

#[test]
fn un_fichero_antiguo_sin_turno_vivo_se_lee() {
    let f = parsear(&fichero_json(sesion_json(None))).expect("formato antiguo");
    assert_eq!(f.sesiones[0].turno_vivo, None);
}

#[test]
fn un_turno_vivo_corrupto_no_tumba_la_sesion() {
    for malo in [
        json!("no es un objeto"),
        json!(42),
        json!(null),
        json!({ "desde": 7, "workflowsVivos": "wf_x" }),
        // Sin turno ni Workflows válidos: no queda nada que contar.
        json!({ "workflowsVivos": ["rm -rf /", "wf_", "../wf_x"] }),
    ] {
        let f = parsear(&fichero_json(sesion_json(Some(malo.clone()))))
            .unwrap_or_else(|e| panic!("{malo}: {e}"));
        assert_eq!(f.sesiones.len(), 1, "{malo}");
        assert_eq!(f.sesiones[0].turno_vivo, None, "{malo}");
    }
}

#[test]
fn la_lectura_sanea_textos_runids_y_head() {
    let largo = "x".repeat(MAX_PROMPT * 3);
    let v = json!({
        "desde": "2026-10-15T12:30:00.000Z",
        "ultimoPrompt": largo,
        "workflowsVivos": [RUN, "wf_ok_1", RUN, "wf_\"; borrar", "otro"],
        "checkpoint": { "head": "no-es-un-sha", "rama": "main", "sucio": false },
        "campoFuturo": true
    });
    let f = parsear(&fichero_json(sesion_json(Some(v)))).expect("leído");
    let t = f.sesiones[0].turno_vivo.clone().expect("turno");
    assert_eq!(t.ultimo_prompt.expect("prompt").chars().count(), MAX_PROMPT);
    assert_eq!(t.workflows_vivos, [RUN, "wf_ok_1"]);
    let c = t.checkpoint.expect("checkpoint");
    assert_eq!((c.head, c.rama.as_deref()), (None, Some("main")));
}

// ---------------------------------------------------------------------------
// Transcript: Workflows vivos, herramienta en curso y último prompt
// ---------------------------------------------------------------------------

fn prompt(texto: &str) -> String {
    json!({
        "type": "user", "isSidechain": false, "uuid": uuid::Uuid::new_v4().to_string(),
        "timestamp": "2026-10-15T12:30:00.000Z",
        "message": { "role": "user", "content": texto }
    })
    .to_string()
}

fn tool_use(id: &str, name: &str, input: serde_json::Value) -> String {
    json!({
        "type": "assistant", "isSidechain": false, "uuid": uuid::Uuid::new_v4().to_string(),
        "timestamp": "2026-10-15T12:30:01.000Z",
        "message": { "role": "assistant", "content": [
            { "type": "tool_use", "id": id, "name": name, "input": input }
        ]}
    })
    .to_string()
}

fn lanzado(tool_id: &str, task: &str, run: &str) -> String {
    json!({
        "type": "user", "isSidechain": false, "uuid": uuid::Uuid::new_v4().to_string(),
        "timestamp": "2026-10-15T12:30:02.000Z",
        "message": { "role": "user", "content": [
            { "tool_use_id": tool_id, "type": "tool_result",
              "content": format!("Workflow launched in background. Task ID: {task}\nRun ID: {run}") }
        ]},
        "toolUseResult": { "status": "async_launched", "taskId": task,
            "taskType": "local_workflow", "runId": run,
            "scriptPath": "C:\\x\\workflows\\scripts\\w.js" }
    })
    .to_string()
}

fn notificacion(tool_id: &str, task: &str) -> String {
    json!({
        "type": "queue-operation", "operation": "enqueue",
        "content": format!("<task-notification>\n<task-id>{task}</task-id>\n<tool-use-id>{tool_id}</tool-use-id>\n<status>completed</status>\n</task-notification>")
    })
    .to_string()
}

fn transcript(lineas: &[String]) -> String {
    lineas.join("\n")
}

#[test]
fn un_workflow_lanzado_sin_notificacion_sigue_vivo() {
    let t = transcript(&[
        prompt("lanza el workflow"),
        tool_use(
            "toolu_wf1",
            "Workflow",
            json!({ "script": "export const meta = {}" }),
        ),
        lanzado("toolu_wf1", "weqq60zzq", RUN),
        tool_use(
            "toolu_b1",
            "Bash",
            json!({ "command": "cargo test", "description": "Tests" }),
        ),
    ]);
    let a = analizar(&t);
    let runs: Vec<&str> = a
        .workflows_vivos
        .iter()
        .map(|w| w.run_id.as_str())
        .collect();
    assert_eq!(runs, [RUN]);
    assert_eq!(a.herramienta_en_curso.as_deref(), Some("Bash: Tests"));
    assert_eq!(a.ultimo_prompt.as_deref(), Some("lanza el workflow"));
}

#[test]
fn un_workflow_con_notificacion_de_final_no_esta_vivo() {
    for fin in [
        notificacion("toolu_wf1", "otro"),
        notificacion("otro", "weqq60zzq"),
    ] {
        let t = transcript(&[
            prompt("lanza"),
            tool_use("toolu_wf1", "Workflow", json!({})),
            lanzado("toolu_wf1", "weqq60zzq", RUN),
            fin,
        ]);
        assert!(analizar(&t).workflows_vivos.is_empty());
    }
}

#[test]
fn un_workflow_retomado_despues_no_se_ofrece_dos_veces() {
    let t = transcript(&[
        tool_use("toolu_wf1", "Workflow", json!({})),
        lanzado("toolu_wf1", "t1", RUN),
        tool_use("toolu_wf2", "Workflow", json!({ "resumeFromRunId": RUN })),
        lanzado("toolu_wf2", "t2", RUN),
    ]);
    let a = analizar(&t);
    let ids: Vec<&str> = a
        .workflows_vivos
        .iter()
        .map(|w| w.tool_use_id.as_str())
        .collect();
    assert_eq!(ids, ["toolu_wf2"]);
}

#[test]
fn herramientas_resueltas_o_de_turnos_anteriores_no_estan_en_curso() {
    let resultado = json!({
        "type": "user", "isSidechain": false,
        "message": { "role": "user", "content": [
            { "tool_use_id": "toolu_b1", "type": "tool_result", "content": "ok" }
        ]}
    })
    .to_string();
    let t = transcript(&[
        tool_use("toolu_b0", "Bash", json!({ "command": "colgado" })),
        prompt("segundo turno"),
        tool_use("toolu_b1", "Read", json!({ "file_path": "a.rs" })),
        resultado,
        "{ línea rota".to_string(),
    ]);
    let a = analizar(&t);
    assert_eq!(a.herramienta_en_curso, None);
    assert!(a.workflows_vivos.is_empty());
    assert_eq!(a.ultimo_prompt.as_deref(), Some("segundo turno"));
}

// ---------------------------------------------------------------------------
// Checkpoint de git
// ---------------------------------------------------------------------------

#[test]
fn el_status_de_git_da_head_rama_y_suciedad() {
    let limpio = format!("# branch.oid {SHA}\n# branch.head main\n");
    let c = parsear_status(&limpio).expect("repo");
    assert_eq!(c.head.as_deref(), Some(SHA));
    assert_eq!(c.rama.as_deref(), Some("main"));
    assert!(!c.sucio);
    let sucio = format!("# branch.oid {SHA}\n# branch.head (detached)\n? nuevo.txt\n");
    let c = parsear_status(&sucio).expect("repo");
    assert!(c.sucio && c.rama.is_none());
    let inicial = "# branch.oid (initial)\n# branch.head main\n";
    assert_eq!(parsear_status(inicial).expect("repo").head, None);
    assert_eq!(
        parsear_status(""),
        None,
        "sin cabecera no es un repositorio"
    );
}

fn git(dir: &Path, args: &[&str]) -> bool {
    std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Plazo holgado para `git status` en las pruebas: lo que se comprueba es la
/// lectura del repositorio, no el plazo. Con el de producción (1,5 s) el test
/// fallaba en windows-latest con la suite en paralelo (run 39983678468).
const PLAZO_GIT_TEST: Duration = Duration::from_secs(60);

#[test]
fn el_checkpoint_lee_un_repositorio_real_sin_tocarlo() {
    let d = tempfile::tempdir().expect("tempdir");
    if !git(d.path(), &["init", "-q"]) {
        eprintln!("git no disponible: se omite");
        return;
    }
    let c = checkpoint_con_plazo(d.path(), PLAZO_GIT_TEST).expect("repo");
    assert_eq!((c.head.clone(), c.sucio), (None, false));
    std::fs::write(d.path().join("a.txt"), "x").expect("fichero");
    assert!(
        checkpoint_con_plazo(d.path(), PLAZO_GIT_TEST)
            .expect("repo")
            .sucio
    );
    assert!(!d.path().join(".git").join("index.lock").exists());
    assert_eq!(checkpoint(&d.path().join("no-existe")), None);
}

/// Caso negativo del plazo: si git no responde a tiempo, el checkpoint es
/// `None` (y el proceso se mata) en vez de bloquear la salida de ULTRON.
#[test]
fn el_checkpoint_sin_plazo_es_none_y_no_bloquea() {
    let d = tempfile::tempdir().expect("tempdir");
    if !git(d.path(), &["init", "-q"]) {
        eprintln!("git no disponible: se omite");
        return;
    }
    let t = std::time::Instant::now();
    assert_eq!(checkpoint_con_plazo(d.path(), Duration::ZERO), None);
    assert!(t.elapsed() < PLAZO_GIT_TEST, "no espera a git");
}

// ---------------------------------------------------------------------------
// Texto de continuación y entrega
// ---------------------------------------------------------------------------

#[test]
fn la_continuacion_con_workflow_pide_reanudarlo_por_su_runid() {
    let script = |run: &str| {
        Some(PathBuf::from(format!(
            "C:\\p\\workflows\\scripts\\w-{run}.js"
        )))
    };
    let t = continuacion(&turno(), &script);
    assert!(t.contains("se cortó a mitad de turno"));
    assert!(t.contains("«Implementa la pestaña de ajustes»"));
    assert!(t.contains("Bash: cargo test"));
    assert!(t.contains("HEAD 516b0096 en main, con cambios sin confirmar"));
    assert!(t.contains(&format!("resumeFromRunId: \"{RUN}\"")));
    assert!(t.contains(&format!(
        "scriptPath: \"C:/p/workflows/scripts/w-{RUN}.js\""
    )));
    assert!(t.contains("`git status`"));
}

#[test]
fn la_continuacion_sin_workflow_ni_repo_no_menciona_ninguno() {
    let t = TurnoVivo {
        workflows_vivos: Vec::new(),
        checkpoint: None,
        ..turno()
    };
    let texto = continuacion(&t, &|_| None);
    assert!(!texto.contains("resumeFromRunId") && !texto.contains("Workflow"));
    assert!(!texto.contains("Checkpoint"));
    assert!(texto.contains("se cortó a mitad de turno"));
    assert!(!nota(&t).contains("Workflow"));
}

#[test]
fn la_continuacion_de_una_sesion_idle_con_workflow_lo_dice() {
    let t = TurnoVivo {
        desde: None,
        herramienta_en_curso: None,
        ..turno()
    };
    let texto = continuacion(&t, &|_| None);
    assert!(texto.starts_with("ULTRON se cerró con un Workflow en segundo plano"));
    assert!(texto.contains(&format!("resumeFromRunId: \"{RUN}\"")));
    assert!(nota(&t).contains(RUN));
}

#[test]
fn restaurar_deja_la_continuacion_pendiente_y_sale_una_vez_con_las_notas() {
    let sid = uuid::Uuid::new_v4().to_string();
    let id = format!("turno-{}", uuid::Uuid::new_v4());
    let d = tempfile::tempdir().expect("tempdir");
    let cwd = d.path().join("proyecto");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let cwd = cwd.to_string_lossy().into_owned();
    let projects = d.path().join("projects");
    let slug = projects.join(registro::claude_slug(&cwd));
    std::fs::create_dir_all(&slug).expect("slug");
    std::fs::write(slug.join(format!("{sid}.jsonl")), "{}\n").expect("jsonl");

    let r = restaurar_todas(vec![abierta(&id, &sid, &cwd, Some(turno()))], &projects);
    assert_eq!(r.len(), 1);
    let pendiente = continuacion_pendiente(&id).expect("continuación preparada");
    assert!(pendiente.contains(RUN));

    let sink = MockSink::opened();
    entregar_avisos_en(Some(&sink), &id);
    let ev = sink.payloads(EV_CONTINUACION);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["id"], json!(id));
    assert_eq!(ev[0]["text"], json!(pendiente));
    let notas = sink.payloads(crate::sesiones::types::ev::NOTICE);
    assert!(notas
        .iter()
        .any(|n| n["text"].as_str().is_some_and(|t| t.contains("sin enviar"))));
    entregar_avisos_en(Some(&sink), &id);
    assert_eq!(sink.payloads(EV_CONTINUACION).len(), 1, "solo una vez");

    registro::remove(&id);
    cola::global().olvidar(&id);
    lanzamiento::olvidar(&id);
    tomar_avisos(&id);
}

#[test]
fn una_sesion_sin_turno_vivo_no_deja_continuacion() {
    let sid = uuid::Uuid::new_v4().to_string();
    let id = format!("turno-{}", uuid::Uuid::new_v4());
    let d = tempfile::tempdir().expect("tempdir");
    let cwd = d.path().to_string_lossy().into_owned();
    let projects = d.path().join("projects");
    let slug = projects.join(registro::claude_slug(&cwd));
    std::fs::create_dir_all(&slug).expect("slug");
    std::fs::write(slug.join(format!("{sid}.jsonl")), "{}\n").expect("jsonl");
    let r = restaurar_todas(vec![abierta(&id, &sid, &cwd, None)], &projects);
    assert_eq!(r.len(), 1);
    assert_eq!(continuacion_pendiente(&id), None);
    registro::remove(&id);
    cola::global().olvidar(&id);
    lanzamiento::olvidar(&id);
    tomar_avisos(&id);
}

#[test]
fn el_script_del_workflow_se_busca_junto_al_transcript() {
    let d = tempfile::tempdir().expect("tempdir");
    let jsonl = d.path().join("abc.jsonl");
    let dir = d.path().join("abc").join("workflows").join("scripts");
    std::fs::create_dir_all(&dir).expect("dir");
    std::fs::write(dir.join(format!("impl-{RUN}.js")), "").expect("script");
    assert_eq!(
        script_de(&jsonl, RUN),
        Some(dir.join(format!("impl-{RUN}.js")))
    );
    assert_eq!(script_de(&jsonl, "wf_otro"), None);
}
