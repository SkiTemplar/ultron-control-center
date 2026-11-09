// sesiones/tests_puente.rs — Protocolo del puente sobre un servidor real en
// loopback: autenticación por sesión, rutas y métodos.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::preguntas::Broker;
use super::puente::{self, PuenteInfo};
use super::puente_eventos::SesionesPuente;
use super::test_sink::MockSink;

pub fn server(window_open: bool) -> PuenteInfo {
    let sink = Arc::new(if window_open {
        MockSink::opened()
    } else {
        MockSink::default()
    });
    let mut h = SesionesPuente::new(sink, Arc::new(Broker::new()));
    h.espera = Duration::from_millis(300);
    puente::start(Arc::new(h)).expect("arrancar puente")
}

/// Plazo de transporte de `post`: una petición que el servidor contesta al
/// momento.
const PLAZO_POST: Duration = Duration::from_secs(10);

/// POST y devuelve (código, cuerpo).
pub fn post(info: &PuenteInfo, route: &str, auth: Option<&str>, body: &Value) -> (u16, Value) {
    post_con_plazo(info, route, auth, body, PLAZO_POST)
}

/// `post` con el plazo de transporte explícito, para las peticiones que el
/// manejador retiene a propósito: su espera la decide la prueba, no la red.
pub fn post_con_plazo(
    info: &PuenteInfo,
    route: &str,
    auth: Option<&str>,
    body: &Value,
    plazo: Duration,
) -> (u16, Value) {
    let mut req = ureq::post(&format!("{}{route}", info.url)).timeout(plazo);
    if let Some(a) = auth {
        req = req.set("Authorization", a);
    }
    let resp = match req.send_json(body.clone()) {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => panic!("error de transporte: {e}"),
    };
    let status = resp.status();
    let v = resp.into_json::<Value>().unwrap_or(Value::Null);
    (status, v)
}

/// Cabecera con el token de la sesión `id`.
pub fn bearer(id: &str) -> String {
    format!("Bearer {}", puente::token_sesion(id).expect("token"))
}

#[test]
fn escucha_solo_en_loopback_y_cada_sesion_tiene_su_token() {
    let info = server(false);
    assert!(info.url.starts_with("http://127.0.0.1:"));
    let a = puente::token_sesion("tok-a").expect("a");
    assert_eq!(a.len(), 64);
    assert_eq!(puente::token_sesion("tok-a"), Some(a.clone()), "estable");
    assert_ne!(Some(a), puente::token_sesion("tok-b"), "uno por sesión");
}

#[test]
fn sin_token_valido_401() {
    let info = server(false);
    let body = json!({ "sesionId": "s1", "ask": { "kind": "plan", "plan": "x" } });
    assert_eq!(post(&info, "/v1/ask", None, &body).0, 401);
    assert_eq!(post(&info, "/v1/hello", None, &body).0, 401);
    assert_eq!(post(&info, "/v1/ask", Some("Bearer otro"), &body).0, 401);
    let revocado = bearer("s-revocada");
    puente::revocar_token("s-revocada");
    assert_eq!(
        post(&info, "/v1/hello", Some(&revocado), &body).0,
        401,
        "un token revocado no autoriza nada"
    );
    let crudo = puente::token_sesion("s1").expect("token");
    assert_eq!(
        post(&info, "/v1/ask", Some(&crudo), &body).0,
        401,
        "sin 'Bearer '"
    );
}

/// Sin ventana el ask ya no se contesta con `null` (queda pendiente: ver
/// `tests_preguntas`); una sesión desconocida sí se rechaza al momento.
#[test]
fn ask_de_sesion_desconocida_404_al_momento() {
    let info = server(false);
    let body = json!({
        "sesionId": "s1",
        "ask": { "kind": "permission", "tool": "Bash", "input": {"command": "ls"}, "summary": "ls" }
    });
    let t = Instant::now();
    let (status, _) = post(&info, "/v1/ask", Some(&bearer("s1")), &body);
    assert_eq!(status, 404);
    // `ask` no espera nada para una sesión desconocida: el tope solo detecta
    // un cuelgue. Con 300 ms fallaba con la CPU saturada y la suite en
    // paralelo, sin que el servidor esperase.
    assert!(t.elapsed() < PLAZO_POST / 2);
}

#[test]
fn rutas_y_metodos() {
    let info = server(false);
    let auth = bearer("no-existe");
    assert_eq!(post(&info, "/v1/nada", Some(&auth), &json!({})).0, 404);
    let (status, v) = post(&info, "/v1/hello", Some(&auth), &json!({}));
    assert_eq!(status, 400, "falta sesionId: {v}");
    let (status, _) = post(
        &info,
        "/v1/events",
        Some(&auth),
        &json!({ "sesionId": "no-existe", "events": [] }),
    );
    assert_eq!(status, 404, "sesión desconocida");
    let get = ureq::get(&format!("{}/v1/hello", info.url))
        .set("Authorization", &auth)
        .call();
    match get {
        Err(ureq::Error::Status(code, _)) => assert_eq!(code, 405),
        other => panic!("se esperaba 405: {other:?}"),
    }
}

#[test]
fn json_invalido_400() {
    let info = server(false);
    let resp = ureq::post(&format!("{}/v1/events", info.url))
        .set("Authorization", &bearer("s-json"))
        .send_string("{no json");
    match resp {
        Err(ureq::Error::Status(code, _)) => assert_eq!(code, 400),
        other => panic!("se esperaba 400: {other:?}"),
    }
}
