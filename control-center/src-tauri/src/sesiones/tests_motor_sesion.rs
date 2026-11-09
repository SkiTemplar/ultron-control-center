// sesiones/tests_motor_sesion.rs — Tests de las sesiones nativas de Codex,
// Gemini y OpenCode: alta, envío (y su caso negativo con un turno en curso), cierre,
// sesiones pasadas, contexto de Gemini, hilo de Codex y modelo del envío
// (persistencia y topes en `tests_motor_sesion_guardado.rs`).
// Herméticos: sin procesos de motor (lanzador inyectado) ni cockpit real.

use std::sync::Mutex;

use super::*;
use crate::sesiones::intervencion::CONTEXT_BUDGET;
use crate::sesiones::motor::TaskSpec;

/// Sesión nueva en un directorio temporal (se conserva con la sesión).
fn nueva(engine: &'static str) -> (SessionInfo, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let cwd = dir.path().to_string_lossy().into_owned();
    let info = crear_en(engine, None, cwd, None).expect("alta");
    (info, dir)
}

/// Lanzador sin proceso que anota el prompt completo que recibiría el motor.
fn lanzador(
    prompts: &Mutex<Vec<String>>,
) -> impl Fn(TaskSpec, String, &[String], Option<&str>) -> Result<EngineTask, String> + '_ {
    move |spec, full, _imgs, _proyecto| {
        prompts.lock().expect("prompts").push(full);
        motor::lanzar_para_prueba(spec)
    }
}

fn enviar(id: &str, texto: &str, prompts: &Mutex<Vec<String>>) -> Result<EngineTask, String> {
    let msg = Mensaje {
        text: texto,
        ..Mensaje::default()
    };
    send_con(id, &msg, &lanzador(prompts))
}

fn hola() -> Mensaje<'static> {
    Mensaje {
        text: "hola",
        ..Mensaje::default()
    }
}

fn estado(id: &str) -> SessionStatus {
    get(id).expect("sesión").info().status
}

fn tarea(id: &str, sesion: &str, inicio: &str, status: &str) -> EngineTask {
    let mut t = motor::nueva_para_prueba(TaskSpec {
        engine: "gemini",
        kind: motor::KIND_CHAT.into(),
        mode: "local".into(),
        cwd: ".".into(),
        prompt: format!("p-{id}"),
        session_id: Some(sesion.into()),
        context_chars: 0,
        model: None,
        group: None,
    });
    t.id = id.into();
    t.started_at = inicio.into();
    t.status = status.into();
    t.summary = Some(format!("r-{id}"));
    t
}

#[test]
fn el_alta_es_de_motor_sin_claude_y_se_valida_el_motor() {
    let (info, _dir) = nueva("codex");
    assert_eq!(info.engine.as_deref(), Some("codex"));
    assert_eq!(info.status, SessionStatus::Idle);
    assert!(info.claude_session_id.is_none() && !info.bridge_connected);
    assert!(info.title.starts_with("Codex · "), "título: {}", info.title);
    assert!(existe(&info.id));
    assert!(infos().iter().any(|i| i.id == info.id));
    let v = serde_json::to_value(&info).expect("json");
    assert_eq!(v["engine"], "codex");
    let claude = SessionInfo::nueva("c", "/p", PermissionMode::Default);
    let v = serde_json::to_value(&claude).expect("json");
    assert!(v.get("engine").is_none(), "solo viaja en las de motor");
    let mal = create(CreateEngineRequest {
        engine: "ollama".into(),
        ..CreateEngineRequest::default()
    });
    assert!(mal.is_err_and(|e| e.contains("motor no válido")));
}

#[test]
fn enviar_con_un_turno_en_curso_falla_y_al_terminar_vuelve_a_idle() {
    let (info, _dir) = nueva("gemini");
    let prompts = Mutex::new(Vec::new());
    let t = enviar(&info.id, "  arregla el login  ", &prompts).expect("turno");
    assert_eq!(
        (t.kind.as_str(), t.prompt.as_str()),
        ("chat", "arregla el login")
    );
    assert_eq!(t.session_id.as_deref(), Some(info.id.as_str()));
    assert_eq!(estado(&info.id), SessionStatus::Working);
    assert!(get(&info.id).expect("s").working_since.is_some());
    assert_eq!(get(&info.id).expect("s").title, "arregla el login");
    let otra = enviar(&info.id, "otra cosa", &prompts);
    assert_eq!(otra.err().as_deref(), Some("la sesión ya está trabajando"));
    assert_eq!(
        prompts.lock().expect("p").len(),
        1,
        "no se lanzó otro proceso"
    );
    motor::terminar_para_prueba(&t.id, "done", "hecho", None);
    assert_eq!(estado(&info.id), SessionStatus::Idle);
    assert!(get(&info.id).expect("s").working_since.is_none());
    assert!(enviar(&info.id, "   ", &prompts).is_err_and(|e| e.contains("vacío")));
}

#[test]
fn un_lanzamiento_fallido_deja_la_sesion_libre() {
    let (info, _dir) = nueva("codex");
    let falla =
        |_: TaskSpec, _: String, _: &[String], _: Option<&str>| -> Result<EngineTask, String> {
            Err("no se pudo lanzar codex".into())
        };
    assert!(send_con(&info.id, &hola(), &falla).is_err());
    assert_eq!(estado(&info.id), SessionStatus::Idle);
    assert!(send_con("no-existe", &hola(), &falla).is_err_and(|e| e.contains("no existe")));
}

#[test]
fn gemini_recibe_los_turnos_previos_y_el_prompt_queda_limpio() {
    let (info, _dir) = nueva("gemini");
    let prompts = Mutex::new(Vec::new());
    let t1 = enviar(&info.id, "primera pregunta", &prompts).expect("t1");
    assert_eq!(t1.context_chars, 0, "sin turnos previos no hay contexto");
    motor::terminar_para_prueba(&t1.id, "done", "primera respuesta", None);
    let t2 = enviar(&info.id, "segunda pregunta", &prompts).expect("t2");
    let full = prompts.lock().expect("p")[1].clone();
    assert!(full.contains("### Usuario\nprimera pregunta"));
    assert!(full.contains("### Gemini\nprimera respuesta"));
    assert!(full.ends_with("segunda pregunta"));
    assert_eq!(t2.prompt, "segunda pregunta");
    assert!(t2.context_chars > 0);
    motor::cancel(&t2.id).expect("cancelar");
    assert_eq!(
        estado(&info.id),
        SessionStatus::Idle,
        "cancelar cierra el turno"
    );
}

#[test]
fn el_contexto_de_gemini_se_recorta_conservando_lo_reciente() {
    let previos: Vec<EngineTask> = (0..60)
        .map(|i| {
            let mut t = tarea(
                &format!("ctx-{i}"),
                "s-ctx",
                &format!("2026-11-04T10:{i:02}:00Z"),
                "done",
            );
            t.prompt = format!("pregunta {i}");
            t.summary = Some(format!("{i}:{}", "x".repeat(1_000)));
            t
        })
        .collect();
    let c = contexto_gemini(&previos).expect("contexto");
    assert!(c.chars().count() <= CONTEXT_BUDGET);
    assert!(c.contains("pregunta 59") && c.contains("59:"));
    assert!(!c.contains("pregunta 0\n"), "el más antiguo no cabe");
    assert!(contexto_gemini(&[]).is_none());
}

#[test]
fn codex_reutiliza_su_hilo_tambien_al_reabrir() {
    let (info, _dir) = nueva("codex");
    let prompts = Mutex::new(Vec::new());
    let t = enviar(&info.id, "haz X", &prompts).expect("turno");
    motor::terminar_para_prueba(&t.id, "done", "hecho", Some("th-sesion"));
    assert_eq!(
        get(&info.id).expect("s").thread_id.as_deref(),
        Some("th-sesion")
    );
    assert_eq!(codex::hilo_de(&info.id).as_deref(), Some("th-sesion"));
    let a = codex::local_args(
        &info.cwd,
        "chat",
        codex::hilo_de(&info.id).as_deref(),
        &codex::ModelChoice {
            model: None,
            effort: None,
        },
        &[],
    );
    assert_eq!(&a[..2], ["exec", "resume"]);
    assert!(a.contains(&"sandbox_mode=\"workspace-write\"".to_string()));
    kill(&info.id).expect("cerrar");
    assert_eq!(codex::hilo_de(&info.id), None, "cerrada no retiene el hilo");
    let req = CreateEngineRequest {
        engine: "codex".into(),
        resume: Some(info.id.clone()),
        ..CreateEngineRequest::default()
    };
    let r = create(req).expect("reabrir");
    assert_eq!(r.id, info.id);
    assert_eq!(codex::hilo_de(&info.id).as_deref(), Some("th-sesion"));
    assert_eq!(
        motor::turnos_de_sesion(&info.id).len(),
        1,
        "vuelven sus turnos"
    );
}

#[test]
fn cerrar_cancela_el_turno_y_la_pasa_a_past() {
    let (info, _dir) = nueva("gemini");
    let prompts = Mutex::new(Vec::new());
    let t = enviar(&info.id, "tarea larga", &prompts).expect("turno");
    gestor::rename(&info.id, "Renombrada").expect("renombrar desvía al motor");
    assert_eq!(get(&info.id).expect("s").title, "Renombrada");
    gestor::kill(&info.id).expect("kill desvía al motor");
    assert!(!existe(&info.id) && !infos().iter().any(|i| i.id == info.id));
    assert!(
        motor::turnos_de_sesion(&info.id).is_empty(),
        "fuera del registro"
    );
    let s = get(&info.id).expect("cerrada");
    assert_eq!(s.turns.len(), 1);
    assert_eq!(s.turns[0].id, t.id);
    assert_eq!(s.turns[0].status, "cancelled");
    let p = past(Some(MAX_SESIONES));
    let mia = p.iter().find(|x| x.id == info.id).expect("en past");
    assert_eq!((mia.engine.as_str(), mia.turns), ("gemini", 1));
    assert!(gestor::kill(&info.id).is_err(), "ya no es una sesión viva");
    assert!(rename(&info.id, "x").is_err(), "cerrada no se renombra");
}

#[test]
fn reabrir_exige_una_cerrada_del_mismo_motor() {
    let (info, _dir) = nueva("gemini");
    let req = |engine: &str| CreateEngineRequest {
        engine: engine.into(),
        resume: Some(info.id.clone()),
        ..CreateEngineRequest::default()
    };
    assert!(create(req("gemini")).is_err_and(|e| e.contains("ya está abierta")));
    kill(&info.id).expect("cerrar");
    assert!(create(req("codex")).is_err_and(|e| e.contains("es de Gemini")));
    let r = create(req("gemini")).expect("reabrir");
    assert_eq!(
        (r.id.as_str(), r.status),
        (info.id.as_str(), SessionStatus::Idle)
    );
    assert!(existe(&info.id));
}

#[test]
fn el_modelo_del_envio_se_usa_y_queda_en_la_sesion() {
    let (info, _dir) = nueva("codex");
    let prompts = Mutex::new(Vec::new());
    let msg = Mensaje {
        text: "con otro modelo",
        model: Some("gpt-5.6-terra"),
        ..Mensaje::default()
    };
    let t = send_con(&info.id, &msg, &lanzador(&prompts)).expect("turno");
    assert_eq!(t.model.as_deref(), Some("gpt-5.6-terra"));
    assert_eq!(
        get(&info.id).expect("s").model.as_deref(),
        Some("gpt-5.6-terra")
    );
    assert!(infos()
        .iter()
        .any(|i| i.id == info.id && i.model.as_deref() == Some("gpt-5.6-terra")));
    motor::terminar_para_prueba(&t.id, "done", "hecho", None);
    let sin = enviar(&info.id, "sin modelo", &prompts).expect("turno 2");
    assert_eq!(
        sin.model.as_deref(),
        Some("gpt-5.6-terra"),
        "sigue el de la sesión"
    );
    motor::terminar_para_prueba(&sin.id, "done", "hecho", None);
    let malo = Mensaje {
        text: "x",
        model: Some("x --sandbox"),
        ..Mensaje::default()
    };
    assert!(send_con(&info.id, &malo, &lanzador(&prompts)).is_err());
    assert_eq!(
        estado(&info.id),
        SessionStatus::Idle,
        "un modelo inválido no reserva"
    );
    assert_eq!(
        get(&info.id).expect("s").model.as_deref(),
        Some("gpt-5.6-terra")
    );
}

#[test]
fn opencode_es_sesion_con_prompt_limpio_y_retoma_su_sesion_al_reabrir() {
    let (info, _dir) = nueva("opencode");
    assert_eq!(info.engine.as_deref(), Some("opencode"));
    assert!(
        info.title.starts_with("OpenCode · "),
        "título: {}",
        info.title
    );
    let prompts = Mutex::new(Vec::new());
    let t = enviar(&info.id, "primero", &prompts).expect("turno 1");
    motor::terminar_para_prueba(&t.id, "done", "uno", Some("ses_abc123"));
    assert_eq!(
        get(&info.id).expect("s").thread_id.as_deref(),
        Some("ses_abc123")
    );
    assert_eq!(
        opencode::sesion_recordada(Some(&info.id)).as_deref(),
        Some("ses_abc123")
    );
    let t = enviar(&info.id, "segundo", &prompts).expect("turno 2");
    motor::terminar_para_prueba(&t.id, "done", "dos", Some("ses_abc123"));
    let enviados = prompts.lock().expect("prompts").clone();
    assert_eq!(
        enviados[1], "segundo",
        "OpenCode retoma su sesión: no se le reenvían los turnos previos"
    );
    kill(&info.id).expect("cerrar");
    assert_eq!(
        opencode::sesion_recordada(Some(&info.id)),
        None,
        "cerrada no retiene la sesión de OpenCode"
    );
    let req = CreateEngineRequest {
        engine: "opencode".into(),
        resume: Some(info.id.clone()),
        ..CreateEngineRequest::default()
    };
    create(req).expect("reabrir");
    assert_eq!(
        opencode::sesion_recordada(Some(&info.id)).as_deref(),
        Some("ses_abc123")
    );
}

#[test]
fn opencode_no_siembra_un_hilo_que_no_es_una_sesion_valida() {
    let (info, _dir) = nueva("opencode");
    sembrar_hilo("opencode", &info.id, "--model=x");
    assert_eq!(opencode::sesion_recordada(Some(&info.id)), None);
    sembrar_hilo("opencode", &info.id, "ses_ok1");
    assert_eq!(
        opencode::sesion_recordada(Some(&info.id)).as_deref(),
        Some("ses_ok1")
    );
}

#[test]
fn el_turno_relanzado_de_opencode_mantiene_la_sesion_trabajando() {
    let (info, _dir) = nueva("opencode");
    let prompts = Mutex::new(Vec::new());
    let t1 = enviar(&info.id, "haz X", &prompts).expect("turno");
    motor::terminar_para_prueba(&t1.id, "error", "", None);
    assert_eq!(estado(&info.id), SessionStatus::Idle);
    let spec = || TaskSpec {
        engine: "opencode",
        kind: motor::KIND_CHAT.into(),
        mode: "local".into(),
        cwd: info.cwd.clone(),
        prompt: "haz X".into(),
        session_id: Some(info.id.clone()),
        context_chars: 0,
        model: None,
        group: None,
    };
    let t2 = motor::lanzar_para_prueba(spec()).expect("relanzada");
    adoptar_relanzado(&t2);
    assert_eq!(estado(&info.id), SessionStatus::Working);
    motor::terminar_para_prueba(&t2.id, "done", "hecho", Some("ses_nueva1"));
    assert_eq!(estado(&info.id), SessionStatus::Idle);
    // Caso negativo: con la sesión cerrada, el relanzamiento no la reabre.
    kill(&info.id).expect("cerrar");
    let t3 = motor::lanzar_para_prueba(spec()).expect("otra");
    adoptar_relanzado(&t3);
    assert!(!get(&info.id).expect("s").open);
    assert!(get(&info.id).expect("s").turno == Turno::Libre);
}

#[test]
fn ajustes_de_una_sesion_de_motor_no_pasan_por_el_registro_de_claude() {
    let info =
        super::crear_en("codex", None, "C:/tmp/ajustes".into(), Some("gpt-x".into())).unwrap();
    let a = super::ajustes(&info.id).expect("ajustes de la sesión de motor");
    assert_eq!(a.model.as_deref(), Some("gpt-x"));
    assert!(super::super::ajustes::settings(&info.id).is_ok());
    super::kill(&info.id).unwrap();
    assert!(
        super::ajustes(&info.id).is_none(),
        "cerrada: ya no es una sesión de motor abierta"
    );
    assert!(super::ajustes("no-existe").is_none());
}
