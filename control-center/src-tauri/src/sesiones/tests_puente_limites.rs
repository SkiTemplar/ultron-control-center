// sesiones/tests_puente_limites.rs — Plazos de lectura de las conexiones y
// topes del cuerpo por ruta del puente (auditoría del 2026-10-15).

use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use super::{start_con_plazos, Plazos, PuenteInfo, MAX_CUERPO_CORTO};
use crate::sesiones::preguntas::Broker;
use crate::sesiones::puente_eventos::SesionesPuente;
use crate::sesiones::test_sink::MockSink;
use crate::sesiones::tests_puente::{bearer, post, server};

/// Plazo corto de los servidores de estos tests.
const PLAZO_TEST: Duration = Duration::from_millis(300);
/// Espera del cliente para dar la conexión por colgada.
const ESPERA_CLIENTE: Duration = Duration::from_secs(5);

fn server_con_plazos() -> PuenteInfo {
    let h = SesionesPuente::new(Arc::new(MockSink::default()), Arc::new(Broker::new()));
    let plazos = Plazos {
        lectura: PLAZO_TEST,
        escritura: PLAZO_TEST,
    };
    start_con_plazos(Arc::new(h), plazos).expect("puente")
}

fn conectar(info: &PuenteInfo) -> TcpStream {
    let c = TcpStream::connect(info.url.trim_start_matches("http://")).expect("conectar");
    c.set_read_timeout(Some(ESPERA_CLIENTE)).expect("plazo");
    c
}

/// Lee hasta que el puente cierra. Devuelve lo leído y, si la lectura acabó
/// en error, su tipo (`TimedOut`/`WouldBlock` = el cliente se cansó antes).
fn leer_hasta_cierre(c: &mut TcpStream) -> (String, Option<ErrorKind>) {
    let mut leido = Vec::new();
    let mut buf = [0u8; 4096];
    let fin = loop {
        match c.read(&mut buf) {
            Ok(0) => break None,
            Ok(n) => leido.extend_from_slice(&buf[..n]),
            Err(e) => break Some(e.kind()),
        }
    };
    (String::from_utf8_lossy(&leido).into_owned(), fin)
}

fn cliente_se_canso(fin: Option<ErrorKind>) -> bool {
    matches!(fin, Some(ErrorKind::TimedOut | ErrorKind::WouldBlock))
}

/// Una conexión que no manda nada retenía para siempre un hilo de
/// `tiny_http`: al vencer el plazo de lectura el puente la cierra.
#[test]
fn una_conexion_callada_se_cierra_al_vencer_el_plazo_de_lectura() {
    let info = server_con_plazos();
    let mut c = conectar(&info);
    let t = Instant::now();
    let (_, fin) = leer_hasta_cierre(&mut c);
    assert!(!cliente_se_canso(fin), "el puente no cerró la conexión");
    assert!(t.elapsed() < ESPERA_CLIENTE);
}

/// Con el token válido y el cuerpo a medias, la petición ocupaba su plaza del
/// cupo de control para siempre: al vencer el plazo recibe un 400.
#[test]
fn un_cuerpo_a_medias_recibe_un_400_al_vencer_el_plazo_de_lectura() {
    let info = server_con_plazos();
    let id = "limites-cuerpo-a-medias";
    let mut c = conectar(&info);
    let cabeceras = format!(
        "POST /v1/hello HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: {}\r\n\
         Content-Type: application/json\r\nContent-Length: 4096\r\n\r\n{{",
        bearer(id)
    );
    c.write_all(cabeceras.as_bytes()).expect("escribir");
    let (leido, fin) = leer_hasta_cierre(&mut c);
    assert!(!cliente_se_canso(fin), "el puente no respondió: {leido:?}");
    assert!(leido.starts_with("HTTP/1.1 400"), "respuesta: {leido:?}");
}

fn relleno(bytes: usize) -> String {
    "x".repeat(bytes)
}

/// Las rutas de control y los sondeos llevan cuerpos de unos pocos campos:
/// por encima de `MAX_CUERPO_CORTO`, 413 (antes admitían 4 MiB).
#[test]
fn las_rutas_cortas_rechazan_con_413_un_cuerpo_por_encima_de_su_tope() {
    let info = server(false);
    let id = "limites-rutas-cortas";
    let grande = relleno(usize::try_from(MAX_CUERPO_CORTO).expect("tope") + 1);
    for ruta in [
        "/v1/hello",
        "/v1/ask/wait",
        "/v1/ask/cancel",
        "/v1/inbox",
        "/v1/otra",
    ] {
        let cuerpo = json!({ "sesionId": id, "relleno": grande });
        let (code, _) = post(&info, ruta, Some(&bearer(id)), &cuerpo);
        assert_eq!(code, 413, "{ruta}");
    }
}

/// Caso negativo: un lote de eventos de 1 MiB sigue entrando (el mod manda
/// hasta 2000 eventos por lote).
#[test]
fn un_lote_de_eventos_de_un_mib_no_es_413() {
    let info = server(false);
    let id = "limites-lote-grande";
    let cuerpo = json!({ "sesionId": id, "events": [], "relleno": relleno(1024 * 1024) });
    let (code, _) = post(&info, "/v1/events", Some(&bearer(id)), &cuerpo);
    assert_ne!(code, 413);
}
