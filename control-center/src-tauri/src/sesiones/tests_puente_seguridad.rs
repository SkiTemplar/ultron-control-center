// sesiones/tests_puente_seguridad.rs — Defensa del puente frente a procesos
// que heredan el token de la sesión: hijos con otro `claudeSessionId`, sids
// que no son UUID, operaciones y asks de otra sesión, lotes sin generación y
// estructuras acotadas (vetos y asks pendientes).

use serde_json::{json, Value};

use super::super::agentes;
use super::super::buzon::{self, InboxOp};
use super::super::preguntas::{Broker, MAX_ASKS_SESION};
use super::super::puente_eventos::{bajo_base, envenenar_puentes, vetadas, AVISO_VETO};
use super::super::registro;
use super::super::test_sink::MockSink;
use super::super::tests_puente::{bearer, post};
use super::super::types::ev;
use super::{anuncio, banco, hello, sesion, sesion_en_pty, sid_de, uuid_de};

/// El veto solo actuaba si el primer `hello` del hijo era `start`: un
/// `claude --resume` lanzado dentro del PTY anuncia también `resume` y, si
/// ese llegaba antes, el hijo pasaba a ser el dueño.
#[test]
fn resume_de_otra_instancia_con_otro_sid_es_409_y_queda_vetada() {
    let b = banco();
    let id = sesion_en_pty("pty-a");
    assert_eq!(anuncio(&b, &id, "sid-a", "start", "padre", 1).0, 200);
    for (seq, source) in (1..).zip(["resume", "clear", "compact", "fork", "turn"]) {
        let (st, v) = anuncio(&b, &id, "sid-hijo", source, "hijo", seq);
        assert_eq!(st, 409, "{source}: {v}");
    }
    assert_eq!(sid_de(&id).as_deref(), Some(uuid_de("sid-a").as_str()));
    assert_eq!(anuncio(&b, &id, "sid-hijo", "start", "hijo", 9).0, 409);
    // Caso negativo: una recarga del mod del dueño (mismo sid) sigue pasando.
    assert_eq!(
        anuncio(&b, &id, "sid-a", "start", "padre-recargado", 1).0,
        200
    );
}

/// Un `hello` de otra instancia sin `claudeSessionId` (o vacío) se aceptaba
/// con dueño en el PTY: repuntaba el transcript al `transcriptPath` del hijo y
/// subía la generación, con la que sus lotes pasaban `admitir`.
#[test]
fn hello_ajeno_sin_sid_con_dueno_es_409_y_no_toca_transcript_ni_generacion() {
    let b = banco();
    let id = sesion_en_pty("pty-a");
    assert_eq!(anuncio(&b, &id, "sid-a", "start", "padre", 1).0, 200);
    let antes = registro::read(&id, |s| s.transcript.clone()).expect("leer");
    let base = registro::claude_projects_dir().expect("home");
    let del_hijo = base
        .join("demo")
        .join(format!("{}.jsonl", uuid_de("sid-hijo")));
    let ruta = del_hijo.to_string_lossy();
    let cuerpos = [
        json!({ "instanceId": "hijo", "helloSeq": 1 }),
        json!({ "instanceId": "hijo2", "helloSeq": 1, "claudeSessionId": "" }),
        json!({}),
        json!({ "claudeSessionId": "" }),
    ];
    for extra in cuerpos {
        let mut body = json!({
            "sesionId": id, "protocol": 2, "source": "start", "transcriptPath": ruta,
        });
        body.as_object_mut()
            .expect("objeto")
            .extend(extra.as_object().expect("objeto").clone());
        let (st, v) = post(&b.info, "/v1/hello", Some(&bearer(&id)), &body);
        assert_eq!(st, 409, "{body}: {v}");
    }
    let despues = registro::read(&id, |s| s.transcript.clone()).expect("leer");
    assert_eq!(antes, despues, "el transcript no cambia");
    // El reintento del anuncio del dueño responde la generación vigente.
    let (st, v) = anuncio(&b, &id, "sid-a", "start", "padre", 1);
    assert_eq!((st, v["generation"].as_u64()), (200, Some(1)), "{v}");
    // Caso negativo: el propio dueño sí puede anunciar sin sid.
    let propio = json!({
        "sesionId": id, "protocol": 2, "source": "turn", "instanceId": "padre", "helloSeq": 2,
    });
    let (st, v) = post(&b.info, "/v1/hello", Some(&bearer(&id)), &propio);
    assert_eq!((st, v["generation"].as_u64()), (200, Some(2)), "{v}");
}

fn hello_crudo(b: &super::Banco, id: &str, sid: &str) -> (u16, Value) {
    let body = json!({
        "sesionId": id, "protocol": 2, "claudeSessionId": sid, "source": "clear",
        "instanceId": "padre", "helloSeq": 2,
    });
    post(&b.info, "/v1/hello", Some(&bearer(id)), &body)
}

/// Un sid absoluto, UNC o con `..` sacaba `slug_dir.join(sid + ".jsonl")` de
/// `~/.claude/projects` y se saltaba `valid_transcript`.
#[test]
fn hello_con_un_sid_que_no_es_uuid_es_400_y_no_toca_el_registro() {
    let b = banco();
    let id = sesion_en_pty("pty-a");
    assert_eq!(anuncio(&b, &id, "sid-a", "start", "padre", 1).0, 200);
    let antes = registro::read(&id, |s| s.transcript.clone()).expect("leer");
    let malos = [
        r"C:\Windows\x",
        r"..\..\x",
        r"\\127.0.0.1\c$\x",
        "../../x",
        "{00000000-0000-4000-8000-000000000001}",
        "sid-a",
    ];
    for sid in malos {
        let (st, v) = hello_crudo(&b, &id, sid);
        assert_eq!(st, 400, "{sid}: {v}");
    }
    assert_eq!(sid_de(&id).as_deref(), Some(uuid_de("sid-a").as_str()));
    let despues = registro::read(&id, |s| s.transcript.clone()).expect("leer");
    assert_eq!(antes, despues, "el transcript no cambia");
    // Caso negativo: un UUID sigue cambiando de conversación.
    assert_eq!(hello_crudo(&b, &id, &uuid_de("sid-b")).0, 200);
    assert_eq!(sid_de(&id).as_deref(), Some(uuid_de("sid-b").as_str()));
}

#[test]
fn subagents_dir_no_sale_del_directorio_del_proyecto() {
    let base = std::path::Path::new(r"C:\base\proyecto");
    for sid in [
        r"C:\Windows",
        r"..\..\x",
        r"\\host\share\x",
        "a/b",
        "x:ads",
        "",
    ] {
        let dir = agentes::subagents_dir(base, sid);
        assert!(dir.starts_with(base), "{sid}: {}", dir.display());
        assert_ne!(dir, base.join(sid).join("subagents"), "{sid}");
    }
    // Caso negativo: un sid normal conserva la ruta de Claude Code.
    let ok = uuid_de("sid-a");
    assert_eq!(
        agentes::subagents_dir(base, &ok),
        base.join(&ok).join("subagents")
    );
}

/// Un junction bajo `projects` que apunta fuera pasaba la comprobación
/// léxica de `valid_transcript`.
#[cfg(windows)]
#[test]
fn transcript_bajo_un_junction_que_sale_de_la_base_se_rechaza() {
    let raiz = std::env::temp_dir().join(format!("puente-junction-{}", uuid::Uuid::new_v4()));
    let (base, fuera) = (raiz.join("projects"), raiz.join("fuera"));
    std::fs::create_dir_all(base.join("slug")).expect("base");
    std::fs::create_dir_all(&fuera).expect("fuera");
    let enlace = base.join("enlace");
    let st = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&enlace)
        .arg(&fuera)
        .output()
        .expect("mklink");
    assert!(
        st.status.success(),
        "{}",
        String::from_utf8_lossy(&st.stderr)
    );
    let resultado = (
        bajo_base(&base, &enlace.join("x.jsonl")),
        bajo_base(&base, &base.join("slug").join("x.jsonl")),
        bajo_base(&base, &base.join("aun-no-existe").join("x.jsonl")),
    );
    let _ = std::fs::remove_dir(&enlace);
    let _ = std::fs::remove_dir_all(&raiz);
    assert_eq!(resultado, (false, true, true));
}

/// `/v1/result` resolvía cualquier `opId` de cualquier sesión.
#[test]
fn result_con_el_token_de_otra_sesion_no_resuelve_la_operacion() {
    let b = banco();
    let (a, c) = (sesion(), sesion());
    hello(&b, &a, Some(2));
    hello(&b, &c, Some(2));
    let op = InboxOp::ConfigList {
        op_id: String::new(),
    };
    let op_id = buzon::encolar_op(&c, op).expect("encolar");
    let ajeno = json!({ "sesionId": a, "opId": op_id, "ok": true, "value": [] });
    post(&b.info, "/v1/result", Some(&bearer(&a)), &ajeno);
    let sin_sesion = json!({ "opId": op_id, "ok": true, "value": [] });
    let (st, _) = post(&b.info, "/v1/result", Some(&bearer(&a)), &sin_sesion);
    assert_eq!(st, 400, "sesionId obligatorio");
    assert_eq!(
        buzon::pendientes(&c, 1).len(),
        1,
        "la operación de C sigue pendiente"
    );
    // Caso negativo: la dueña sí la resuelve.
    let propio = json!({ "sesionId": c, "opId": op_id, "ok": true, "value": [] });
    assert_eq!(
        post(&b.info, "/v1/result", Some(&bearer(&c)), &propio).0,
        200
    );
    assert!(buzon::pendientes(&c, 1).is_empty());
}

/// `/v1/ask/wait` devolvía el estado (y la respuesta) de asks ajenos.
#[test]
fn ask_wait_de_un_ask_de_otra_sesion_es_desconocido() {
    let b = banco();
    let (a, c) = (sesion(), sesion());
    hello(&b, &a, Some(2));
    let ask = json!({ "kind": "permission", "tool": "Bash", "input": {}, "summary": "ls" });
    let p = b.broker.abrir(&*b.sink, &c, &ask, None).expect("abrir");
    let espera = json!({ "sesionId": a, "generation": 1, "askIds": [p.ask_id] });
    let (_, w) = post(&b.info, "/v1/ask/wait", Some(&bearer(&a)), &espera);
    assert_eq!(
        (
            w["results"][0]["status"].clone(),
            w["results"][0]["reason"].clone()
        ),
        (json!("cancelled"), json!("unknown")),
        "{w}"
    );
    // Caso negativo: la dueña lo ve pendiente.
    let propia = json!({ "sesionId": c, "askIds": [p.ask_id] });
    let (_, w) = post(&b.info, "/v1/ask/wait", Some(&bearer(&c)), &propia);
    assert_eq!(w["results"][0]["status"], "pending", "{w}");
}

/// Omitir `generation` esquivaba el rechazo de los lotes sin `hello`.
#[test]
fn lote_sin_generation_tras_un_hello_v2_es_409() {
    let b = banco();
    let id = sesion();
    hello(&b, &id, Some(2));
    let evento = json!({ "type": "notice", "seq": 1, "level": "info", "text": "x" });
    let lote = json!({ "sesionId": id, "events": [evento] });
    let (st, r) = post(&b.info, "/v1/events", Some(&bearer(&id)), &lote);
    assert_eq!(st, 409, "{r}");
    // Caso negativo: el protocolo 1 no manda generación y sigue entrando.
    let v1 = sesion();
    hello(&b, &v1, None);
    let lote = json!({ "sesionId": v1, "events": [evento] });
    assert_eq!(
        post(&b.info, "/v1/events", Some(&bearer(&v1)), &lote).1,
        json!({ "ok": true })
    );
}

#[test]
fn las_instancias_vetadas_tienen_tope() {
    let b = banco();
    let id = sesion_en_pty("pty-a");
    assert_eq!(anuncio(&b, &id, "sid-a", "start", "padre", 1).0, 200);
    for n in 0..200 {
        let inst = format!("hijo-{n}");
        assert_eq!(anuncio(&b, &id, "sid-hijo", "start", &inst, 1).0, 409);
    }
    let n = vetadas(&id);
    assert!((1..=64).contains(&n), "vetadas: {n}");
    // La más reciente sigue vetada aunque vuelva con el sid del dueño.
    assert_eq!(anuncio(&b, &id, "sid-a", "turn", "hijo-199", 2).0, 409);
}

#[test]
fn los_asks_pendientes_por_sesion_tienen_tope() {
    let sink = MockSink::default();
    let broker = Broker::new();
    let ask = json!({ "kind": "permission", "tool": "Bash", "input": {}, "summary": "ls" });
    let ids: Vec<String> = (0..MAX_ASKS_SESION)
        .map(|_| broker.abrir(&sink, "s1", &ask, None).expect("abrir").ask_id)
        .collect();
    assert!(
        broker.abrir(&sink, "s1", &ask, None).is_err(),
        "por encima del tope"
    );
    assert!(
        broker.abrir(&sink, "s2", &ask, None).is_ok(),
        "el tope es por sesión"
    );
    broker.cancelar(
        &sink,
        &ids[0],
        super::super::types::AskCancelReason::ModAborted,
    );
    assert!(
        broker.abrir(&sink, "s1", &ask, None).is_ok(),
        "al resolver uno, hay sitio"
    );
}

#[test]
fn ask_por_encima_del_tope_es_429() {
    let b = banco();
    let id = sesion();
    hello(&b, &id, Some(2));
    let ask = json!({ "kind": "permission", "tool": "Bash", "input": {}, "summary": "ls" });
    for _ in 0..MAX_ASKS_SESION {
        b.broker.abrir(&*b.sink, &id, &ask, None).expect("abrir");
    }
    let body = json!({ "sesionId": id, "ask": ask, "async": true });
    let (st, r) = post(&b.info, "/v1/ask", Some(&bearer(&id)), &body);
    assert_eq!(st, 429, "{r}");
}

/// Petición HTTP/1.1 cruda para encadenarla con otras en la misma conexión.
fn cruda(ruta: &str, auth: Option<&str>, cuerpo: &str, largo: usize) -> String {
    let auth = auth.map_or_else(String::new, |a| format!("Authorization: {a}\r\n"));
    format!(
        "POST {ruta} HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Content-Type: application/json\r\n\
         Content-Length: {largo}\r\n\r\n{cuerpo}"
    )
}

fn conectar(info: &super::PuenteInfo) -> std::net::TcpStream {
    let dir = info.url.trim_start_matches("http://");
    std::net::TcpStream::connect(dir).expect("conectar")
}

/// Un 401 por otra conexión, con tope de espera: `None` si el aceptador no
/// la atendió a tiempo.
fn rechazo_a_tiempo(info: &super::PuenteInfo) -> Option<u16> {
    let (tx, rx) = std::sync::mpsc::channel();
    let i = info.clone();
    std::thread::spawn(move || {
        let _ = tx.send(post(&i, "/v1/events", None, &json!({})).0);
    });
    rx.recv_timeout(std::time::Duration::from_secs(3)).ok()
}

fn retenedor() -> std::sync::Arc<super::Retenedor> {
    std::sync::Arc::new(super::Retenedor {
        dentro: std::sync::atomic::AtomicUsize::new(0),
        suelta: (std::sync::Mutex::new(false), std::sync::Condvar::new()),
    })
}

fn soltar(h: &super::Retenedor) {
    let (m, cv) = &h.suelta;
    *m.lock().expect("lock") = true;
    cv.notify_all();
}

/// En HTTP/1.1 las respuestas de una conexión salen en orden: el 401 de una
/// petición encadenada tras otra en curso se queda esperando a que esta
/// termine. Respondido desde el hilo aceptador, paraba el puente de todas
/// las sesiones mientras durase la primera (un sondeo, un ask síncrono).
#[test]
fn un_rechazo_encadenado_tras_una_peticion_en_curso_no_para_el_aceptador() {
    use std::io::Write;
    let h = retenedor();
    let info = super::puente::start(h.clone()).expect("puente");
    let id = "seguridad-encadenada";
    let cuerpo = json!({ "sesionId": id }).to_string();
    let tubo = format!(
        "{}{}",
        cruda("/v1/hello", Some(&bearer(id)), &cuerpo, cuerpo.len()),
        cruda("/v1/hello", None, "{}", 2)
    );
    let mut c = conectar(&info);
    c.write_all(tubo.as_bytes()).expect("escribir");
    let t = std::time::Instant::now();
    while h.dentro.load(std::sync::atomic::Ordering::SeqCst) < 1
        && t.elapsed() < std::time::Duration::from_secs(5)
    {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    std::thread::sleep(std::time::Duration::from_millis(200));
    let otra = rechazo_a_tiempo(&info);
    soltar(&h);
    assert_eq!(otra, Some(401), "el aceptador sigue atendiendo");
}

/// Soltar una petición rechazada lee el resto de su cuerpo declarado: con un
/// `Content-Length` que nunca llega, el aceptador se quedaba leyendo, sin
/// necesidad de token.
#[test]
fn un_rechazo_con_el_cuerpo_a_medias_no_para_el_aceptador() {
    use std::io::Write;
    let info = super::puente::start(retenedor()).expect("puente");
    let mut c = conectar(&info);
    let lento = cruda("/v1/events", None, "{", 4096);
    c.write_all(lento.as_bytes()).expect("escribir");
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(
        rechazo_a_tiempo(&info),
        Some(401),
        "el aceptador sigue atendiendo"
    );
}

/// Con la cola de rechazos llena, los hilos desechables tienen tope: pasado
/// `MAX_DESECHABLES` no hay plaza (la petición se abandona y se cuenta), y
/// al soltar una plaza vuelve a haberla.
#[test]
fn los_hilos_desechables_de_rechazo_tienen_tope_y_cuentan_las_abandonadas() {
    use super::puente::desecho::{Desechos, MAX_DESECHABLES};
    let d = std::sync::Arc::new(Desechos::default());
    let mut plazas: Vec<_> = (0..MAX_DESECHABLES)
        .map(|_| d.ocupar().expect("plaza"))
        .collect();
    assert!(d.ocupar().is_none(), "sin plaza por encima del tope");
    plazas.pop();
    assert!(
        d.ocupar().is_some(),
        "una plaza suelta vuelve a estar libre"
    );
    assert_eq!(d.abandonadas(), 0);
    assert_eq!((d.contar_abandonada(), d.contar_abandonada()), (1, 2));
    assert_eq!(d.abandonadas(), 2);
}

/// Notas del chat de la sesión `id` recibidas por el sink del banco.
fn notas_de(b: &super::Banco, id: &str) -> Vec<String> {
    b.sink
        .payloads(ev::NOTICE)
        .into_iter()
        .filter(|p| p["id"] == id)
        .filter_map(|p| p["text"].as_str().map(str::to_string))
        .collect()
}

/// El rechazo de un `claude` hijo avisa en el chat una sola vez por
/// instancia vetada; la recarga del mod del dueño no avisa (caso negativo).
#[test]
fn el_veto_de_un_hijo_avisa_en_el_chat_una_vez() {
    let b = banco();
    let id = sesion_en_pty("pty-aviso");
    assert_eq!(anuncio(&b, &id, "sid-a", "start", "padre", 1).0, 200);
    assert_eq!(
        anuncio(&b, &id, "sid-a", "start", "padre-recargado", 1).0,
        200
    );
    assert!(
        notas_de(&b, &id).is_empty(),
        "la recarga del dueño no avisa"
    );
    assert_eq!(anuncio(&b, &id, "sid-hijo", "start", "hijo", 1).0, 409);
    assert_eq!(anuncio(&b, &id, "sid-hijo", "resume", "hijo", 2).0, 409);
    assert_eq!(notas_de(&b, &id), vec![AVISO_VETO.to_string()]);
    assert_eq!(anuncio(&b, &id, "sid-otro", "start", "otro-hijo", 1).0, 409);
    assert_eq!(
        notas_de(&b, &id).len(),
        2,
        "otra instancia vetada, otro aviso"
    );
}

/// Un lock del estado del puente envenenado no acepta por defecto: el hijo
/// sigue vetado y el dueño conserva la conversación.
#[test]
fn con_el_estado_del_puente_envenenado_el_veto_sigue_actuando() {
    let b = banco();
    let id = sesion_en_pty("pty-veneno");
    assert_eq!(anuncio(&b, &id, "sid-a", "start", "padre", 1).0, 200);
    envenenar_puentes();
    assert_eq!(anuncio(&b, &id, "sid-hijo", "start", "hijo", 1).0, 409);
    assert_eq!(sid_de(&id).as_deref(), Some(uuid_de("sid-a").as_str()));
}
