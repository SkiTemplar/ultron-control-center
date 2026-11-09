// sesiones/tests_relevo_limite.rs — Pausa de la cola por el límite y caminos de
// entrada y vuelta del relevo (`observe`, `enter_relay`, `poll_return`,
// `return_to_claude`). Ningún motor se lanza: `run_relay` falla en los tests. Lo
// que la máquina hace con `LimiteUso` y `LimiteFin` está en
// `tests_maquina_pausas.rs`.

use std::time::{Duration as StdDuration, Instant};

use chrono::{Duration, Utc};
use serde_json::json;

use super::limite::{self, limite_vigente};
use super::*;
use crate::sesiones::types::{PlanUsage, QueueItemInput, QueueItemKind, UsageSource, UsageWindow};
use crate::sesiones::{cola, motor};

const AVISO: &str = "You've hit your session limit · resets 3:20pm";

fn id(nombre: &str) -> String {
    format!("{nombre}-{}", uuid::Uuid::new_v4())
}

fn aviso_con_hora(cuando: chrono::DateTime<Utc>) -> String {
    json!({
        "type": "assistant",
        "timestamp": cuando.to_rfc3339(),
        "message": { "model": "<synthetic>", "content": [{ "type": "text", "text": AVISO }] }
    })
    .to_string()
}

fn prompt(n: usize) -> String {
    json!({
        "type": "user", "uuid": format!("u{n}"), "timestamp": "t",
        "message": { "role": "user", "content": format!("peticion-{n}") }
    })
    .to_string()
}

fn usage_llena(resets_at: chrono::DateTime<Utc>) -> PlanUsage {
    PlanUsage {
        five_hour: Some(UsageWindow {
            percent: 100.0,
            resets_at: Some(resets_at.to_rfc3339()),
        }),
        seven_day: None,
        subscription_type: None,
        stale: false,
        source: UsageSource::Local,
        fetched_at_ms: 0,
        last_error: None,
    }
}

fn sesion(id: &str) {
    registro::insert(registro::sesion_de_prueba(id)).expect("alta");
}

fn transcript_con(lineas: &[String]) -> (tempfile::TempDir, std::path::PathBuf) {
    let d = tempfile::tempdir().expect("tempdir");
    let p = d.path().join("t.jsonl");
    std::fs::write(&p, lineas.join("\n") + "\n").expect("transcript");
    (d, p)
}

fn espera(mut f: impl FnMut() -> bool) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < StdDuration::from_secs(10) {
        if f() {
            return true;
        }
        std::thread::sleep(StdDuration::from_millis(10));
    }
    false
}

fn tarea(tarea_id: &str, sid: &str, engine: &str, status: &str) -> EngineTask {
    EngineTask {
        id: tarea_id.into(),
        engine: engine.into(),
        kind: "relay".into(),
        mode: "local".into(),
        cwd: ".".into(),
        prompt: "x".into(),
        status: status.into(),
        started_at: String::new(),
        finished_at: None,
        events: Vec::new(),
        summary: None,
        cloud_task_id: None,
        session_id: Some(sid.into()),
        thread_id: None,
        context_chars: 0,
        model: None,
        brought_at: None,
        anchor_message_uuid: None,
        usage: None,
        group: None,
    }
}

fn con_vuelta_pasada(sid: &str) {
    insert_for_test(sid, "codex", "t");
    lock_states().get_mut(sid).expect("estado").return_at =
        Some((Local::now() - Duration::minutes(1)).to_rfc3339());
}

// --- Cuándo se está en el límite ------------------------------------------

#[test]
fn un_aviso_reciente_al_final_cuenta_aunque_le_siga_el_fin_de_turno() {
    let ahora = Utc::now();
    let turn_duration = json!({ "type": "system", "subtype": "turn_duration" }).to_string();
    let texto = format!(
        "{}\n{}\n{turn_duration}\n",
        prompt(1),
        aviso_con_hora(ahora)
    );
    assert!(limite_vigente(Some(&texto), None, ahora).is_some());
}

/// Un límite ya pasado sigue siendo la última línea de una sesión parada: si
/// contara, la cola quedaría retenida para siempre al volver.
#[test]
fn un_aviso_viejo_no_cuenta() {
    let ahora = Utc::now();
    let texto = aviso_con_hora(ahora - Duration::minutes(5));
    assert_eq!(limite_vigente(Some(&texto), None, ahora), None);
}

/// Tras el aviso alguien habló: el límite ya no es lo último que pasó.
#[test]
fn un_aviso_seguido_de_un_prompt_no_cuenta() {
    let ahora = Utc::now();
    let texto = format!("{}\n{}\n", aviso_con_hora(ahora), prompt(2));
    assert_eq!(limite_vigente(Some(&texto), None, ahora), None);
}

#[test]
fn una_respuesta_normal_o_un_final_vacio_no_cuentan() {
    let ahora = Utc::now();
    let normal = json!({
        "type": "assistant",
        "timestamp": ahora.to_rfc3339(),
        "message": { "model": "claude-opus-5-5", "content": [{ "type": "text", "text": AVISO }] }
    })
    .to_string();
    assert_eq!(limite_vigente(Some(&normal), None, ahora), None);
    assert_eq!(limite_vigente(Some(""), None, ahora), None);
    assert_eq!(limite_vigente(None, None, ahora), None);
}

/// Sesión restaurada en pleno límite: sin aviso nuevo, manda la muestra de uso.
#[test]
fn la_muestra_agotada_cuenta_solo_con_el_reinicio_pendiente() {
    let ahora = Utc::now();
    let futura = usage_llena(ahora + Duration::hours(1));
    let vuelta = limite_vigente(None, Some(&futura), ahora).expect("en el límite");
    assert!(vuelta.is_some(), "con su hora de vuelta");
    let pasada = usage_llena(ahora - Duration::hours(1));
    assert_eq!(
        limite_vigente(None, Some(&pasada), ahora),
        None,
        "de la ventana anterior"
    );
}

// --- Antes de drenar --------------------------------------------------------

fn item(client_id: &str) -> QueueItemInput {
    QueueItemInput {
        client_id: client_id.into(),
        text: "siguiente".into(),
        attachments: Vec::new(),
        delegate: false,
        kind: QueueItemKind::Prompt,
    }
}

/// El `turnEnd` del puente llega antes que el seguidor: el aviso ya está en el
/// fichero y el mensaje siguiente no sale.
#[test]
fn el_drenaje_se_frena_con_un_aviso_que_el_seguidor_aun_no_leyo() {
    let sid = id("frena-aviso");
    sesion(&sid);
    let (_d, p) = transcript_con(&[prompt(1), aviso_con_hora(Utc::now())]);
    registro::update(&sid, |s| {
        s.transcript = Some(p.clone());
        (false, ())
    })
    .expect("transcript");
    cola::global().encolar(&sid, item("a"), 0).expect("encolar");
    assert!(limite::frena_drenaje(&sid, || None));
    assert!(limite::vuelta_anotada(&sid).is_some(), "queda en pausa");
    forget_session(&sid);
    assert_eq!(limite::vuelta_anotada(&sid), None, "cerrar la olvida");
}

/// Casos negativos: cola vacía, o un transcript sin aviso, no frenan.
#[test]
fn el_drenaje_no_se_frena_sin_cola_ni_sin_limite() {
    let sid = id("frena-no");
    sesion(&sid);
    let llena = || panic!("sin cola no se consulta la muestra");
    assert!(!limite::frena_drenaje(&sid, llena));
    let (_d, p) = transcript_con(&[prompt(1)]);
    registro::update(&sid, |s| {
        s.transcript = Some(p.clone());
        (false, ())
    })
    .expect("transcript");
    cola::global().encolar(&sid, item("a"), 0).expect("encolar");
    assert!(!limite::frena_drenaje(&sid, || None));
    assert_eq!(limite::vuelta_anotada(&sid), None);
}

// --- Vuelta sin relevo ------------------------------------------------------

#[test]
fn sin_relevo_la_cola_se_reanuda_a_la_hora_de_vuelta() {
    let sid = id("poll-hora");
    limite::pausar(
        &sid,
        Some((Local::now() - Duration::minutes(1)).to_rfc3339()),
    );
    limite::poll(&sid, || None);
    assert_eq!(limite::vuelta_anotada(&sid), None, "levantada");
}

/// La muestra sigue llena: la vuelta se aplaza y no se quema otro mensaje.
#[test]
fn sin_relevo_la_vuelta_se_aplaza_si_la_muestra_sigue_agotada() {
    let sid = id("poll-aplaza");
    limite::pausar(
        &sid,
        Some((Local::now() - Duration::minutes(1)).to_rfc3339()),
    );
    let reinicio = Utc::now() + Duration::hours(2);
    limite::poll(&sid, || Some(usage_llena(reinicio)));
    assert_eq!(
        limite::vuelta_anotada(&sid),
        Some(Some(reinicio.to_rfc3339()))
    );
    limite::olvidar(&sid);
}

/// Antes de la hora, o sin hora conocida, ni se reanuda ni se lee la muestra
/// (esto corre en cada vuelta del seguidor).
#[test]
fn sin_relevo_no_se_reanuda_antes_de_hora_ni_sin_hora() {
    let no_consulta = || panic!("no debe leer la muestra");
    let futura = id("poll-futura");
    limite::pausar(
        &futura,
        Some((Local::now() + Duration::hours(1)).to_rfc3339()),
    );
    limite::poll(&futura, no_consulta);
    assert!(limite::vuelta_anotada(&futura).is_some());
    limite::olvidar(&futura);
    let sin_hora = id("poll-sin-hora");
    limite::pausar(&sin_hora, None);
    limite::poll(&sin_hora, no_consulta);
    assert_eq!(limite::vuelta_anotada(&sin_hora), Some(None));
    limite::olvidar(&sin_hora);
}

// --- observe ----------------------------------------------------------------

/// El límite retiene la cola también con `automaticRelay` apagado: la pausa se
/// anota antes de mirar la preferencia.
#[test]
fn observe_anota_la_pausa_y_una_linea_normal_no() {
    let sid = id("observe");
    let (_d, p) = transcript_con(&[prompt(1)]);
    let normal = json!({ "type": "assistant", "message": { "model": "claude-opus-5-5" } });
    observe(&sid, &normal, &p);
    assert_eq!(limite::vuelta_anotada(&sid), None, "línea normal");
    let aviso = json!({
        "type": "assistant",
        "message": { "model": "<synthetic>", "content": [{ "type": "text", "text": AVISO }] }
    });
    observe(&sid, &aviso, &p);
    assert!(limite::vuelta_anotada(&sid).is_some());
    // Sin sesión registrada, el relevo no llega a crear estado.
    assert!(espera(|| limite::reservar_entrada(&sid)), "el hilo acaba");
    limite::liberar_entrada(&sid);
    assert!(get(&sid).is_none());
    limite::olvidar(&sid);
}

/// Una segunda entrada mientras la primera prepara el relevo no lanza otra.
#[test]
fn solo_se_prepara_un_relevo_a_la_vez() {
    let sid = id("entrada");
    assert!(limite::reservar_entrada(&sid));
    assert!(!limite::reservar_entrada(&sid));
    limite::liberar_entrada(&sid);
    assert!(limite::reservar_entrada(&sid));
    limite::olvidar(&sid);
}

// --- Entrada en el relevo ---------------------------------------------------

/// Toda la cadena falla en el test: el relevo acaba en error visible, con el
/// último prompt como petición y git degradado (el cwd `demo` no existe).
#[test]
fn entrar_en_el_relevo_compone_el_traspaso_y_escala_hasta_el_error() {
    let sid = id("entra");
    sesion(&sid);
    let (_d, p) = transcript_con(&[prompt(1), prompt(2)]);
    let limit = UsageLimit {
        kind: LimitKind::Session,
        reset_time: String::new(),
        return_at: None,
    };
    enter_relay(&sid, &limit, &p);
    let s = get(&sid).expect("relevo");
    assert_eq!(s.failed_prompt, "peticion-2");
    assert_eq!(s.active_engine, "gemini", "fin de la cadena");
    let error = s.error.expect("error visible");
    assert!(error.contains("no se lanza en los tests"), "{error}");
    assert!(s.handoff.contains(GIT_NO_DISPONIBLE), "{}", s.handoff);
    forget_session(&sid);
    registro::remove(&sid);
}

/// Un transcript ilegible no deja el relevo a medias.
#[test]
fn sin_transcript_no_hay_relevo() {
    let sid = id("sin-transcript");
    sesion(&sid);
    let limit = UsageLimit {
        kind: LimitKind::Session,
        reset_time: String::new(),
        return_at: None,
    };
    let dir = tempfile::tempdir().expect("tempdir");
    enter_relay(&sid, &limit, &dir.path().join("no-existe.jsonl"));
    assert!(get(&sid).is_none());
    registro::remove(&sid);
}

/// Una sesión cerrada mientras se preparaba no deja un relevo fantasma.
#[test]
fn una_sesion_cerrada_al_preparar_no_deja_relevo() {
    let sid = id("cerrada");
    let (_d, p) = transcript_con(&[prompt(1)]);
    let limit = UsageLimit {
        kind: LimitKind::Session,
        reset_time: String::new(),
        return_at: None,
    };
    enter_relay(&sid, &limit, &p);
    assert!(get(&sid).is_none());
}

/// El traspaso no carga el transcript entero: con lo reciente basta.
#[test]
fn los_mensajes_recientes_no_leen_el_fichero_entero() {
    let relleno = json!({
        "type": "assistant", "uuid": "r", "timestamp": "t",
        "message": { "role": "assistant", "content": [{ "type": "text", "text": "x".repeat(1024) }] }
    })
    .to_string();
    let mut lineas = vec![json!({
        "type": "user", "uuid": "viejo", "timestamp": "t",
        "message": { "role": "user", "content": "peticion-vieja" }
    })
    .to_string()];
    lineas.extend(std::iter::repeat_n(relleno, 1024));
    lineas.extend((0..40).map(prompt));
    let (_d, p) = transcript_con(&lineas);
    let mensajes = recent_messages(&p).expect("mensajes");
    let texto = serde_json::to_string(&mensajes).expect("json");
    assert!(texto.contains("peticion-39"));
    assert!(!texto.contains("peticion-vieja"), "ventana, no el fichero");
}

/// Sin prompts en la ventana, crece hasta el fichero entero (caso negativo).
#[test]
fn los_mensajes_recientes_crecen_hasta_encontrar_el_prompt() {
    let relleno = json!({
        "type": "assistant", "uuid": "r", "timestamp": "t",
        "message": { "role": "assistant", "content": [{ "type": "text", "text": "x".repeat(1024) }] }
    })
    .to_string();
    let mut lineas = vec![prompt(7)];
    lineas.extend(std::iter::repeat_n(relleno, 512));
    let (_d, p) = transcript_con(&lineas);
    let mensajes = recent_messages(&p).expect("mensajes");
    assert_eq!(prompt::failed_prompt(&mensajes), "peticion-7");
}

// --- git ---------------------------------------------------------------------

/// Codex #6: un git colgado no retiene el relevo.
#[cfg(windows)]
#[test]
fn un_git_colgado_da_el_resultado_degradado_en_su_plazo() {
    let mut cmd = Command::new("ping");
    cmd.args(["-n", "20", "127.0.0.1"]);
    let t0 = Instant::now();
    let salida = salida_o_degradado(cmd, StdDuration::from_millis(300));
    assert_eq!(salida, GIT_NO_DISPONIBLE);
    assert!(
        t0.elapsed() < StdDuration::from_secs(5),
        "{:?}",
        t0.elapsed()
    );
}

#[test]
fn git_status_de_una_carpeta_inexistente_es_degradado() {
    let d = tempfile::tempdir().expect("tempdir");
    let no_existe = d.path().join("no-existe");
    assert_eq!(git_status(&no_existe.to_string_lossy()), GIT_NO_DISPONIBLE);
}

/// Caso negativo: un repositorio de verdad da su salida.
#[test]
fn git_status_de_un_repositorio_da_su_salida() {
    let d = tempfile::tempdir().expect("tempdir");
    let init = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(d.path())
        .status();
    if !init.is_ok_and(|s| s.success()) {
        return; // sin git en la máquina no hay nada que comprobar
    }
    std::fs::write(d.path().join("nuevo.txt"), "x").expect("fichero");
    let salida = git_status(&d.path().to_string_lossy());
    assert!(salida.contains("nuevo.txt"), "{salida}");
}

// --- Vuelta a Claude --------------------------------------------------------

/// `poll_return` reserva la vuelta y la completa en su hilo: reanuda la cola.
#[test]
fn poll_return_vuelve_a_claude_sin_tarea_en_curso() {
    let sid = id("vuelta");
    con_vuelta_pasada(&sid);
    limite::pausar(&sid, None);
    poll_return(&sid);
    assert!(espera(|| get(&sid).is_none()), "relevo cerrado");
    assert_eq!(limite::vuelta_anotada(&sid), None, "cola reanudada");
}

/// Caso negativo: antes de la hora no vuelve.
#[test]
fn poll_return_no_vuelve_antes_de_hora() {
    let sid = id("vuelta-pronto");
    insert_for_test(&sid, "codex", "t");
    lock_states().get_mut(&sid).expect("estado").return_at =
        Some((Local::now() + Duration::hours(1)).to_rfc3339());
    poll_return(&sid);
    let s = get(&sid).expect("relevo");
    assert!(!s.closing);
    forget_session(&sid);
}

/// Un relevo en error espera al usuario: sin reintentos en bucle.
#[test]
fn poll_return_no_vuelve_con_el_relevo_en_error() {
    let sid = id("vuelta-error");
    con_vuelta_pasada(&sid);
    mark_error(&sid, "codex", "fallo".into());
    poll_return(&sid);
    assert!(!get(&sid).expect("relevo").closing);
    forget_session(&sid);
}

/// Con el motor trabajando, la vuelta automática espera.
#[test]
fn poll_return_espera_al_motor_en_curso() {
    let sid = id("vuelta-motor");
    con_vuelta_pasada(&sid);
    let tid = format!("t-{sid}");
    motor::insertar_para_prueba(tarea(&tid, &sid, "codex", "running"));
    track_task(&tarea(&tid, &sid, "codex", "running"));
    poll_return(&sid);
    assert!(!get(&sid).expect("relevo").closing);
    motor::cancel(&tid).expect("limpieza");
    forget_session(&sid);
}

#[test]
fn return_to_claude_cancela_solo_si_se_le_pide() {
    let sid = id("vuelta-manual");
    insert_for_test(&sid, "codex", "t");
    limite::pausar(&sid, None);
    let tid = format!("t-{sid}");
    motor::insertar_para_prueba(tarea(&tid, &sid, "codex", "running"));
    track_task(&tarea(&tid, &sid, "codex", "running"));
    assert!(return_to_claude(&sid, false).is_err());
    assert!(get(&sid).is_some());
    return_to_claude(&sid, true).expect("vuelta");
    assert!(get(&sid).is_none());
    assert_eq!(motor::get(&tid).expect("tarea").status, "cancelled");
    assert_eq!(limite::vuelta_anotada(&sid), None, "cola reanudada");
}

/// Si no se puede traer el resultado, el relevo sigue y se puede reintentar: ni
/// se pierde el resultado ni la cola sale antes de tiempo.
#[test]
fn una_vuelta_que_falla_conserva_el_relevo_y_la_pausa() {
    let sid = id("vuelta-falla");
    insert_for_test(&sid, "codex", "t");
    limite::pausar(&sid, None);
    let tid = format!("t-{sid}");
    let mut hecha = tarea(&tid, &sid, "codex", "done");
    hecha.summary = Some("resultado".into());
    motor::insertar_para_prueba(hecha.clone());
    track_task(&hecha);
    assert!(
        return_to_claude(&sid, true).is_err(),
        "sin sesión a la que traer"
    );
    let s = get(&sid).expect("relevo");
    assert!(!s.closing, "se puede reintentar");
    assert!(
        limite::vuelta_anotada(&sid).is_some(),
        "la cola sigue en pausa"
    );
    assert!(motor::get(&tid).expect("tarea").brought_at.is_none());
    forget_session(&sid);
}

// --- Carreras y cierre ------------------------------------------------------

/// Cerrar la sesión cancela su motor y olvida su relevo: uno con acceso total no
/// sigue editando el repo sin nadie que lo vea. Los de otra sesión siguen.
#[test]
fn cerrar_la_sesion_cancela_su_motor_y_olvida_su_relevo() {
    let sid = id("kill");
    sesion(&sid);
    insert_for_test(&sid, "codex", "t");
    limite::pausar(&sid, None);
    let (mia, ajena) = (format!("m-{sid}"), format!("a-{sid}"));
    motor::insertar_para_prueba(tarea(&mia, &sid, "codex", "running"));
    motor::insertar_para_prueba(tarea(&ajena, "otra-sesion", "codex", "running"));
    track_task(&tarea(&mia, &sid, "codex", "running"));
    crate::sesiones::gestor::kill(&sid).expect("cerrar");
    assert!(get(&sid).is_none());
    assert_eq!(limite::vuelta_anotada(&sid), None);
    assert_eq!(motor::get(&mia).expect("mía").status, "cancelled");
    assert_eq!(motor::get(&ajena).expect("ajena").status, "running");
    motor::cancel(&ajena).expect("limpieza");
}

/// Codex #3: un lanzamiento que acaba tras `switch_to_gemini` no deshace el
/// cambio de motor.
#[test]
fn una_tarea_nueva_no_cambia_el_motor_activo() {
    let sid = id("motor-activo");
    insert_for_test(&sid, "opencode", "t");
    claim(&sid, "opencode", "gemini").expect("cambio");
    track_task(&tarea("tardia", &sid, "opencode", "running"));
    assert_eq!(
        get(&sid).map(|s| s.active_engine).as_deref(),
        Some("gemini")
    );
    forget_session(&sid);
}

/// Una tarea que nunca entró en el relevo no vuelve a él al terminar.
#[test]
fn una_tarea_ajena_que_termina_no_se_registra() {
    let sid = id("ajena");
    insert_for_test(&sid, "codex", "t");
    task_finished(&tarea("nunca", &sid, "opencode", "done"));
    assert!(get(&sid).expect("relevo").task_ids.is_empty());
    forget_session(&sid);
}

#[test]
fn la_generacion_del_reintento_sigue_al_relevo() {
    let sid = id("generacion");
    let t = tarea("g", &sid, "opencode", "error");
    assert_eq!(retry_generation(&t), RetryCheck::Stale, "sin relevo");
    let mut otra = t.clone();
    otra.kind = "task".into();
    assert_eq!(retry_generation(&otra), RetryCheck::NotRelay);
    insert_for_test(&sid, "opencode", "x");
    assert_eq!(retry_generation(&t), RetryCheck::Current(0));
    claim(&sid, "opencode", "codex").expect("cambio");
    assert_eq!(retry_generation(&t), RetryCheck::Stale, "otro motor");
    begin_return(&sid).expect("cierre");
    let mut codex = t;
    codex.engine = "codex".into();
    assert_eq!(retry_generation(&codex), RetryCheck::Stale, "cerrándose");
    forget_session(&sid);
}

/// Cerrar la sesión deja de enseñar el relevo y sus tareas dejan de protegerse.
#[test]
fn cerrar_la_sesion_olvida_el_relevo() {
    let sid = id("cierre");
    insert_for_test(&sid, "codex", "t");
    limite::pausar(&sid, None);
    track_task(&tarea("cierre-t", &sid, "codex", "done"));
    assert!(active_task_ids().contains("cierre-t"));
    forget_session(&sid);
    assert!(get(&sid).is_none());
    assert!(list().iter().all(|s| s.session_id != sid));
    assert_eq!(limite::vuelta_anotada(&sid), None);
    assert!(!active_task_ids().contains("cierre-t"));
}
