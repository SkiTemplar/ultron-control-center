// sesiones/tests_motor.rs — Tests del registro de tareas de motores: traer a
// Claude una sola vez, tope del texto traído, persistencia de `brought_at` y
// cancelación con el árbol de procesos.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Barrier;
use std::time::{Duration, Instant};

use super::*;
use crate::sesiones::intervencion::{bring_text, traer_en, BRING_MAX_CHARS};

fn terminada(id: &str, summary: &str) -> EngineTask {
    let mut t = new_task(TaskSpec {
        engine: "codex",
        kind: "task".into(),
        mode: "local".into(),
        cwd: ".".into(),
        prompt: "revisa el módulo".into(),
        session_id: Some("s1".into()),
        context_chars: 0,
        model: None,
        group: None,
    });
    t.id = id.to_string();
    t.status = "done".into();
    t.summary = Some(summary.to_string());
    t
}

#[test]
fn dos_traidas_concurrentes_envian_una_sola_vez() {
    insertar_para_prueba(terminada("traer-concurrente", "hecho"));
    let envios = AtomicUsize::new(0);
    let barrera = Barrier::new(2);
    let send = |_: &str, _: &str| {
        envios.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(50));
        Ok(())
    };
    let resultados: Vec<Result<(), String>> = std::thread::scope(|s| {
        let hilos: Vec<_> = (0..2)
            .map(|_| {
                s.spawn(|| {
                    barrera.wait();
                    traer_en("traer-concurrente", "s1", None, &send)
                })
            })
            .collect();
        hilos.into_iter().map(|h| h.join().expect("hilo")).collect()
    });
    assert_eq!(
        envios.load(Ordering::SeqCst),
        1,
        "un solo envío a la sesión"
    );
    assert_eq!(resultados.iter().filter(|r| r.is_ok()).count(), 1);
    let err = resultados
        .into_iter()
        .find_map(Result::err)
        .expect("uno falla");
    assert!(err.contains("ya se trajo"), "{err}");
    assert!(get("traer-concurrente")
        .expect("tarea")
        .brought_at
        .is_some());
}

#[test]
fn si_el_envio_falla_la_tarea_se_puede_volver_a_traer() {
    insertar_para_prueba(terminada("traer-falla", "hecho"));
    let falla = |_: &str, _: &str| Err("la sesión terminó".to_string());
    assert_eq!(
        traer_en("traer-falla", "s1", None, &falla),
        Err("la sesión terminó".to_string())
    );
    assert!(get("traer-falla").expect("tarea").brought_at.is_none());
    let ok = |_: &str, _: &str| Ok(());
    assert!(traer_en("traer-falla", "s1", None, &ok).is_ok());
}

#[test]
fn una_tarea_en_curso_no_se_trae() {
    let mut t = terminada("traer-en-curso", "parcial");
    t.status = "running".into();
    insertar_para_prueba(t);
    let ok = |_: &str, _: &str| Ok(());
    let err = traer_en("traer-en-curso", "s1", None, &ok).expect_err("en curso");
    assert!(err.contains("sigue en curso"), "{err}");
}

#[test]
fn un_resultado_enorme_se_recorta_y_el_resto_va_a_fichero() {
    let dir = tempfile::tempdir().expect("tempdir");
    let grande = format!("INICIO{}FINAL", "x".repeat(100_000));
    let t = terminada("abcdef0123", &grande);
    let text = bring_text(&t, Some(dir.path())).expect("texto");
    assert!(text.chars().count() <= BRING_MAX_CHARS, "{}", text.len());
    assert!(text.starts_with("Resultado de Codex"));
    assert!(text.contains("INICIO") && !text.contains("FINAL"));
    let fichero = dir.path().join("motor-codex-abcdef01.md");
    assert!(
        text.contains(&fichero.display().to_string()),
        "cita la ruta"
    );
    assert!(
        !text.contains("@\""),
        "sin mención @: no se inyecta el fichero"
    );
    assert_eq!(std::fs::read_to_string(fichero).expect("fichero"), grande);
}

#[test]
fn un_resultado_corto_va_entero_y_sin_fichero() {
    let t = terminada("corto", "todo bien");
    let text = bring_text(&t, None).expect("texto");
    assert_eq!(text, "Resultado de Codex (revisa el módulo):\ntodo bien");
}

#[test]
fn brought_at_se_conserva_al_recargar_desde_disco() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("sesiones").join("motores.json");
    let mut traida = terminada("persistida", "hecho");
    traida.brought_at = Some("2026-10-08T10:00:00.000Z".into());
    let mut viva = terminada("viva", "a medias");
    viva.status = "running".into();
    guardar_en(&path, &[traida, viva]).expect("guardar");
    let cargadas = cargar_de(&path);
    assert_eq!(cargadas.len(), 1, "solo se guardan las terminadas");
    assert_eq!(
        cargadas[0].brought_at.as_deref(),
        Some("2026-10-08T10:00:00.000Z")
    );
}

#[test]
fn una_tarea_guardada_en_curso_se_carga_con_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("motores.json");
    let mut t = terminada("huerfana", "");
    t.status = "running".into();
    std::fs::write(&path, serde_json::to_string(&[t]).expect("json")).expect("write");
    let cargadas = cargar_de(&path);
    assert_eq!(cargadas[0].status, "error");
    assert!(cargadas[0]
        .events
        .iter()
        .any(|e| e.text.contains("se cerró")));
    assert!(cargar_de(&dir.path().join("no-existe.json")).is_empty());
}

#[cfg(windows)]
#[test]
fn la_tarea_termina_aunque_un_nieto_retenga_la_salida() {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new("cmd");
    cmd.arg("/C")
        .raw_arg("start /b ping -n 20 127.0.0.1 & echo hola");
    let spec = TaskSpec {
        engine: "codex",
        kind: "task".into(),
        mode: "local".into(),
        cwd: ".".into(),
        prompt: "nieto".into(),
        // Con sesión propia: `limpiar` de otros tests borra las que no
        // tienen y, si esta terminara en mitad de uno, la contaría y la
        // borraría (el `get` de abajo fallaría).
        session_id: Some("s-spawn".into()),
        context_chars: 0,
        model: None,
        group: None,
    };
    let launch = Launch {
        cmd,
        stdin: None,
        parser: Box::new(|_| LineOutcome::default()),
        on_done: None,
        vigia_stderr: None,
    };
    let task = spawn(spec, launch).expect("spawn");
    let inicio = Instant::now();
    while get(&task.id).expect("tarea").status == "running"
        && inicio.elapsed() < Duration::from_secs(15)
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(get(&task.id).expect("tarea").status, "done");
    assert!(
        inicio.elapsed() < Duration::from_secs(8),
        "la tarea siguió «running» con el hijo ya muerto: {:?}",
        inicio.elapsed()
    );
}

#[cfg(windows)]
#[test]
fn cancelar_mata_el_arbol_de_procesos_del_motor() {
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "ping -n 30 127.0.0.1 >NUL"]);
    let spec = TaskSpec {
        engine: "codex",
        kind: "task".into(),
        mode: "local".into(),
        cwd: ".".into(),
        prompt: "larga".into(),
        // Con sesión propia (ver `la_tarea_termina_aunque_un_nieto_...`).
        session_id: Some("s-spawn".into()),
        context_chars: 0,
        model: None,
        group: None,
    };
    let launch = Launch {
        cmd,
        stdin: None,
        parser: Box::new(|_| LineOutcome::default()),
        on_done: None,
        vigia_stderr: None,
    };
    let task = spawn(spec, launch).expect("spawn");
    let job = trabajo_de(&task.id).expect("job");
    let inicio = Instant::now();
    while job.procesos_activos() < Some(2) && inicio.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(job.procesos_activos(), Some(2), "cmd y su nieto ping");
    cancel(&task.id).expect("cancel");
    while job.procesos_activos() != Some(0) && inicio.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(job.procesos_activos(), Some(0), "no queda ningún proceso");
    assert_eq!(get(&task.id).expect("tarea").status, "cancelled");
    assert!(
        cancel(&task.id).is_err(),
        "una tarea terminada no se vuelve a matar"
    );
}

fn de_sesion(id: &str, sesion: &str, engine: &'static str, grupo: Option<&str>) -> EngineTask {
    let mut t = terminada(id, &format!("respuesta de {engine}"));
    t.engine = engine.into();
    t.session_id = Some(sesion.into());
    t.group = grupo.map(str::to_string);
    t
}

/// Limpiar borra las terminadas de esa sesión; las de otra sesión y las que
/// siguen en curso se quedan (caso negativo).
#[test]
fn limpiar_borra_solo_las_terminadas_de_la_sesion() {
    insertar_para_prueba(de_sesion("limpiar-a", "s-limpiar", "codex", None));
    let mut viva = de_sesion("limpiar-b", "s-limpiar", "codex", None);
    viva.status = "running".into();
    insertar_para_prueba(viva);
    insertar_para_prueba(de_sesion("limpiar-c", "s-otra-limpiar", "gemini", None));
    assert_eq!(limpiar("s-limpiar"), Ok(1));
    assert!(get("limpiar-a").is_err());
    assert!(get("limpiar-b").is_ok(), "la que está en curso se queda");
    assert!(get("limpiar-c").is_ok(), "la de otra sesión se queda");
}

/// Tribunal: un solo envío con las dos respuestas y la petición de
/// contrastarlas; las dos quedan traídas.
#[test]
fn el_tribunal_envia_las_dos_respuestas_para_contrastar() {
    insertar_para_prueba(de_sesion("trib-c", "s-trib", "codex", Some("g-trib")));
    insertar_para_prueba(de_sesion("trib-g", "s-trib", "gemini", Some("g-trib")));
    let enviado = std::sync::Mutex::new(Vec::<String>::new());
    let send = |_: &str, t: &str| {
        enviado.lock().expect("envío").push(t.to_string());
        Ok(())
    };
    crate::sesiones::intervencion::contrastar_en("g-trib", "s-trib", None, &send)
        .expect("contrastar");
    let textos = enviado.lock().expect("envío").clone();
    assert_eq!(textos.len(), 1, "un solo mensaje");
    let t = &textos[0];
    assert!(t.starts_with("Contrasta"), "{t}");
    assert!(t.contains("<codex>") && t.contains("respuesta de codex"));
    assert!(t.contains("<gemini>") && t.contains("respuesta de gemini"));
    assert!(get("trib-c").expect("c").brought_at.is_some());
    assert!(get("trib-g").expect("g").brought_at.is_some());
}

/// Caso negativo: con una respuesta en curso no se envía nada y la otra no
/// queda marcada como traída.
#[test]
fn el_tribunal_con_una_tarea_en_curso_no_envia_ni_reserva() {
    insertar_para_prueba(de_sesion("trib2-c", "s-trib2", "codex", Some("g-trib2")));
    let mut viva = de_sesion("trib2-g", "s-trib2", "gemini", Some("g-trib2"));
    viva.status = "running".into();
    insertar_para_prueba(viva);
    let send = |_: &str, _: &str| -> Result<(), String> { panic!("no debe enviarse") };
    assert!(
        crate::sesiones::intervencion::contrastar_en("g-trib2", "s-trib2", None, &send).is_err()
    );
    assert!(get("trib2-c").expect("c").brought_at.is_none());
}

#[test]
fn el_ineligible_de_gemini_se_explica() {
    let mut t = de_sesion("causa-g", "s-causa", "gemini", None);
    t.events
        .push(evt("error", "throwIneligibleOrProjectIdError".into()).expect("evt"));
    assert!(causa_conocida(&t).is_some_and(|c| c.contains("agy")));
    t.engine = "codex".into();
    assert_eq!(causa_conocida(&t), None, "solo aplica a Gemini");
}

fn spec_de(kind: &str, prompt: &str) -> TaskSpec {
    TaskSpec {
        engine: "codex",
        kind: kind.into(),
        mode: "local".into(),
        cwd: ".".into(),
        prompt: prompt.into(),
        // Con sesión propia: `limpiar` de otros tests borra las que no tienen.
        session_id: Some("s-spawn".into()),
        context_chars: 0,
        model: None,
        group: None,
    }
}

fn esperar_fin(id: &str, max: Duration) -> EngineTask {
    let inicio = Instant::now();
    while get(id).expect("tarea").status == "running" && inicio.elapsed() < max {
        std::thread::sleep(Duration::from_millis(50));
    }
    get(id).expect("tarea")
}

/// H1: la misma clave (el turno) lanza un solo proceso aunque la pidan dos
/// ventanas a la vez; las dos reciben la misma tarea. Otra clave sí lanza.
#[test]
fn la_misma_clave_lanza_una_sola_vez() {
    use crate::sesiones::intervencion::con_clave;
    let lanzadas = AtomicUsize::new(0);
    let barrera = Barrier::new(2);
    let lanzar = || {
        let n = lanzadas.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(50));
        let t = terminada(&format!("clave-tarea-{n}"), "hecho");
        insertar_para_prueba(t.clone());
        Ok(t)
    };
    let ids: Vec<String> = std::thread::scope(|s| {
        let hilos: Vec<_> = (0..2)
            .map(|_| {
                s.spawn(|| {
                    barrera.wait();
                    con_clave(Some("s1:review:turno-1"), lanzar)
                        .expect("tarea")
                        .id
                })
            })
            .collect();
        hilos.into_iter().map(|h| h.join().expect("hilo")).collect()
    });
    assert_eq!(
        lanzadas.load(Ordering::SeqCst),
        1,
        "un solo proceso por turno"
    );
    assert_eq!(ids[0], ids[1], "las dos ventanas ven la misma tarea");
    con_clave(Some("s1:review:turno-2"), lanzar).expect("otro turno");
    con_clave(None, lanzar).expect("sin clave");
    assert_eq!(
        lanzadas.load(Ordering::SeqCst),
        3,
        "otra clave o sin clave sí lanzan"
    );
}

/// M7: al vencer el plazo, la tarea pasa a `error` con la causa y su árbol
/// de procesos muere.
#[cfg(windows)]
#[test]
fn el_plazo_vencido_mata_la_tarea_con_error() {
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "ping -n 30 127.0.0.1 >NUL"]);
    let launch = Launch {
        cmd,
        stdin: None,
        parser: Box::new(|_| LineOutcome::default()),
        on_done: None,
        vigia_stderr: None,
    };
    let plazo = Duration::from_millis(400);
    let task = spawn_con_plazo(spec_de("review", "colgada"), launch, plazo).expect("spawn");
    let job = trabajo_de(&task.id).expect("job");
    let inicio = Instant::now();
    let fin = esperar_fin(&task.id, Duration::from_secs(10));
    assert_eq!(fin.status, "error", "la tarea colgada no sigue en curso");
    assert!(
        fin.events
            .iter()
            .any(|e| e.kind == "error" && e.text.contains("Plazo máximo")),
        "{:?}",
        fin.events
    );
    while job.procesos_activos() != Some(0) && inicio.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(job.procesos_activos(), Some(0), "no queda ningún proceso");
    assert!(cancel(&task.id).is_err(), "ya no está en curso");
}

#[test]
fn el_plazo_depende_del_tipo() {
    assert_eq!(plazo_de("review"), Duration::from_secs(15 * 60));
    assert_eq!(plazo_de("task"), Duration::from_secs(30 * 60));
    assert_eq!(plazo_de("opinion"), PLAZO_TAREA);
}

/// M8 de punta a punta: un reintento de Codex seguido de `turn.completed` y
/// salida 0 deja la tarea en `done`.
#[cfg(windows)]
#[test]
fn un_reintento_de_codex_no_marca_la_tarea_como_fallida() {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new("cmd");
    cmd.arg("/C").raw_arg(
        r#"echo {"type":"error","message":"Reconnecting... 1/5"}& echo {"type":"turn.completed"}"#,
    );
    let launch = Launch {
        cmd,
        stdin: None,
        parser: Box::new(|l: &str| crate::sesiones::codex_parse::parse_exec_line(l)),
        on_done: None,
        vigia_stderr: None,
    };
    let task = spawn(spec_de("review", "reintento"), launch).expect("spawn");
    let fin = esperar_fin(&task.id, Duration::from_secs(10));
    assert_eq!(fin.status, "done", "{:?}", fin.events);
    assert!(fin
        .events
        .iter()
        .any(|e| e.kind == "warning" && e.text.contains("Reconnecting")));
}

/// M6: si `bring_text` falla tras reservar, no queda ninguna tarea reservada.
#[test]
fn el_tribunal_libera_la_reserva_si_el_texto_falla() {
    insertar_para_prueba(de_sesion("trib3-c", "s-trib3", "codex", Some("g-trib3")));
    let mut g = de_sesion("trib3-g", "s-trib3", "gemini", Some("g-trib3"));
    g.summary = Some("x".repeat(BRING_MAX_CHARS + 10));
    insertar_para_prueba(g);
    let send = |_: &str, _: &str| -> Result<(), String> { panic!("no debe enviarse") };
    let err = crate::sesiones::intervencion::contrastar_en("g-trib3", "s-trib3", None, &send)
        .expect_err("sin directorio para el resultado largo");
    assert!(err.contains("directorio"), "{err}");
    assert!(get("trib3-c").expect("c").brought_at.is_none());
    assert!(
        get("trib3-g").expect("g").brought_at.is_none(),
        "la que falló queda libre"
    );
}

/// L6: una respuesta con error no se contrasta (mismo criterio que el
/// frontend).
#[test]
fn el_tribunal_con_una_respuesta_fallida_no_se_contrasta() {
    insertar_para_prueba(de_sesion("trib4-c", "s-trib4", "codex", Some("g-trib4")));
    let mut g = de_sesion("trib4-g", "s-trib4", "gemini", Some("g-trib4"));
    g.status = "error".into();
    insertar_para_prueba(g);
    let send = |_: &str, _: &str| -> Result<(), String> { panic!("no debe enviarse") };
    let err = crate::sesiones::intervencion::contrastar_en("g-trib4", "s-trib4", None, &send)
        .expect_err("una respuesta con error");
    assert!(err.contains("no terminó bien"), "{err}");
    assert!(get("trib4-c").expect("c").brought_at.is_none());
}

/// L1: limpiar no parte un Tribunal con un miembro en curso.
#[test]
fn limpiar_respeta_un_tribunal_en_curso() {
    insertar_para_prueba(de_sesion(
        "limpiar-t1",
        "s-limpiar-t",
        "codex",
        Some("g-limpiar"),
    ));
    let mut viva = de_sesion("limpiar-t2", "s-limpiar-t", "gemini", Some("g-limpiar"));
    viva.status = "running".into();
    insertar_para_prueba(viva);
    insertar_para_prueba(de_sesion("limpiar-t3", "s-limpiar-t", "codex", None));
    assert_eq!(limpiar("s-limpiar-t"), Ok(1), "solo la suelta");
    assert!(
        get("limpiar-t1").is_ok(),
        "la respuesta terminada del tribunal se queda"
    );
    assert!(get("limpiar-t3").is_err());
}

/// L4: en memoria se conservan las en curso, los tribunales a medias y las
/// `max` terminadas más recientes.
#[test]
fn podar_conserva_las_recientes_y_las_en_curso() {
    let entrada = |t: EngineTask| {
        (
            t.id.clone(),
            Entry {
                task: t,
                child: None,
                trabajo: None,
            },
        )
    };
    let mut m: HashMap<String, Entry> = HashMap::new();
    for i in 0..5 {
        let mut t = terminada(&format!("podar-{i}"), "x");
        t.started_at = format!("2026-10-15T10:00:0{i}.000Z");
        m.extend([entrada(t)]);
    }
    let mut viva = terminada("podar-viva", "x");
    viva.status = "running".into();
    viva.started_at = "2026-10-15T09:00:00.000Z".into();
    viva.group = Some("g-podar".into());
    let mut socia = terminada("podar-socia", "x");
    socia.started_at = "2026-10-15T09:00:00.000Z".into();
    socia.group = Some("g-podar".into());
    m.extend([entrada(viva), entrada(socia)]);
    podar(&mut m, 2, &HashSet::new());
    let mut ids: Vec<&str> = m.keys().map(String::as_str).collect();
    ids.sort_unstable();
    assert_eq!(ids, ["podar-3", "podar-4", "podar-socia", "podar-viva"]);
}

/// Codex #10: la poda global no borra lo que un relevo vivo aún tiene que leer,
/// aunque sea lo más antiguo; sin esa marca, sí (caso negativo).
#[test]
fn podar_conserva_las_tareas_de_un_relevo_vivo() {
    let llena = || {
        (0..4)
            .map(|i| {
                let mut t = terminada(&format!("r-{i}"), "x");
                t.started_at = format!("2026-10-15T10:00:0{i}.000Z");
                let e = Entry {
                    task: t,
                    child: None,
                    trabajo: None,
                };
                (e.task.id.clone(), e)
            })
            .collect::<HashMap<String, Entry>>()
    };
    let mut m = llena();
    let del_relevo: HashSet<String> = ["r-0".to_string()].into();
    podar(&mut m, 1, &del_relevo);
    assert!(m.contains_key("r-0"), "la del relevo sigue");
    assert!(m.contains_key("r-3"), "la más reciente");
    assert_eq!(m.len(), 2);
    let mut m = llena();
    podar(&mut m, 1, &HashSet::new());
    assert!(!m.contains_key("r-0"), "sin relevo se poda");
}

/// `limpiar` tampoco se lleva lo que un relevo vivo aún tiene que traer.
#[test]
fn limpiar_conserva_las_tareas_de_un_relevo_vivo() {
    let sid = "s-limpiar-relevo";
    let con_sesion = |id: &str| {
        let mut t = terminada(id, "x");
        t.session_id = Some(sid.into());
        t
    };
    insertar_para_prueba(con_sesion("lr-relevo"));
    insertar_para_prueba(con_sesion("lr-otra"));
    let mut registrada = con_sesion("lr-relevo");
    registrada.kind = "relay".into();
    crate::sesiones::relevo::insert_for_test(sid, "codex", "t");
    crate::sesiones::relevo::track_task(&registrada);
    limpiar(sid).expect("limpiar");
    assert!(get("lr-relevo").is_ok(), "la del relevo sigue");
    assert!(get("lr-otra").is_err(), "la otra se borra");
}

/// Cerrar la sesión cancela sus tareas en curso y solo las suyas.
#[test]
fn cancelar_de_sesion_solo_toca_las_de_esa_sesion() {
    let viva = |id: &str, sid: &str| {
        let mut t = terminada(id, "x");
        t.status = "running".into();
        t.session_id = Some(sid.into());
        t
    };
    insertar_para_prueba(viva("cs-mia", "s-cierra"));
    insertar_para_prueba(viva("cs-ajena", "s-sigue"));
    cancelar_de_sesion("s-cierra");
    assert_eq!(get("cs-mia").expect("mia").status, "cancelled");
    assert_eq!(get("cs-ajena").expect("ajena").status, "running");
    cancel("cs-ajena").expect("limpieza");
}

/// Una línea que no es UTF-8 no corta la lectura ni suelta el pipe.
#[test]
fn una_linea_que_no_es_utf8_no_corta_la_lectura() {
    let bytes: &[u8] = b"uno\r\nmal\xFF\xFEo\ntres";
    let mut lineas = Vec::new();
    por_lineas(bytes, |l| lineas.push(l.to_string()));
    assert_eq!(lineas.len(), 3, "{lineas:?}");
    assert_eq!(lineas[0], "uno");
    assert!(lineas[1].starts_with("mal"));
    assert_eq!(lineas[2], "tres");
}
