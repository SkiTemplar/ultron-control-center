// sesiones/tests_persistencia.rs — abiertas.json: proyección, escritura
// atómica, fichero dañado y restauración de sesiones (hallazgo #35).

use super::restaurar::{decidir, restaurar_desde, restaurar_todas, texto_descartes, Descarte};
use super::*;
use crate::sesiones::cola::{self, Colas};
use crate::sesiones::lanzamiento;
use crate::sesiones::registro;
use crate::sesiones::test_sink::MockSink;
use crate::sesiones::types::SessionStatus;

const SID: &str = "0bacfbdb-a455-4982-bada-f1fc39a9d205";

fn item(client_id: &str, state: QueueState) -> QueueItem {
    QueueItem {
        client_id: client_id.into(),
        text: format!("texto de {client_id}"),
        attachments: Vec::new(),
        delegate: false,
        kind: QueueItemKind::Prompt,
        origin: QueueOrigin::Ultron,
        state,
        created_at: "2026-10-14T00:00:00.000Z".into(),
        sent_at: Some("2026-10-14T00:00:01.000Z".into()),
        error: None,
        message_uuid: None,
    }
}

fn config(cwd: &str) -> Config {
    Config {
        cwd: cwd.into(),
        project_id: None,
        model: Some("claude-opus-5-5".into()),
        effort: Some("high".into()),
        permission_mode: PermissionMode::AcceptEdits,
        settings_file: Some("no-se-guarda.json".into()),
    }
}

fn abierta(id: &str, sid: Option<&str>, cwd: &str) -> Abierta {
    Abierta {
        id: id.into(),
        project_id: None,
        cwd: cwd.into(),
        title: format!("título {id}"),
        title_auto: false,
        title_source: None,
        claude_session_id: sid.map(str::to_string),
        transcript: None,
        model: Some("claude-opus-5-5".into()),
        launch_permission_mode: PermissionMode::AcceptEdits,
        started_at: "2026-10-13T10:00:00.000Z".into(),
        config: Some(config(cwd)),
        cola: cola_guardable(&[
            item("q1", QueueState::Queued),
            item("s1", QueueState::Sending),
        ]),
        turno_vivo: None,
    }
}

/// Carpeta de trabajo y `~/.claude/projects` de prueba con el transcript de
/// `sid` (si `con_transcript`).
fn entorno(sid: &str, con_transcript: bool) -> (tempfile::TempDir, String, std::path::PathBuf) {
    let d = tempfile::tempdir().expect("tempdir");
    let cwd = d.path().join("proyecto");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let cwd = cwd.to_string_lossy().into_owned();
    let projects = d.path().join("projects");
    let slug = projects.join(registro::claude_slug(&cwd));
    std::fs::create_dir_all(&slug).expect("slug");
    if con_transcript {
        std::fs::write(slug.join(format!("{sid}.jsonl")), "{}\n").expect("jsonl");
    }
    (d, cwd, projects)
}

fn limpiar(id: &str) {
    registro::remove(id);
    cola::global().olvidar(id);
    lanzamiento::olvidar(id);
    tomar_avisos(id);
}

#[test]
fn la_cola_guarda_queued_y_failed_y_sending_pasa_a_queued_con_aviso() {
    let mut fallido = item("f1", QueueState::Failed);
    fallido.error = Some("la sesión terminó".into());
    let items = [
        item("q1", QueueState::Queued),
        item("s1", QueueState::Sending),
        fallido,
        item("c1", QueueState::CliQueued),
        item("a1", QueueState::Absorbed),
        item("d1", QueueState::Delivered),
    ];
    let g = cola_guardable(&items);
    let ids: Vec<&str> = g.iter().map(|x| x.client_id.as_str()).collect();
    assert_eq!(ids, ["q1", "s1", "f1", "c1"]);
    assert_eq!(g[1].state, QueueState::Queued);
    assert_eq!(g[1].error.as_deref(), Some(AVISO_SENDING));
    // La cola nativa muere con el proceso al cerrar ULTRON: se guarda como un
    // envío en vuelo, que al restaurar se cruza con el transcript.
    assert_eq!(g[3].state, QueueState::Queued);
    assert_eq!(g[3].error.as_deref(), Some(AVISO_SENDING));
    assert_eq!(g[2].state, QueueState::Failed);
    assert_eq!(g[2].error.as_deref(), Some("la sesión terminó"));
    assert!(g[0].error.is_none());
}

/// La proyección no cambia con la actividad ni con el estado: el escritor no
/// reescribe cada 5 s. Sí cambia con la cola (caso negativo).
#[test]
fn la_proyeccion_ignora_actividad_y_estado_y_no_guarda_los_settings() {
    let mut s = registro::sesion_de_prueba("p1");
    s.info.claude_session_id = Some(SID.into());
    let base = Persistible {
        info: s.info.clone(),
        transcript: None,
        titulo: crate::sesiones::titulo::OrigenTitulo::Provisional,
    };
    let mut otra = base.clone();
    otra.info.status = SessionStatus::Working;
    otra.info.last_activity_at = "2030-01-01T00:00:00.000Z".into();
    let cfg = |_: &str| Some(config("demo"));
    let vacia = |_: &str| Vec::new();
    let a =
        serde_json::to_string(&proyectar(std::slice::from_ref(&base), &cfg, &vacia)).expect("json");
    let b = serde_json::to_string(&proyectar(&[otra], &cfg, &vacia)).expect("json");
    assert_eq!(a, b);
    assert!(!a.contains("lastActivityAt") && !a.contains("\"status\""));
    assert!(
        !a.contains("no-se-guarda.json"),
        "settings_file es temporal: {a}"
    );
    let con_cola = |_: &str| vec![item("q1", QueueState::Queued)];
    let c = serde_json::to_string(&proyectar(&[base], &cfg, &con_cola)).expect("json");
    assert_ne!(a, c);
}

#[test]
fn escritura_atomica_y_lectura_de_vuelta() {
    let d = tempfile::tempdir().expect("tempdir");
    let ruta = d.path().join("sesiones").join("abiertas.json");
    assert_eq!(leer(&ruta), Ok(Lectura::Vacia));
    let f = Fichero {
        version: VERSION,
        sesiones: vec![abierta("a1", Some(SID), "demo")],
    };
    let texto = serde_json::to_string_pretty(&f).expect("json");
    escribir_atomico(&ruta, &texto).expect("escribir");
    escribir_atomico(&ruta, &texto).expect("sustituir");
    assert!(!ruta.with_extension("json.tmp").exists());
    let mut esperado = f.clone();
    esperado.sesiones[0]
        .config
        .as_mut()
        .expect("cfg")
        .settings_file = None;
    assert_eq!(leer(&ruta), Ok(Lectura::Leida(esperado)));
}

/// Un fichero dañado se aparta a `.bad` sin perderlo; si ya hay un `.bad`,
/// el nuevo lleva marca de tiempo y el anterior sigue.
#[test]
fn un_fichero_danado_se_aparta_y_nunca_se_pierde() {
    let d = tempfile::tempdir().expect("tempdir");
    let ruta = d.path().join("abiertas.json");
    std::fs::write(&ruta, "{ no es json").expect("escribir");
    let Ok(Lectura::Apartada { destino, error }) = leer(&ruta) else {
        panic!("debía apartarse");
    };
    assert!(error.contains("JSON"), "{error}");
    assert!(!ruta.exists());
    assert_eq!(destino, d.path().join("abiertas.json.bad"));
    assert_eq!(
        std::fs::read_to_string(&destino).expect("bad"),
        "{ no es json"
    );
    std::fs::write(&ruta, r#"{"version":99,"sesiones":[]}"#).expect("escribir");
    let Ok(Lectura::Apartada {
        destino: otro,
        error,
    }) = leer(&ruta)
    else {
        panic!("una versión desconocida también se aparta");
    };
    assert!(error.contains("99"), "{error}");
    assert_ne!(otro, destino);
    assert!(destino.exists() && otro.exists());
}

#[test]
fn decidir_descarta_sin_conversacion_sin_carpeta_o_sin_transcript() {
    let (_d, cwd, projects) = entorno(SID, false);
    let sin_sid = decidir(abierta("x1", None, &cwd), &projects).expect_err("sin sid");
    assert!(
        sin_sid.motivo.contains("conversación"),
        "{}",
        sin_sid.motivo
    );
    assert_eq!(sin_sid.pendientes, 2);
    let sin_dir = decidir(abierta("x2", Some(SID), "Z:/no/existe"), &projects).expect_err("cwd");
    assert!(sin_dir.motivo.contains("carpeta"), "{}", sin_dir.motivo);
    let sin_tx = decidir(abierta("x3", Some(SID), &cwd), &projects).expect_err("transcript");
    assert!(sin_tx.motivo.contains("transcript"), "{}", sin_tx.motivo);
    assert!(sin_tx.apartable.is_none(), "sin transcript es definitivo");
    assert!(sin_tx.sin_conversacion);
    // Caso negativo: sin la carpeta de transcripts, la causa sí es pasajera.
    let sin_projects =
        decidir(abierta("x5", Some(SID), &cwd), &projects.join("no-existe")).expect_err("projects");
    assert!(sin_projects.apartable.is_some(), "{}", sin_projects.motivo);
    assert!(!sin_projects.sin_conversacion);
    let (_d2, cwd2, projects2) = entorno(SID, true);
    let plan = decidir(abierta("x4", Some(SID), &cwd2), &projects2).expect("plan");
    assert_eq!(plan.sid, SID);
    assert!(plan.transcript.ends_with(format!("{SID}.jsonl")));
}

/// Restaurar da de alta con el mismo id, la `Config`, la cola y la nota;
/// después, cerrar la sesión la quita de la proyección.
#[test]
fn restaurar_conserva_id_config_y_cola_y_cerrar_la_quita() {
    let sid = uuid::Uuid::new_v4().to_string();
    let id = format!("rest-{}", uuid::Uuid::new_v4());
    let (_d, cwd, projects) = entorno(&sid, true);
    let mut a = abierta(&id, Some(&sid), &cwd);
    a.cola.push(Guardado {
        state: QueueState::Failed,
        error: Some("falló".into()),
        ..cola_guardable(&[item("f1", QueueState::Queued)])[0].clone()
    });
    let r = restaurar_todas(vec![a], &projects);
    assert_eq!(r.len(), 1);
    assert_eq!(
        (r[0].id.as_str(), r[0].sid.as_str()),
        (id.as_str(), sid.as_str())
    );
    let info = registro::read(&id, |s| s.info.clone()).expect("registrada");
    assert_eq!(info.title, format!("título {id}"));
    assert_eq!(info.claude_session_id.as_deref(), Some(sid.as_str()));
    assert_eq!(info.status, SessionStatus::Starting);
    let cfg = lanzamiento::guardada(&id).expect("config guardada");
    assert_eq!(cfg.permission_mode, PermissionMode::AcceptEdits);
    assert_eq!(cfg.effort.as_deref(), Some("high"));
    let estados: Vec<(String, QueueState)> = cola::global()
        .lista(&id, 0)
        .into_iter()
        .map(|i| (i.client_id, i.state))
        .collect();
    assert_eq!(
        estados,
        [
            ("q1".to_string(), QueueState::Queued),
            ("s1".to_string(), QueueState::Queued),
            ("f1".to_string(), QueueState::Failed),
        ]
    );
    let notas = tomar_avisos(&id);
    assert_eq!(notas.len(), 1);
    // El transcript de prueba no tiene prompts: no se puede comprobar.
    assert!(notas[0].1.contains("--resume") && notas[0].1.contains("no se ha podido comprobar"));
    let tiene = || {
        registro::persistibles()
            .expect("registro")
            .iter()
            .any(|p| p.info.id == id)
    };
    assert!(tiene());
    limpiar(&id);
    assert!(!tiene(), "cerrar la sesión la quita de abiertas.json");
}

/// Un `sending` cuyo texto es el último prompt del transcript ya llegó: al
/// restaurar no vuelve a la cola (la máquina lo drenaría y se duplicaría).
#[test]
fn restaurar_no_repone_un_envio_que_ya_consta_en_el_transcript() {
    let sid = uuid::Uuid::new_v4().to_string();
    let id = format!("rest-{}", uuid::Uuid::new_v4());
    let (_d, cwd, projects) = entorno(&sid, true);
    let linea = serde_json::json!({
        "type": "user", "uuid": "u1", "timestamp": "t",
        "message": { "role": "user", "content": "texto de s1" }
    });
    let jsonl = projects
        .join(registro::claude_slug(&cwd))
        .join(format!("{sid}.jsonl"));
    std::fs::write(&jsonl, format!("{linea}\n")).expect("transcript");
    let r = restaurar_todas(vec![abierta(&id, Some(&sid), &cwd)], &projects);
    assert_eq!(r.len(), 1);
    let cola: Vec<String> = cola::global()
        .lista(&id, 0)
        .into_iter()
        .map(|i| i.client_id)
        .collect();
    assert_eq!(cola, ["q1"]);
    let notas = tomar_avisos(&id);
    assert!(
        notas[0].1.contains("ya consta(n) en el transcript"),
        "{notas:?}"
    );
    limpiar(&id);
}

/// La conversación ya abierta en otra sesión no se retoma otra vez (la misma
/// regla de `gestor::create`), tampoco si el fichero la repite.
#[test]
fn no_retoma_una_conversacion_ya_abierta() {
    let sid = uuid::Uuid::new_v4().to_string();
    let (_d, cwd, projects) = entorno(&sid, true);
    let viva = format!("viva-{}", uuid::Uuid::new_v4());
    let mut s = registro::sesion_de_prueba(&viva);
    s.info.claude_session_id = Some(sid.clone());
    registro::insert(s).expect("alta");
    let otra = format!("otra-{}", uuid::Uuid::new_v4());
    let r = restaurar_todas(vec![abierta(&otra, Some(&sid), &cwd)], &projects);
    assert!(r.is_empty());
    assert!(!registro::exists(&otra));
    limpiar(&viva);
    let (b, c) = (
        format!("b-{}", uuid::Uuid::new_v4()),
        format!("c-{}", uuid::Uuid::new_v4()),
    );
    let r = restaurar_todas(
        vec![abierta(&b, Some(&sid), &cwd), abierta(&c, Some(&sid), &cwd)],
        &projects,
    );
    assert_eq!(r.len(), 1, "solo la primera de las dos");
    assert!(registro::exists(&b) && !registro::exists(&c));
    limpiar(&b);
}

#[test]
fn reponer_solo_admite_queued_y_failed_sin_duplicar() {
    let c = Colas::default();
    let items = vec![
        item("q1", QueueState::Queued),
        item("q1", QueueState::Queued),
        item("f1", QueueState::Failed),
        item("d1", QueueState::Delivered),
    ];
    assert_eq!(c.reponer("s", items.clone()), Ok(2));
    assert_eq!(c.reponer("s", items), Ok(0), "idempotente por clientId");
    let ids: Vec<String> = c.lista("s", 0).into_iter().map(|i| i.client_id).collect();
    assert_eq!(ids, ["q1", "f1"]);
    assert!(c.hay_en_cola("s"));
}

#[test]
fn el_aviso_de_descartes_dice_que_se_pierde() {
    let d = [
        Descarte {
            titulo: "A".into(),
            motivo: "sin transcript".into(),
            pendientes: 2,
            apartable: Some(Box::new(abierta("a", Some(SID), "C:/a"))),
            sin_conversacion: false,
        },
        Descarte {
            titulo: "B".into(),
            motivo: "sin conversación".into(),
            pendientes: 3,
            apartable: None,
            sin_conversacion: true,
        },
    ];
    let t = texto_descartes(&d, None).expect("aviso");
    assert!(
        t.contains("«A» (sin transcript, con 2 mensaje(s) en cola que se pierden)"),
        "{t}"
    );
    assert!(t.contains("«B» (sin conversación, con 3 mensaje(s) en cola que se pierden)"));
    let ruta = std::path::Path::new("C:/x/abiertas.descartadas.json");
    let t = texto_descartes(&d, Some(ruta)).expect("aviso");
    assert!(
        t.contains("«A» (sin transcript, con 2 mensaje(s) en cola)"),
        "{t}"
    );
    assert!(t.contains("abiertas.descartadas.json"), "{t}");
    assert!(t.contains("que se pierden"), "B sigue perdiéndose: {t}");
}

/// Una sesión sin conversación ni cola no avisa: no se pierde nada. Con
/// cola sí avisa (caso negativo), y el resto de descartes también.
#[test]
fn una_sesion_vacia_sin_cola_no_avisa() {
    let vacia = |titulo: &str, pendientes| Descarte {
        titulo: titulo.into(),
        motivo: "la conversación no llegó a empezar".into(),
        pendientes,
        apartable: None,
        sin_conversacion: true,
    };
    assert_eq!(texto_descartes(&[vacia("N", 0)], None), None);
    let t = texto_descartes(&[vacia("N", 0), vacia("C", 1)], None).expect("con cola avisa");
    assert!(t.contains("«C»") && !t.contains("«N»"), "{t}");
    let fallo = Descarte {
        sin_conversacion: false,
        motivo: "ya hay una sesión con su mismo id".into(),
        ..vacia("D", 0)
    };
    assert!(
        texto_descartes(&[fallo], None).is_some(),
        "un fallo real avisa"
    );
}

/// Regresión del aviso repetido en cada arranque: una sesión apartada sin
/// transcript (abierta y cortada antes de su primer mensaje) sale de
/// `abiertas.descartadas.json` en vez de reintentarse para siempre.
#[test]
fn una_apartada_sin_transcript_sale_del_fichero_de_descartes() {
    let sid = uuid::Uuid::new_v4().to_string();
    let id = format!("vacia-{}", uuid::Uuid::new_v4());
    let (_d, cwd, projects) = entorno(&sid, false);
    let dir = tempfile::tempdir().expect("tempdir");
    let ruta = dir.path().join("abiertas.json");
    let desc = descartes::ruta_de(&ruta);
    let mut a = abierta(&id, Some(&sid), &cwd);
    a.cola.clear();
    descartes::guardar(&desc, &[a]).expect("guardar");
    let (r, activa) = restaurar_desde(&ruta, &projects);
    assert!(r.is_empty() && activa);
    assert!(!desc.exists(), "no se vuelve a apartar");
}

/// Una sesión descartada por una carpeta inaccesible se aparta con su cola
/// en `abiertas.descartadas.json` y se restaura en el arranque siguiente, en
/// cuanto la carpeta vuelve; entonces sale del fichero.
#[test]
fn una_sesion_con_la_carpeta_inaccesible_se_aparta_y_se_reintenta() {
    let sid = uuid::Uuid::new_v4().to_string();
    let id = format!("apart-{}", uuid::Uuid::new_v4());
    let (_d, cwd, projects) = entorno(&sid, true);
    let dir = tempfile::tempdir().expect("tempdir");
    let ruta = dir.path().join("abiertas.json");
    let desc = descartes::ruta_de(&ruta);
    let mut a = abierta(&id, Some(&sid), "Z:/unidad/sin/montar");
    a.config = None;
    let f = Fichero {
        version: VERSION,
        sesiones: vec![a.clone()],
    };
    escribir_atomico(&ruta, &serde_json::to_string(&f).expect("json")).expect("escribir");
    let (r, activa) = restaurar_desde(&ruta, &projects);
    assert!(r.is_empty() && activa);
    let apartadas = descartes::leer_apartadas(&desc).expect("leer");
    assert_eq!(apartadas.len(), 1, "apartada con su cola");
    assert_eq!(apartadas[0].cola.len(), a.cola.len());
    // abiertas.json ya no la tiene (el escritor la reescribiría sin ella),
    // pero el arranque siguiente la reintenta con la carpeta de vuelta.
    std::fs::remove_file(&ruta).expect("borrar");
    let mut vuelta = apartadas[0].clone();
    vuelta.cwd = cwd.clone();
    descartes::guardar(&desc, &[vuelta]).expect("guardar");
    let (r, _) = restaurar_desde(&ruta, &projects);
    assert_eq!(r.len(), 1, "restaurada al volver la carpeta");
    assert!(!desc.exists(), "sale del fichero de descartes");
    limpiar(&id);
}

/// Caso negativo: un descarte permanente (sin conversación) no se aparta.
#[test]
fn un_descarte_sin_conversacion_no_se_aparta() {
    let (_d, cwd, projects) = entorno(SID, false);
    let dir = tempfile::tempdir().expect("tempdir");
    let ruta = dir.path().join("abiertas.json");
    let f = Fichero {
        version: VERSION,
        sesiones: vec![abierta("sin-sid", None, &cwd)],
    };
    escribir_atomico(&ruta, &serde_json::to_string(&f).expect("json")).expect("escribir");
    let (r, _) = restaurar_desde(&ruta, &projects);
    assert!(r.is_empty());
    assert!(!descartes::ruta_de(&ruta).exists());
}

/// Si la cola no se puede reponer, el chat de la sesión lo dice con cuántos
/// mensajes no entraron (antes solo quedaba un log).
#[test]
fn reponer_con_la_cola_envenenada_avisa_en_el_chat() {
    let id = format!("repo-{}", uuid::Uuid::new_v4());
    let c = Colas::default();
    c.envenenar();
    let items = vec![
        item("q1", QueueState::Queued),
        item("q2", QueueState::Queued),
    ];
    assert_eq!(restaurar::reponer_con_aviso(&c, &id, items.clone()), 0);
    let notas = tomar_avisos(&id);
    assert_eq!(notas.len(), 1);
    assert_eq!(notas[0].0, "error");
    assert!(notas[0].1.contains("2 mensaje(s)"), "{}", notas[0].1);
    // Caso negativo: con la cola sana no hay nota de error.
    let sana = Colas::default();
    assert_eq!(restaurar::reponer_con_aviso(&sana, &id, items), 2);
    assert!(tomar_avisos(&id).is_empty());
}

#[test]
fn las_notas_se_entregan_una_sola_vez() {
    let sink = MockSink::opened();
    anotar_en(Some(&sink), "nota-1", "info", "hola".into());
    assert!(
        sink.payloads(ev::NOTICE).is_empty(),
        "antes del historial queda pendiente"
    );
    entregar_avisos_en(Some(&sink), "nota-1");
    assert_eq!(sink.payloads(ev::NOTICE).len(), 1);
    entregar_avisos_en(Some(&sink), "nota-1");
    assert_eq!(sink.payloads(ev::NOTICE).len(), 1, "no se repite");
    anotar("nota-2", "warn", "adiós".into());
    assert_eq!(tomar_avisos("nota-2"), vec![("warn", "adiós".to_string())]);
    olvidar_avisos("nota-1");
}

/// El fallo de un relanzamiento llega después de que la ventana cargara el
/// historial: se emite en el acto, no se queda en el mapa.
#[test]
fn una_nota_tras_la_entrega_se_emite_en_el_acto() {
    let sink = MockSink::opened();
    entregar_avisos_en(Some(&sink), "nota-3");
    anotar_en(Some(&sink), "nota-3", "error", "No se pudo relanzar".into());
    let p = sink.payloads(ev::NOTICE);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0]["level"], "error");
    assert_eq!(p[0]["text"], "No se pudo relanzar");
    assert!(tomar_avisos("nota-3").is_empty());
    // Con la ventana cerrada espera a la próxima carga del historial.
    sink.open.store(false, std::sync::atomic::Ordering::SeqCst);
    anotar_en(Some(&sink), "nota-3", "error", "otra".into());
    assert_eq!(sink.payloads(ev::NOTICE).len(), 1);
    sink.open.store(true, std::sync::atomic::Ordering::SeqCst);
    entregar_avisos_en(Some(&sink), "nota-3");
    assert_eq!(sink.payloads(ev::NOTICE).len(), 2);
    // Cerrar la sesión olvida la entrega: la siguiente nota vuelve a esperar.
    olvidar_avisos("nota-3");
    anotar_en(Some(&sink), "nota-3", "info", "tras cerrar".into());
    assert_eq!(sink.payloads(ev::NOTICE).len(), 2);
    assert_eq!(tomar_avisos("nota-3").len(), 1);
}

/// El escritor solo se activa tras leer el fichero (o si no existe o se
/// apartó): un fichero ilegible no se pisa.
#[test]
fn solo_se_escribe_despues_de_haber_leido() {
    let d = tempfile::tempdir().expect("tempdir");
    let projects = d.path().join("projects");
    let ilegible = d.path().join("ilegible.json");
    std::fs::create_dir_all(ilegible.join("dentro")).expect("dir");
    assert_eq!(restaurar_desde(&ilegible, &projects), (Vec::new(), false));
    assert!(ilegible.join("dentro").is_dir(), "no se tocó");
    let falta = d.path().join("falta.json");
    assert_eq!(restaurar_desde(&falta, &projects), (Vec::new(), true));
    let danado = d.path().join("danado.json");
    std::fs::write(&danado, "[").expect("escribir");
    assert_eq!(restaurar_desde(&danado, &projects), (Vec::new(), true));
    assert!(d.path().join("danado.json.bad").is_file());
}

#[test]
fn sin_activar_no_hay_ruta_ni_escritor_en_los_tests() {
    assert!(ruta().is_none());
    marcar();
    assert!(
        ESCRITOR.get().is_none(),
        "nada activa el escritor en los tests"
    );
}

/// Salida de ULTRON: sin escritor activo (tests, arranque que no leyó el
/// fichero) `volcar_ya` no escribe nada (caso negativo).
#[test]
fn volcar_ya_sin_escritor_no_escribe() {
    assert!(ESCRITOR.get().is_none(), "en los tests nunca hay escritor");
    assert!(!volcar_ya());
}

/// Con escritor, el volcado de la salida escribe la proyección en el acto,
/// sin esperar la calma del hilo.
#[test]
fn el_volcado_de_salida_escribe_sin_esperar_la_calma() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ruta = dir.path().join("abiertas.json");
    let e = Escritor::nuevo(channel().0, ruta.clone());
    assert!(e.volcar_en_salida(ESPERA_SALIDA));
    let Ok(Lectura::Leida(f)) = leer(&ruta) else {
        panic!("abiertas.json no quedó escrito");
    };
    assert_eq!(f.version, VERSION);
    assert!(
        e.ultima.lock().expect("ultima").is_some(),
        "recuerda lo escrito"
    );
}

/// Si el hilo escritor está a mitad de una escritura, la salida espera como
/// mucho el plazo y renuncia sin escribir (no bloquea el cierre).
#[test]
fn el_volcado_de_salida_no_espera_mas_del_plazo() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ruta = dir.path().join("abiertas.json");
    let e = Escritor::nuevo(channel().0, ruta.clone());
    let ocupado = e.ultima.lock().expect("ultima");
    let t = Instant::now();
    assert!(!e.volcar_en_salida(Duration::from_millis(30)));
    assert!(
        t.elapsed() < Duration::from_millis(500),
        "{:?}",
        t.elapsed()
    );
    assert!(!ruta.exists(), "no escribe con el escritor ocupado");
    drop(ocupado);
}

/// Una proyección que no se pudo calcular (lock envenenado) no sustituye el
/// fichero: se conserva lo que había y se devuelve la última escrita.
#[test]
fn una_proyeccion_fallida_no_sustituye_el_fichero() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ruta = dir.path().join("abiertas.json");
    let bueno = Fichero {
        version: VERSION,
        sesiones: vec![abierta("s1", Some(SID), "C:/x")],
    };
    let texto = serde_json::to_string_pretty(&bueno).expect("json");
    escribir_atomico(&ruta, &texto).expect("escribir");
    let r = volcar_proyeccion(&ruta, Some(texto.clone()), Err("envenenado".into()));
    assert_eq!(r.as_deref(), Some(texto.as_str()));
    let Ok(Lectura::Leida(f)) = leer(&ruta) else {
        panic!("abiertas.json desapareció");
    };
    assert_eq!(f.sesiones.len(), 1, "conserva la sesión guardada");
    // Caso negativo: con una proyección válida (vacía) sí se escribe.
    let vacio = Fichero {
        version: VERSION,
        sesiones: Vec::new(),
    };
    let r = volcar_proyeccion(&ruta, Some(texto), Ok(vacio));
    assert!(r.is_some_and(|t| t.contains("\"sesiones\": []")));
    FALLANDO.store(false, Ordering::Relaxed);
}
