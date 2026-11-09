// sesiones/tests_puente_v2.rs — Protocolo 2 del puente sobre un servidor
// real: token por sesión (403), generaciones y `stale`, `seq`, tolerancia a
// tipos desconocidos, ask asíncrono con sondeo, buzón, protocolo 1 y cupos
// (contrato de estabilidad, §6.1-§6.4, §8.4).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::buzon::{self, InboxOp};
use super::preguntas::Broker;
use super::puente::{self, PuenteHandler, PuenteInfo, RouteError};
use super::puente_eventos::{pausa_hello, SesionesPuente};
use super::registro;
use super::test_sink::MockSink;
use super::tests_puente::{bearer, post};
use super::types::{ev, AskAnswer, PermissionDecision};
use std::sync::mpsc::{channel, Receiver, Sender};

struct Banco {
    info: PuenteInfo,
    sink: Arc<MockSink>,
    broker: Arc<Broker>,
}

fn banco() -> Banco {
    banco_con_espera(Duration::from_millis(300))
}

/// Banco con el plazo de los sondeos largos explícito.
fn banco_con_espera(espera: Duration) -> Banco {
    let sink = Arc::new(MockSink::opened());
    let broker = Arc::new(Broker::new());
    let mut h = SesionesPuente::new(sink.clone(), broker.clone());
    h.espera = espera;
    let info = puente::start(Arc::new(h)).expect("puente");
    Banco { info, sink, broker }
}

fn sesion() -> String {
    let id = format!("pv2-{}", uuid::Uuid::new_v4());
    registro::insert(registro::sesion_de_prueba(&id)).expect("alta");
    id
}

fn hello(b: &Banco, id: &str, protocolo: Option<u8>) -> Value {
    let mut body = json!({ "sesionId": id, "claudeSessionId": "", "source": "start" });
    if let Some(p) = protocolo {
        body["protocol"] = json!(p);
    }
    let (status, v) = post(&b.info, "/v1/hello", Some(&bearer(id)), &body);
    assert_eq!(status, 200, "{v}");
    v
}

#[test]
fn token_de_una_sesion_con_el_id_de_otra_es_403() {
    let b = banco();
    let (a, c) = (sesion(), sesion());
    let body = json!({ "sesionId": c, "events": [] });
    assert_eq!(post(&b.info, "/v1/events", Some(&bearer(&a)), &body).0, 403);
    assert_eq!(post(&b.info, "/v1/events", Some(&bearer(&c)), &body).0, 200);
}

#[test]
fn hello_v2_sube_la_generacion_y_la_vieja_es_stale_al_momento() {
    // Sondeo largo de 8 s: si `inbox` o `ask/wait` esperasen, las dos
    // peticiones tardarían al menos 16 s. El tope de la prueba es una sola
    // espera, holgado frente a la carga de la CI (antes 250 ms frente a un
    // sondeo de 300 ms, que fallaba con la CPU saturada).
    let espera = Duration::from_secs(8);
    let b = banco_con_espera(espera);
    let id = sesion();
    let v = hello(&b, &id, Some(2));
    assert_eq!(
        (v["protocol"].as_u64(), v["generation"].as_u64()),
        (Some(2), Some(1))
    );
    assert!(v.get("launchPermissionMode").is_some());
    // `interceptPanels` se retiró: el puente nunca lo leyó.
    assert!(v.get("interceptPanels").is_none());
    assert_eq!(hello(&b, &id, Some(2))["generation"], 2);
    let t = Instant::now();
    let auth = bearer(&id);
    let (_, inbox) = post(
        &b.info,
        "/v1/inbox",
        Some(&auth),
        &json!({ "sesionId": id, "generation": 1 }),
    );
    let (_, wait) = post(
        &b.info,
        "/v1/ask/wait",
        Some(&auth),
        &json!({ "sesionId": id, "generation": 1, "askIds": ["x"] }),
    );
    assert_eq!(
        (inbox, wait),
        (json!({ "stale": true }), json!({ "stale": true }))
    );
    assert!(t.elapsed() < espera, "sin esperar el sondeo");
    assert_eq!(
        registro::read(&id, |s| s.info.bridge_protocol).ok(),
        Some(2)
    );
}

#[test]
fn lote_de_una_generacion_anterior_es_stale_con_la_vigente_y_no_se_pierde() {
    let b = banco();
    let id = sesion();
    hello(&b, &id, Some(2));
    hello(&b, &id, Some(2));
    let auth = bearer(&id);
    let evento = json!({ "type": "notice", "seq": 7, "level": "info", "text": "fin" });
    let viejo = json!({ "sesionId": id, "generation": 1, "events": [evento] });
    let (status, r) = post(&b.info, "/v1/events", Some(&auth), &viejo);
    assert_eq!(status, 200);
    assert_eq!(
        r,
        json!({ "stale": true, "generation": 2 }),
        "no se responde ok a un lote descartado"
    );
    assert!(b.sink.payloads(ev::NOTICE).is_empty());
    let reenviado = json!({ "type": "notice", "seq": 1, "level": "info", "text": "fin" });
    let nuevo = json!({ "sesionId": id, "generation": 2, "events": [reenviado] });
    let (_, r) = post(&b.info, "/v1/events", Some(&auth), &nuevo);
    assert_eq!(r, json!({ "ok": true }));
    assert_eq!(b.sink.payloads(ev::NOTICE).len(), 1, "el reenvío se aplica");
}

#[test]
fn hello_hacia_un_transcript_inexistente_queda_provisional() {
    let b = banco();
    let id = sesion();
    let base = registro::claude_projects_dir().expect("home");
    let previo = base.join("demo").join("previo.jsonl");
    registro::update(&id, |s| {
        s.transcript = Some(previo.clone());
        s.sid_confirmed = true;
        (false, ())
    })
    .expect("fijar");
    let ajeno = base
        .join("demo")
        .join(format!("{}.jsonl", uuid::Uuid::new_v4()));
    let body = json!({
        "sesionId": id, "protocol": 2, "claudeSessionId": uuid_de("ajeno"), "source": "start",
        "transcriptPath": ajeno.to_string_lossy(),
    });
    let (status, _) = post(&b.info, "/v1/hello", Some(&bearer(&id)), &body);
    assert_eq!(status, 200);
    let (t, confirmado) =
        registro::read(&id, |s| (s.transcript.clone(), s.sid_confirmed)).expect("leer");
    assert_eq!(t, Some(ajeno));
    assert!(!confirmado, "sin fichero, el sid no queda confirmado");
}

#[test]
fn tipo_desconocido_no_tumba_el_lote_y_el_seq_repetido_se_descarta() {
    let b = banco();
    let id = sesion();
    hello(&b, &id, Some(2));
    let lote = json!({ "sesionId": id, "generation": 1, "events": [
        { "type": "algoNuevo", "seq": 1, "x": 1 },
        { "seq": 2 },
        { "type": "notice", "seq": 3, "level": "info", "text": "a" },
        { "type": "notice", "seq": 3, "level": "info", "text": "repetido" },
        { "type": "composerFill", "seq": 4, "text": "hola", "mode": "append", "from": "ultron-relevo" },
        { "type": "panel", "seq": 5, "panel": "git" }
    ]});
    let (status, _) = post(&b.info, "/v1/events", Some(&bearer(&id)), &lote);
    assert_eq!(status, 200);
    let avisos = b.sink.payloads(ev::NOTICE);
    assert_eq!(avisos.len(), 1);
    assert_eq!(avisos[0]["text"], "a");
    let fill = b.sink.payloads(ev::COMPOSER_FILL);
    assert_eq!(fill[0]["mode"], "append");
    // La ruta `panel` se retiró (sin productor): ya no reemite nada.
    assert!(b.sink.payloads("sesiones://panel").is_empty());
    let otra = json!({ "sesionId": id, "generation": 1, "events": [
        { "type": "notice", "seq": 2, "level": "info", "text": "viejo" }
    ]});
    post(&b.info, "/v1/events", Some(&bearer(&id)), &otra);
    assert_eq!(
        b.sink.payloads(ev::NOTICE).len(),
        1,
        "seq ≤ último aplicado"
    );
}

#[test]
fn commands_guarda_la_lista_viva_y_la_emite() {
    let b = banco();
    let id = sesion();
    hello(&b, &id, Some(2));
    let lote = json!({ "sesionId": id, "generation": 1, "events": [{ "type": "commands", "items": [
        { "name": "codex:rescue", "description": "x", "source": "plugin", "plugin": "codex" },
        { "name": "config", "description": "Ajustes", "source": "builtin" }
    ]}]});
    post(&b.info, "/v1/events", Some(&bearer(&id)), &lote);
    let viva = super::catalogo::lista_viva(&id).expect("lista viva");
    assert_eq!(viva.len(), 2);
    assert_eq!(b.sink.payloads(ev::COMMANDS)[0]["id"], id.as_str());
}

#[test]
fn ask_asincrono_con_sondeo_multiplexado() {
    let b = banco();
    let id = sesion();
    hello(&b, &id, Some(2));
    let auth = bearer(&id);
    let ask = json!({ "kind": "permission", "tool": "Bash", "input": {}, "summary": "ls" });
    let (_, r) = post(
        &b.info,
        "/v1/ask",
        Some(&auth),
        &json!({ "sesionId": id, "ask": ask, "async": true }),
    );
    let ask_id = r["askId"].as_str().expect("askId").to_string();
    let espera = json!({ "sesionId": id, "generation": 1, "askIds": [ask_id] });
    let (_, w) = post(&b.info, "/v1/ask/wait", Some(&auth), &espera);
    assert_eq!(w["results"][0]["status"], "pending");
    let respuesta = AskAnswer::Permission {
        decision: PermissionDecision::Allow,
        reason: None,
    };
    b.broker
        .answer(&*b.sink, &ask_id, respuesta)
        .expect("responder");
    let (_, w) = post(&b.info, "/v1/ask/wait", Some(&auth), &espera);
    assert_eq!(w["results"][0]["status"], "answered");
    assert_eq!(w["results"][0]["answer"]["decision"], "allow");
}

#[test]
fn hello_sin_protocolo_es_v1_y_el_ask_bloqueante_sigue() {
    let b = Arc::new(banco());
    let id = sesion();
    let v = hello(&b, &id, None);
    assert_eq!(v["ok"], true);
    assert_eq!(
        registro::read(&id, |s| s.info.bridge_protocol).ok(),
        Some(1)
    );
    assert!(buzon::encolar_op(
        &id,
        InboxOp::CommandList {
            op_id: String::new()
        }
    )
    .is_err());
    let (b2, id2) = (b.clone(), id.clone());
    let h = std::thread::spawn(move || {
        let ask = json!({ "kind": "permission", "tool": "Bash", "input": {}, "summary": "ls" });
        post(
            &b2.info,
            "/v1/ask",
            Some(&bearer(&id2)),
            &json!({ "sesionId": id2, "ask": ask }),
        )
    });
    let ask_id = loop {
        if let Some(p) = b.broker.pending_for(&id).first() {
            break p.ask_id.clone();
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let deny = AskAnswer::Permission {
        decision: PermissionDecision::Deny,
        reason: None,
    };
    b.broker.answer(&*b.sink, &ask_id, deny).expect("responder");
    let (status, r) = h.join().expect("hilo");
    assert_eq!(
        (status, r["answer"]["decision"].as_str()),
        (200, Some("deny"))
    );
}

#[test]
fn buzon_por_inbox_y_result() {
    let b = banco();
    let id = sesion();
    hello(&b, &id, Some(2));
    let op_id = buzon::encolar_op(
        &id,
        InboxOp::ConfigList {
            op_id: String::new(),
        },
    )
    .expect("encolar");
    let auth = bearer(&id);
    let (_, r) = post(
        &b.info,
        "/v1/inbox",
        Some(&auth),
        &json!({ "sesionId": id, "generation": 1 }),
    );
    assert_eq!(r["ops"][0]["opId"], op_id.as_str());
    assert_eq!(r["ops"][0]["op"], "config.list");
    let res = json!({ "sesionId": id, "opId": op_id, "ok": true, "value": [] });
    assert_eq!(post(&b.info, "/v1/result", Some(&auth), &res).0, 200);
    let got = buzon::esperar_resultado(&op_id, Duration::from_secs(1)).expect("resultado");
    assert!(got.ok);
    let (_, r) = post(
        &b.info,
        "/v1/inbox",
        Some(&auth),
        &json!({ "sesionId": id, "generation": 1 }),
    );
    assert_eq!(r["ops"], json!([]), "con resultado no vuelve");
}

/// Manejador que retiene los `hello` hasta liberarlos.
struct Retenedor {
    dentro: AtomicUsize,
    suelta: (Mutex<bool>, Condvar),
}

impl PuenteHandler for Retenedor {
    fn hello(&self, _: Value) -> Result<Value, RouteError> {
        self.dentro.fetch_add(1, Ordering::SeqCst);
        let (m, cv) = &self.suelta;
        let g = m.lock().map_err(|_| RouteError::bad_request("lock"))?;
        let _g = cv
            .wait_while(g, |libre| !*libre)
            .map_err(|_| RouteError::bad_request("lock"))?;
        Ok(json!({ "ok": true }))
    }
    fn events(&self, _: Value) -> Result<Value, RouteError> {
        Ok(json!({ "ok": true }))
    }
    fn ask(&self, _: Value) -> Result<Value, RouteError> {
        Ok(json!({}))
    }
    fn ask_wait(&self, _: Value) -> Result<Value, RouteError> {
        Ok(json!({}))
    }
    fn ask_cancel(&self, _: Value) -> Result<Value, RouteError> {
        Ok(json!({}))
    }
    fn inbox(&self, _: Value) -> Result<Value, RouteError> {
        Ok(json!({}))
    }
    fn result(&self, _: Value) -> Result<Value, RouteError> {
        Ok(json!({}))
    }
    fn fill(&self, _: Value) -> Result<Value, RouteError> {
        Ok(json!({}))
    }
}

/// Tope de la prueba de cupos para que entren las 32 peticiones retenidas.
const PLAZO_LLENADO: Duration = Duration::from_secs(60);
/// Plazo de transporte de las peticiones retenidas. Siguen abiertas mientras
/// se llena el cupo y se prueban la 33, `events` e `inbox`; con el plazo de
/// 10 s de `post`, en windows-latest con la suite en paralelo vencían antes
/// de soltarlas (os error 10060, run 39983678468). Ha de superar el llenado
/// más las tres peticiones de control; solo existe para que la prueba no se
/// cuelgue si el servidor deja de contestar.
const PLAZO_RETENIDAS: Duration = Duration::from_secs(180);

/// Petición retenida de la prueba de cupos. Un fallo al CONECTAR (antes de
/// enviar un solo byte, así que el servidor no la ha visto) se reintenta: en
/// windows-latest con la suite en paralelo, una de las 32 se quedó fuera y la
/// prueba esperó los 60 s del llenado (run de a8dff12ee, 31 de 32). Cualquier
/// otro error se devuelve como texto para que el assert lo enseñe.
fn post_retenida(info: &PuenteInfo, id: &str) -> Result<u16, String> {
    let url = format!("{}/v1/hello", info.url);
    let body = json!({ "sesionId": id });
    let mut ultimo = String::new();
    for _ in 0..5 {
        let req = ureq::post(&url)
            .timeout(PLAZO_RETENIDAS)
            .set("Authorization", &bearer(id));
        match req.send_json(body.clone()) {
            Ok(r) => return Ok(r.status()),
            Err(ureq::Error::Status(s, _)) => return Ok(s),
            Err(ureq::Error::Transport(t)) if t.kind() == ureq::ErrorKind::ConnectionFailed => {
                ultimo = t.to_string();
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("transporte: {e}")),
        }
    }
    Err(format!("sin conexión tras 5 intentos: {ultimo}"))
}

#[test]
fn la_peticion_33_de_control_es_503_y_events_sigue_respondiendo() {
    let h = Arc::new(Retenedor {
        dentro: AtomicUsize::new(0),
        suelta: (Mutex::new(false), Condvar::new()),
    });
    let info = Arc::new(puente::start(h.clone()).expect("puente"));
    let id = "cupos-sesion";
    let hilos: Vec<_> = (0..32)
        .map(|_| {
            let i = info.clone();
            std::thread::spawn(move || post_retenida(&i, id))
        })
        .collect();
    let t = Instant::now();
    while h.dentro.load(Ordering::SeqCst) < 32
        && t.elapsed() < PLAZO_LLENADO
        && !hilos.iter().any(|x| x.is_finished())
    {
        std::thread::sleep(Duration::from_millis(10));
    }
    let dentro = h.dentro.load(Ordering::SeqCst);
    if dentro != 32 {
        // Una retenida que acaba antes de soltarlas es el fallo: se dice cuál.
        let acabadas: Vec<String> = hilos
            .into_iter()
            .filter(|x| x.is_finished())
            .map(|x| format!("{:?}", x.join()))
            .collect();
        panic!("{dentro} de 32 retenidas dentro; acabadas antes de tiempo: {acabadas:?}");
    }
    let extra = post(
        &info,
        "/v1/hello",
        Some(&bearer(id)),
        &json!({ "sesionId": id }),
    );
    assert_eq!(extra.0, 503);
    let ev = post(
        &info,
        "/v1/events",
        Some(&bearer(id)),
        &json!({ "sesionId": id, "events": [] }),
    );
    assert_eq!(ev.0, 200, "events tiene su propio cupo");
    let sondeo = post(
        &info,
        "/v1/inbox",
        Some(&bearer(id)),
        &json!({ "sesionId": id, "generation": 1 }),
    );
    assert_eq!(sondeo.0, 200, "los sondeos largos tienen su propio cupo");
    {
        let (m, cv) = &h.suelta;
        *m.lock().expect("lock") = true;
        cv.notify_all();
    }
    for hilo in hilos {
        assert_eq!(hilo.join().expect("hilo"), Ok(200));
    }
}

fn hello_de(b: &Banco, id: &str, sid: &str, source: &str) -> (u16, Value) {
    let body =
        json!({ "sesionId": id, "protocol": 2, "claudeSessionId": uuid_de(sid), "source": source });
    post(&b.info, "/v1/hello", Some(&bearer(id)), &body)
}

/// Un `claude` interactivo lanzado desde dentro de la sesión hereda
/// `ULTRON_PUENTE_*` y `ULTRON_SESION_ID`, dibuja en `terminal` y manda su
/// propio `hello` de arranque: antes cambiaba el `claudeSessionId`, apuntaba
/// el chat a un transcript vacío («Sesión lista», sin historial) y dejaba
/// `stale` los lotes de la TUI real. Dentro del mismo PTY, un segundo `hello`
/// de arranque con otro sid se rechaza; `/clear`, `/resume` y un reinicio
/// (PTY nuevo) siguen cambiando de conversación.
#[test]
fn hello_de_arranque_ajeno_en_el_mismo_pty_no_cambia_la_conversacion() {
    let b = banco();
    let id = sesion();
    registro::update(&id, |s| {
        s.pty_id = "pty-a".into();
        (false, ())
    })
    .expect("pty");
    let (st, v) = anuncio(&b, &id, "sid-real", "start", "padre", 1);
    assert_eq!((st, v["generation"].clone()), (200, json!(1)));
    let (st, _) = anuncio(&b, &id, "sid-ajeno", "start", "hijo", 1);
    assert_eq!(st, 409, "el arranque ajeno se rechaza");
    let sid = registro::read(&id, |s| s.info.claude_session_id.clone()).expect("leer");
    assert_eq!(sid.as_deref(), Some(uuid_de("sid-real").as_str()));
    let (st, v) = anuncio(&b, &id, "sid-real", "turn", "padre", 2);
    assert_eq!(
        (st, v["generation"].clone()),
        (200, json!(2)),
        "el ajeno no gastó generación"
    );
    // Caso negativo: los cambios legítimos de conversación pasan.
    assert_eq!(anuncio(&b, &id, "sid-clear", "clear", "padre", 3).0, 200);
    registro::update(&id, |s| {
        s.pty_id = "pty-b".into();
        (false, ())
    })
    .expect("reinicio");
    assert_eq!(anuncio(&b, &id, "sid-reinicio", "start", "nuevo", 1).0, 200);
    let sid = registro::read(&id, |s| s.info.claude_session_id.clone()).expect("leer");
    assert_eq!(sid.as_deref(), Some(uuid_de("sid-reinicio").as_str()));
}

/// `hello` de una instancia del mod (`instanceId`) con su `helloSeq`.
fn anuncio(b: &Banco, id: &str, sid: &str, source: &str, inst: &str, seq: u64) -> (u16, Value) {
    let body = json!({
        "sesionId": id, "protocol": 2, "claudeSessionId": uuid_de(sid), "source": source,
        "instanceId": inst, "helloSeq": seq,
    });
    post(&b.info, "/v1/hello", Some(&bearer(id)), &body)
}

fn sesion_en_pty(pty: &str) -> String {
    let id = sesion();
    registro::update(&id, |s| {
        s.pty_id = pty.into();
        (false, ())
    })
    .expect("pty");
    id
}

fn sid_de(id: &str) -> Option<String> {
    registro::read(id, |s| s.info.claude_session_id.clone()).expect("leer")
}

/// UUID determinista de un nombre de prueba (`sid-a`, `sid-hijo`…): el puente
/// solo acepta un `claudeSessionId` con formato UUID.
fn uuid_de(nombre: &str) -> String {
    let h = nombre.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    });
    format!("00000000-0000-4000-8000-{:012x}", h & 0xffff_ffff_ffff)
}

#[path = "tests_puente_seguridad.rs"]
mod seguridad;

/// Tras el 409 del arranque ajeno, el hijo no puede colarse por detrás: sus
/// lotes de generación 0 se respondían `stale` con la vigente y el mod los
/// reenviaba renumerados (turnos del hijo en el chat del padre), y un `hello`
/// posterior suyo (`/clear` con otro sid, `compact`, `turn`) sustituía
/// transcript y dueño. El veto es de la instancia, no del sid.
#[test]
fn tras_el_rechazo_el_hijo_no_cuela_eventos_ni_hello() {
    let b = banco();
    let id = sesion_en_pty("pty-a");
    assert_eq!(anuncio(&b, &id, "sid-real", "start", "padre", 1).0, 200);
    assert_eq!(anuncio(&b, &id, "sid-hijo", "start", "hijo", 1).0, 409);
    let auth = bearer(&id);
    let evento = json!({ "type": "notice", "seq": 1, "level": "info", "text": "del hijo" });
    let lote = json!({ "sesionId": id, "generation": 0, "events": [evento] });
    let (st, r) = post(&b.info, "/v1/events", Some(&auth), &lote);
    assert_eq!(st, 409, "un lote de generación 0 no es stale: {r}");
    // La única nota es la del veto (ULTRON avisa de que hay un hijo); los
    // eventos del hijo no llegan.
    let del_hijo = || {
        b.sink
            .payloads(ev::NOTICE)
            .iter()
            .filter(|p| p["text"] == "del hijo")
            .count()
    };
    assert_eq!(del_hijo(), 0, "nada del hijo llega al chat");
    let posteriores = [
        ("sid-hijo-2", "clear"),
        ("sid-hijo", "compact"),
        ("sid-hijo", "turn"),
    ];
    for (seq, (sid, source)) in (2..).zip(posteriores) {
        assert_eq!(
            anuncio(&b, &id, sid, source, "hijo", seq).0,
            409,
            "{source}"
        );
    }
    let (sid, transcript) = registro::read(&id, |s| {
        (s.info.claude_session_id.clone(), s.transcript.clone())
    })
    .expect("leer");
    assert_eq!(sid.as_deref(), Some(uuid_de("sid-real").as_str()));
    // El historial (`gestor::history`) se lee de aquí: apuntado al transcript
    // del hijo, el chat quedaba vacío en «Sesión lista».
    assert!(
        transcript.is_some_and(|p| p.ends_with(format!("{}.jsonl", uuid_de("sid-real")))),
        "el transcript sigue siendo el del dueño"
    );
    // Caso negativo: el padre sigue con su generación y sus lotes se aplican.
    let (st, v) = anuncio(&b, &id, "sid-real", "turn", "padre", 2);
    assert_eq!((st, v["generation"].clone()), (200, json!(2)));
    let propio = json!({ "sesionId": id, "generation": 2, "events": [evento] });
    assert_eq!(
        post(&b.info, "/v1/events", Some(&auth), &propio).1,
        json!({ "ok": true })
    );
    assert_eq!(del_hijo(), 1);
}

/// El veto es del proceso hijo, no de su conversación: el dueño puede hacer
/// `/resume` del sid que tenía el hijo.
#[test]
fn el_dueno_puede_reanudar_el_sid_de_un_hijo_rechazado() {
    let b = banco();
    let id = sesion_en_pty("pty-a");
    assert_eq!(anuncio(&b, &id, "sid-a", "start", "padre", 1).0, 200);
    assert_eq!(anuncio(&b, &id, "sid-b", "start", "hijo", 1).0, 409);
    let (st, v) = anuncio(&b, &id, "sid-b", "resume", "padre", 2);
    assert_eq!((st, v["generation"].clone()), (200, json!(2)), "{v}");
    assert_eq!(sid_de(&id).as_deref(), Some(uuid_de("sid-b").as_str()));
    // Una recarga del mod en el padre (instancia nueva, mismo sid) también pasa.
    assert_eq!(
        anuncio(&b, &id, "sid-b", "start", "padre-recargado", 1).0,
        200
    );
}

/// `start(A)` aceptado con la respuesta perdida, después `clear(B)` y luego
/// el reintento de `start(A)`: el reintento ya no manda (sin 409 terminal ni
/// vuelta a A) y un reintento del anuncio vigente es idempotente.
#[test]
fn reintento_de_un_hello_sustituido_no_rechaza_al_dueno() {
    let b = banco();
    let id = sesion_en_pty("pty-a");
    assert_eq!(anuncio(&b, &id, "sid-a", "start", "padre", 1).0, 200);
    assert_eq!(anuncio(&b, &id, "sid-b", "clear", "padre", 2).0, 200);
    let (st, v) = anuncio(&b, &id, "sid-a", "start", "padre", 1);
    assert_eq!(st, 200, "{v}");
    assert_eq!(
        (v["superseded"].clone(), v["generation"].clone()),
        (json!(true), json!(2))
    );
    assert_eq!(sid_de(&id).as_deref(), Some(uuid_de("sid-b").as_str()));
    let (st, v) = anuncio(&b, &id, "sid-b", "clear", "padre", 2);
    assert_eq!(
        (st, v["generation"].clone()),
        (200, json!(2)),
        "repetido: misma generación"
    );
    assert!(v.get("superseded").is_none());
    let (_, v) = anuncio(&b, &id, "sid-b", "turn", "padre", 3);
    assert_eq!(v["generation"], 3, "el siguiente anuncio sí avanza");
}

/// Sin ningún `hello` aceptado (generación 0 en el backend), un lote de
/// generación 0 se sigue aplicando: el rechazo solo aplica con dueño.
#[test]
fn lote_de_generacion_cero_sin_hello_previo_se_aplica() {
    let b = banco();
    let id = sesion();
    let evento = json!({ "type": "notice", "seq": 1, "level": "info", "text": "x" });
    let lote = json!({ "sesionId": id, "generation": 0, "events": [evento] });
    assert_eq!(
        post(&b.info, "/v1/events", Some(&bearer(&id)), &lote).1,
        json!({ "ok": true })
    );
}

/// Un hijo con el mod anterior (sin `instanceId`) no tiene veto que lo
/// retenga: tras el 409 de su `start` mandaba `clear` con otro sid y se
/// quedaba con la sesión. Sin `instanceId`, un cambio de sid respecto al
/// dueño se rechaza sea cual sea el `source`.
#[test]
fn hijo_con_mod_antiguo_no_recupera_la_sesion_tras_el_rechazo() {
    let b = banco();
    let id = sesion_en_pty("pty-a");
    assert_eq!(anuncio(&b, &id, "sid-a", "start", "padre", 1).0, 200);
    assert_eq!(hello_de(&b, &id, "sid-b", "start").0, 409);
    for source in ["clear", "resume", "turn"] {
        let (st, v) = hello_de(&b, &id, "sid-c", source);
        assert_eq!(st, 409, "{source}: {v}");
    }
    assert_eq!(sid_de(&id).as_deref(), Some(uuid_de("sid-a").as_str()));
    // Caso negativo: sin cambio de sid (el dueño antiguo en su turno) pasa.
    assert_eq!(hello_de(&b, &id, "sid-a", "turn").0, 200);
}

/// Detiene el `hello` `source` de la sesión justo tras su veredicto hasta
/// que el test lo suelte; avisa por `entra` al llegar (solo la primera vez).
fn pausar_hello(id: &str, source: &'static str) -> (Receiver<()>, Sender<()>) {
    let (entra_tx, entra_rx) = channel();
    let (sigue_tx, sigue_rx) = channel::<()>();
    let sigue_rx = Mutex::new(sigue_rx);
    let primera = std::sync::atomic::AtomicBool::new(true);
    pausa_hello::poner(
        id,
        Arc::new(move |s: &str| {
            if s != source || !primera.swap(false, Ordering::SeqCst) {
                return;
            }
            let _ = entra_tx.send(());
            let rx = sigue_rx.lock().expect("lock");
            let _ = rx.recv_timeout(Duration::from_secs(5));
        }),
    );
    (entra_rx, sigue_tx)
}

fn anuncio_en_hilo(
    b: &Banco,
    id: &str,
    sid: &'static str,
    source: &'static str,
    seq: u64,
) -> std::thread::JoinHandle<(u16, Value)> {
    let info = b.info.clone();
    let id = id.to_string();
    std::thread::spawn(move || {
        let body = json!({
            "sesionId": id, "protocol": 2, "claudeSessionId": uuid_de(sid), "source": source,
            "instanceId": "padre", "helloSeq": seq,
        });
        post(&info, "/v1/hello", Some(&bearer(&id)), &body)
    })
}

/// `start(A,1)` acepta su veredicto y se detiene; `clear(B,2)` llega entonces.
/// Antes `clear` se aplicaba entero en la pausa y `start` reinstalaba
/// después el sid y el transcript de A con el dueño ya en B/2.
#[test]
fn hello_solapados_se_aplican_en_orden_por_sesion() {
    let b = banco();
    let id = sesion_en_pty("pty-a");
    let (entra, sigue) = pausar_hello(&id, "start");
    let start = anuncio_en_hilo(&b, &id, "sid-a", "start", 1);
    entra
        .recv_timeout(Duration::from_secs(5))
        .expect("start llega al veredicto");
    let clear = anuncio_en_hilo(&b, &id, "sid-b", "clear", 2);
    std::thread::sleep(Duration::from_millis(150));
    sigue.send(()).expect("soltar");
    let (st_start, v_start) = start.join().expect("start");
    let (st_clear, v_clear) = clear.join().expect("clear");
    pausa_hello::quitar(&id);
    assert_eq!((st_start, v_start["generation"].clone()), (200, json!(1)));
    assert_eq!((st_clear, v_clear["generation"].clone()), (200, json!(2)));
    let (sid, transcript) = registro::read(&id, |s| {
        (s.info.claude_session_id.clone(), s.transcript.clone())
    })
    .expect("leer");
    assert_eq!(sid.as_deref(), Some(uuid_de("sid-b").as_str()));
    assert!(transcript.is_some_and(|p| p.ends_with(format!("{}.jsonl", uuid_de("sid-b")))));
}

/// Dos anuncios idénticos a la vez: el duplicado espera a la aplicación del
/// original y responde su generación, no la anterior.
#[test]
fn hello_duplicado_concurrente_espera_al_original() {
    let b = banco();
    let id = sesion_en_pty("pty-a");
    let (entra, sigue) = pausar_hello(&id, "start");
    let original = anuncio_en_hilo(&b, &id, "sid-a", "start", 1);
    entra
        .recv_timeout(Duration::from_secs(5))
        .expect("el original llega al veredicto");
    let duplicado = anuncio_en_hilo(&b, &id, "sid-a", "start", 1);
    std::thread::sleep(Duration::from_millis(150));
    sigue.send(()).expect("soltar");
    let (st_o, v_o) = original.join().expect("original");
    let (st_d, v_d) = duplicado.join().expect("duplicado");
    pausa_hello::quitar(&id);
    assert_eq!((st_o, v_o["generation"].clone()), (200, json!(1)));
    assert_eq!((st_d, v_d["generation"].clone()), (200, json!(1)), "{v_d}");
}
