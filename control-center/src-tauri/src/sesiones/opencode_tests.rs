// Tests de `opencode` (argumentos, permisos de la opinión, entrega del
// prompt) y de `opencode_sesion` (continuidad y sesión caducada).

use std::sync::Mutex;

use super::sesion::{
    al_terminar, aviso_sesion_caducada, recordar_para_prueba, sesion_caducada, sesion_para,
    Reintento,
};
use super::*;
use crate::sesiones::types::CodexEvent;

fn tarea(sid: &str) -> EngineTask {
    EngineTask {
        id: "t".into(),
        engine: "opencode".into(),
        kind: "task".into(),
        mode: "local".into(),
        cwd: ".".into(),
        prompt: "x".into(),
        status: "running".into(),
        started_at: String::new(),
        finished_at: None,
        events: Vec::new(),
        summary: None,
        cloud_task_id: None,
        session_id: Some(sid.into()),
        thread_id: Some("ses_abc".into()),
        context_chars: 0,
        model: None,
        brought_at: None,
        anchor_message_uuid: None,
        usage: None,
        group: None,
    }
}

fn arg(p: &str) -> Entrega {
    Entrega::Argumento(p.into())
}

fn no_relanzar(_: &EngineTask, _: String, _: String) {
    panic!("no debía relanzarse");
}

/// Relanzamientos anotados por `anotar` (prompt, aviso).
static RELANZADOS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn anotar(_: &EngineTask, prompt: String, aviso: String) {
    RELANZADOS.lock().expect("lock").push((prompt, aviso));
}

/// Relanzamiento que no anota (para no tocar `RELANZADOS` de otros tests).
fn relanzar_mudo(_: &EngineTask, _: String, _: String) {}

/// Sesiones cuyo fin de turno llegó al relevo (`fin` de `al_terminar`).
static FINALIZADAS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn anotar_fin(t: &EngineTask) {
    let sid = t.session_id.clone().unwrap_or_default();
    FINALIZADAS.lock().expect("lock").push(sid);
}

fn finalizada(sid: &str) -> bool {
    FINALIZADAS.lock().expect("lock").iter().any(|s| s == sid)
}

#[test]
fn la_tarea_va_con_auto_y_el_prompt_tras_el_separador() {
    let a = run_args(
        "C:\\p",
        "task",
        Some("deepseek/deepseek-flash"),
        None,
        &arg("-x hola"),
    );
    assert_eq!(&a[..3], ["run", "--format", "json"]);
    assert!(a.windows(2).any(|w| w == ["-m", "deepseek/deepseek-flash"]));
    assert!(a.windows(2).any(|w| w == ["--dir", "C:\\p"]));
    assert!(a.contains(&"--auto".to_string()));
    assert!(!a.contains(&"plan".to_string()));
    assert_eq!(
        &a[a.len() - 2..],
        ["--", "-x hola"],
        "un prompt con guion no es un flag"
    );
}

#[test]
fn la_opinion_usa_el_agente_plan_sin_auto() {
    let a = run_args("C:\\p", "opinion", None, None, &arg("x"));
    assert!(a.windows(2).any(|w| w == ["--agent", "plan"]));
    assert!(
        !a.contains(&"--auto".to_string()),
        "--auto aprobaría lo que no esté denegado"
    );
    assert!(!a.contains(&"-m".to_string()), "sin modelo, el de OpenCode");
}

fn permisos_de(kind: &str) -> Option<serde_json::Value> {
    let mut cmd = Command::new("opencode");
    aplicar_permisos(&mut cmd, kind);
    let v = cmd
        .get_envs()
        .find(|(k, _)| *k == VAR_PERMISOS)?
        .1?
        .to_string_lossy()
        .into_owned();
    Some(serde_json::from_str(&v).expect("JSON válido"))
}

#[test]
fn la_opinion_deniega_editar_escribir_y_bash() {
    let p = permisos_de("opinion").expect("permisos de la opinión");
    for k in ["edit", "write", "bash", "task", "external_directory"] {
        assert_eq!(p[k], "deny", "{k}");
    }
    assert_eq!(p["read"]["*.env"], "deny");
    assert!(
        permisos_de("task").is_none(),
        "las tareas siguen como estaban"
    );
}

#[test]
fn la_sesion_solo_se_continua_con_un_id_valido() {
    let a = run_args("C:\\p", "task", None, Some("ses_e86d7186dffeQ7"), &arg("x"));
    assert!(a
        .windows(2)
        .any(|w| w == ["--session", "ses_e86d7186dffeQ7"]));
    let b = run_args("C:\\p", "task", None, Some("--auto ses"), &arg("x"));
    assert!(!b.contains(&"--session".to_string()));
    assert!(!sesion_valida("ses_"));
    assert!(!sesion_valida("ses_a b"));
}

#[test]
fn un_prompt_corto_va_como_argumento_y_uno_largo_como_adjunto() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert_eq!(entrega_para("hola", dir.path()), Ok(arg("hola")));
    let largo = "x".repeat(PROMPT_ARG_MAX + 1);
    let Ok(Entrega::Adjunto(f)) = entrega_para(&largo, dir.path()) else {
        panic!("debía ir adjunto");
    };
    assert_eq!(
        std::fs::read_to_string(&f).map(|s| s.len()).ok(),
        Some(largo.len())
    );
    let a = run_args("C:\\p", "task", None, None, &Entrega::Adjunto(f.clone()));
    assert!(a
        .windows(2)
        .any(|w| w[0] == "-f" && w[1] == f.to_string_lossy()));
    assert_eq!(a.last().map(String::as_str), Some(MENSAJE_ADJUNTO));
    assert!(a.iter().all(|x| x.len() < 1000));
}

#[test]
fn al_terminar_borra_el_adjunto_y_recuerda_la_sesion_solo_si_fue_bien() {
    let dir = tempfile::tempdir().expect("tempdir");
    let f = dir.path().join("encargo.md");
    std::fs::write(&f, "x").expect("fichero");
    let mut t = tarea("s-oc-1");
    t.status = "error".into();
    al_terminar(Some(f.clone()), None, no_relanzar, anotar_fin)(&t);
    assert!(!f.exists(), "el adjunto se borra");
    assert_eq!(sesion_para(Some("s-oc-1")), None, "un fallo no se continúa");
    t.status = "done".into();
    al_terminar(None, None, no_relanzar, anotar_fin)(&t);
    assert_eq!(sesion_para(Some("s-oc-1")).as_deref(), Some("ses_abc"));
}

fn caducada(sid: &str) -> EngineTask {
    let mut t = tarea(sid);
    t.status = "error".into();
    t.thread_id = None;
    t.events.push(CodexEvent {
        kind: "error".into(),
        text: "\u{1b}[91m\u{1b}[1mError: \u{1b}[0mSession not found".into(),
    });
    t
}

#[test]
fn una_sesion_recordada_que_ya_no_existe_se_olvida_y_se_relanza_sin_ella() {
    recordar_para_prueba("s-oc-2", "ses_vieja");
    let t = caducada("s-oc-2");
    assert!(sesion_caducada(&t));
    let r = Reintento {
        sesion: "ses_vieja".into(),
        prompt: "el encargo".into(),
    };
    al_terminar(None, Some(r), anotar, anotar_fin)(&t);
    assert_eq!(sesion_para(Some("s-oc-2")), None, "se olvida");
    let relanzados = RELANZADOS.lock().expect("lock").clone();
    assert_eq!(
        relanzados,
        vec![("el encargo".to_string(), aviso_sesion_caducada("ses_vieja"))]
    );
}

#[test]
fn otro_fallo_con_sesion_no_la_olvida_ni_relanza() {
    recordar_para_prueba("s-oc-3", "ses_buena");
    let mut t = tarea("s-oc-3");
    t.status = "error".into();
    t.events.push(CodexEvent {
        kind: "error".into(),
        text: "Authentication Fails".into(),
    });
    let r = Reintento {
        sesion: "ses_buena".into(),
        prompt: "x".into(),
    };
    al_terminar(None, Some(r), no_relanzar, anotar_fin)(&t);
    assert_eq!(sesion_para(Some("s-oc-3")).as_deref(), Some("ses_buena"));
}

#[test]
fn el_aviso_del_relanzamiento_es_el_primer_evento() {
    let step = r#"{"type":"step_start","sessionID":"ses_n1","part":{}}"#;
    let mut p = parser_con_aviso(Some("aviso".into()));
    let e = p(step).event.expect("aviso");
    assert_eq!((e.kind.as_str(), e.text.as_str()), ("warning", "aviso"));
    assert!(p(step).event.is_none(), "solo una vez");
    assert!(parser_con_aviso(None)(step).event.is_none());
}

#[test]
fn un_mensaje_del_modelo_que_cita_session_not_found_no_es_sesion_caducada() {
    recordar_para_prueba("s-oc-4", "ses_viva");
    let mut t = tarea("s-oc-4");
    t.status = "error".into();
    t.events.push(CodexEvent {
        kind: "message".into(),
        text: "El log decía `Error: Session not found` en otra ejecución.".into(),
    });
    t.events.push(CodexEvent {
        kind: "error".into(),
        text: "Authentication Fails".into(),
    });
    assert!(!sesion_caducada(&t), "el texto del modelo no cuenta");
    let r = Reintento {
        sesion: "ses_viva".into(),
        prompt: "x".into(),
    };
    al_terminar(None, Some(r), no_relanzar, anotar_fin)(&t);
    assert_eq!(sesion_para(Some("s-oc-4")).as_deref(), Some("ses_viva"));
}

#[test]
fn un_fallo_de_opencode_llega_al_relevo_y_el_relanzamiento_no() {
    let mut t = tarea("s-oc-fin");
    t.kind = "relay".into();
    t.status = "error".into();
    al_terminar(None, None, no_relanzar, anotar_fin)(&t);
    assert!(
        finalizada("s-oc-fin"),
        "sin esto el relevo no escala a Codex"
    );
    recordar_para_prueba("s-oc-fin-2", "ses_vieja");
    let r = Reintento {
        sesion: "ses_vieja".into(),
        prompt: "x".into(),
    };
    al_terminar(None, Some(r), relanzar_mudo, anotar_fin)(&caducada("s-oc-fin-2"));
    assert!(
        !finalizada("s-oc-fin-2"),
        "el turno sigue en la tarea relanzada"
    );
}

#[test]
fn la_tarea_relanzada_entra_en_el_relevo() {
    crate::sesiones::relevo::insert_for_test("s-oc-relanzada", "opencode", "traspaso");
    let original = tarea("s-oc-relanzada");
    let mut nueva = tarea("s-oc-relanzada");
    nueva.id = "t-relanzada".into();
    nueva.kind = "relay".into();
    // El ancla falla (la tarea no existe en el registro de motores), pero el
    // registro en el relevo va antes.
    let _ = tras_relanzar(&nueva, &original, crate::sesiones::relevo::track_task);
    let ids = crate::sesiones::relevo::get("s-oc-relanzada").map(|s| s.task_ids);
    assert_eq!(ids, Some(vec!["t-relanzada".to_string()]));
}

#[test]
fn el_relevo_va_siempre_en_fichero_y_solo_con_la_key_de_su_proveedor() {
    let dir = tempfile::tempdir().expect("tempdir");
    let relay = entrega_segun("relay", "corto", dir.path()).expect("relevo");
    assert!(matches!(relay, Entrega::Adjunto(_)), "{relay:?}");
    assert_eq!(entrega_segun("task", "corto", dir.path()), Ok(arg("corto")));
    let todas = || {
        entorno::PROVEEDORES
            .iter()
            .map(|p| (p, "k".to_string()))
            .collect::<Vec<_>>()
    };
    let solo = entorno::claves_para(todas(), "relay", Some("anthropic/claude-sonnet-5-5"));
    assert_eq!(
        solo.iter().map(|(p, _)| p.id).collect::<Vec<_>>(),
        vec!["anthropic"]
    );
    assert!(entorno::claves_para(todas(), "relay", None).is_empty());
    assert_eq!(
        entorno::claves_para(todas(), "task", None).len(),
        todas().len()
    );
}

/// Codex #5: con modelo explícito, una tarea normal tampoco ve las demás keys.
#[test]
fn un_modelo_explicito_solo_recibe_la_key_de_su_proveedor() {
    let todas = || {
        entorno::PROVEEDORES
            .iter()
            .map(|p| (p, "k".to_string()))
            .collect::<Vec<_>>()
    };
    let solo = entorno::claves_para(todas(), "task", Some("groq/llama-3.3-70b"));
    assert_eq!(
        solo.iter().map(|(p, _)| p.id).collect::<Vec<_>>(),
        vec!["groq"]
    );
    assert!(
        entorno::claves_para(todas(), "task", Some("zen/x")).is_empty(),
        "un proveedor sin key no recibe la de otro"
    );
    assert!(entorno::claves_para(todas(), "task", Some("sin-barra")).is_empty());
}

fn caducada_del_relevo(sid: &str) -> EngineTask {
    let mut t = caducada(sid);
    t.kind = "relay".into();
    t.engine = "opencode".into();
    t
}

fn no_lanza(_: TaskSpec, _: String, _: Option<String>) -> Result<EngineTask, String> {
    panic!("no se debe relanzar");
}

/// Codex #3: el reintento no sobrevive a la vuelta a Claude.
#[test]
fn el_reintento_no_se_lanza_si_el_relevo_ya_no_esta() {
    let t = caducada_del_relevo("s-oc-sin-relevo");
    relanzar_con(&t, "p".into(), "a".into(), no_lanza, anotar_fin);
    assert!(
        !finalizada("s-oc-sin-relevo"),
        "no hay relevo al que avisar"
    );
}

/// Codex #3: ni deshace un cambio de motor (el relevo ya está en Gemini).
#[test]
fn el_reintento_no_se_lanza_si_el_relevo_cambio_de_motor() {
    let sid = "s-oc-cambio";
    crate::sesiones::relevo::insert_for_test(sid, "gemini", "traspaso");
    let t = caducada_del_relevo(sid);
    relanzar_con(&t, "p".into(), "a".into(), no_lanza, anotar_fin);
    let estado = crate::sesiones::relevo::get(sid).expect("estado");
    assert_eq!(estado.active_engine, "gemini");
    assert!(estado.task_ids.is_empty());
}

/// Codex #3: el relevo cambia mientras se lanza: la tarea nueva no se adopta.
#[test]
fn el_reintento_que_termina_tras_un_cambio_no_se_adopta() {
    let sid = "s-oc-carrera";
    crate::sesiones::relevo::insert_for_test(sid, "opencode", "traspaso");
    let t = caducada_del_relevo(sid);
    let lanza = |_: TaskSpec, _: String, _: Option<String>| {
        crate::sesiones::relevo::claim_for_test(sid, "opencode", "gemini");
        let mut n = tarea(sid);
        n.id = "t-carrera".into();
        n.kind = "relay".into();
        Ok(n)
    };
    relanzar_con(&t, "p".into(), "a".into(), lanza, anotar_fin);
    let estado = crate::sesiones::relevo::get(sid).expect("estado");
    assert_eq!(estado.active_engine, "gemini", "no deshace el cambio");
    assert!(estado.task_ids.is_empty(), "{:?}", estado.task_ids);
}

/// Caso negativo: con el relevo vigente, la tarea relanzada sí entra.
#[test]
fn el_reintento_con_el_relevo_vigente_se_adopta() {
    let sid = "s-oc-vigente";
    crate::sesiones::relevo::insert_for_test(sid, "opencode", "traspaso");
    let t = caducada_del_relevo(sid);
    let lanza = |_: TaskSpec, _: String, _: Option<String>| {
        let mut n = tarea(sid);
        n.id = "t-vigente".into();
        n.kind = "relay".into();
        Ok(n)
    };
    relanzar_con(&t, "p".into(), "a".into(), lanza, anotar_fin);
    let estado = crate::sesiones::relevo::get(sid).expect("estado");
    assert_eq!(estado.task_ids, vec!["t-vigente".to_string()]);
    assert!(!finalizada(sid), "el turno sigue en la tarea relanzada");
}

/// Codex #7: si el lanzamiento falla, el turno no se pierde: va a `fin` con el
/// motivo, que es lo que hace escalar al relevo.
#[test]
fn un_fallo_al_relanzar_avisa_a_fin_con_el_motivo() {
    let sid = "s-oc-fallo-lanzar";
    crate::sesiones::relevo::insert_for_test(sid, "opencode", "traspaso");
    let t = caducada_del_relevo(sid);
    let lanza = |_: TaskSpec, _: String, _: Option<String>| Err("sin binario".to_string());
    relanzar_con(&t, "p".into(), "a".into(), lanza, anotar_fin);
    assert!(
        finalizada(sid),
        "el relevo tiene que enterarse para escalar"
    );
}

/// Codex #7: una tarea que no es del relevo tampoco queda sin aviso.
#[test]
fn un_fallo_al_relanzar_una_tarea_normal_avisa_a_fin() {
    let sid = "s-oc-fallo-normal";
    let t = caducada(sid);
    let lanza = |_: TaskSpec, _: String, _: Option<String>| Err("sin binario".to_string());
    relanzar_con(&t, "p".into(), "a".into(), lanza, anotar_fin);
    assert!(finalizada(sid));
}

#[test]
fn las_tareas_de_motores_no_heredan_secretos() {
    use crate::sesiones::motores::{es_variable_secreta, quitar_secretos};
    for k in [
        "ULTRON_KEY_ANTHROPIC_CREDITS",
        "OPENAI_API_KEY",
        "GITHUB_TOKEN",
        "MI_PAT",
        "DB_PASSWORD_X",
        "X_SECRET_KEY",
        "AWS_REGION",
        "OPENALEX_MAILTO",
    ] {
        assert!(es_variable_secreta(k), "{k}");
    }
    for k in ["PATH", "USERPROFILE", "CODEX_HOME", "PATHEXT", "TEMP"] {
        assert!(!es_variable_secreta(k), "{k}");
    }
    let mut cmd = std::process::Command::new("x");
    let nombres = ["PATH", "OPENAI_API_KEY", "ULTRON_KEY_X"].map(String::from);
    quitar_secretos(&mut cmd, nombres.into_iter());
    let quitadas: Vec<_> = cmd
        .get_envs()
        .filter(|(_, v)| v.is_none())
        .map(|(k, _)| k.to_string_lossy().into_owned())
        .collect();
    assert_eq!(quitadas, vec!["OPENAI_API_KEY", "ULTRON_KEY_X"]);
}
