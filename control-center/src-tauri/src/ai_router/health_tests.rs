// Tests del sondeo de salud: a quién se le adjunta la key.

use std::net::TcpListener;

use super::{credentials_allowed, http_client, same_origin};
use crate::ai_router::seed::seed_providers;

#[test]
fn el_origen_compara_esquema_host_y_puerto() {
    assert!(same_origin(
        "https://a.example/v1",
        "https://a.example/otra"
    ));
    assert!(
        same_origin("https://a.example:443/v1", "https://a.example/v1"),
        "el puerto por defecto es el mismo"
    );
    // Casos negativos: cada componente por separado.
    assert!(!same_origin("http://a.example/v1", "https://a.example/v1"));
    assert!(!same_origin("https://b.example/v1", "https://a.example/v1"));
    assert!(!same_origin(
        "https://a.example:8443/v1",
        "https://a.example/v1"
    ));
    assert!(!same_origin(
        "http://localhost:1/v1",
        "http://localhost:2/v1"
    ));
    assert!(!same_origin("no es una url", "no es una url"));
}

/// Caso negativo: un `health_endpoint` ajeno no recibe la key.
#[test]
fn la_key_solo_va_al_origen_de_la_base() {
    let mut p = seed_providers()
        .into_iter()
        .find(|p| p.id == "groq")
        .expect("groq");
    assert!(credentials_allowed(
        &p,
        "https://api.groq.com/openai/v1/models"
    ));
    p.base_url = "http://localhost:1/v1".into();
    assert!(!credentials_allowed(&p, "http://localhost:2/v1/models"));
    assert!(!credentials_allowed(&p, "https://evil.example.com/models"));
}

/// Una redirección a otro origen no se sigue: la cabecera de key viajaría con
/// ella. El segundo servidor no llega a recibir nada.
#[test]
fn no_sigue_una_redireccion_a_otro_origen() {
    use std::io::{Read, Write};
    let other = TcpListener::bind("127.0.0.1:0").expect("bind");
    other.set_nonblocking(true).expect("nonblocking");
    let other_url = format!("http://{}/x", other.local_addr().expect("addr"));
    let first = TcpListener::bind("127.0.0.1:0").expect("bind");
    let first_url = format!("http://{}/models", first.local_addr().expect("addr"));
    std::thread::spawn(move || {
        let (mut s, _) = first.accept().expect("accept");
        let mut buf = [0u8; 2048];
        let _ = s.read(&mut buf);
        let reply = format!(
            "HTTP/1.1 302 Found\r\nLocation: {other_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let _ = s.write_all(reply.as_bytes());
    });
    let resp = http_client()
        .expect("cliente")
        .get(&first_url)
        .header("x-api-key", "clave-simulada")
        .send()
        .expect("respuesta");
    assert_eq!(resp.status().as_u16(), 302, "se queda en la redirección");
    assert!(other.accept().is_err(), "el otro origen no recibió nada");
}
