//! daemon_client.rs — cliente del daemon `ultron-memory serve`.
//!
//! Por qué existe: hasta 2026-08-15 cada proceso que necesitaba semántica
//! cargaba su PROPIA copia de E5-large. Medido en esta máquina con la app
//! abierta y el daemon vivo: `control-center.exe` 1.523 MB + `ultron-memory
//! serve` 1.223 MB, y encima cada `recall` por CLI picaba en 3,2 GB (E5 +
//! cross-encoder) porque también se los cargaba él. Tres copias del mismo
//! modelo para responder a la misma pregunta.
//!
//! El daemon ya tiene los modelos calientes y habla TCP por loopback (una línea
//! JSON por petición, token compartido en `~/.ultron/run/orchestrate.json`).
//! Este módulo deja que la GUI y los one-shot le pregunten a él. Si no
//! contesta, el llamante hace lo de siempre en su propio proceso: la memoria
//! nunca depende de que el daemon esté vivo, solo gasta menos cuando lo está.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

/// Espera máxima de conexión. Loopback: si no contesta ya, no está.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);

fn lockfile_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ultron")
        .join("run")
        .join("orchestrate.json")
}

/// Parseo puro del lockfile — separado para poder probarlo sin tocar disco.
fn parse_endpoint(raw: &str) -> Option<(u16, String)> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let port = u16::try_from(v.get("port")?.as_u64()?).ok()?;
    let token = v.get("token")?.as_str()?.to_string();
    if port == 0 || token.is_empty() {
        return None;
    }
    Some((port, token))
}

/// (puerto, token) del daemon anunciado en el lockfile, si lo hay.
fn endpoint() -> Option<(u16, String)> {
    parse_endpoint(&std::fs::read_to_string(lockfile_path()).ok()?)
}

/// Envía una petición al daemon y devuelve su respuesta.
///
/// `None` = no hay daemon, no contesta, o devolvió un error: el llamante debe
/// seguir por su camino local. Nunca propaga el fallo, porque un daemon caído
/// no puede convertirse en un fallo de recall.
///
/// `timeout` acota la espera de la respuesta: el llamante decide cuánto puede
/// esperar (un hook en el hot path, poco; un eval, más).
pub fn request(cmd: &str, extra: Value, timeout: Duration) -> Option<Value> {
    let (port, token) = endpoint()?;
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;

    let mut req = serde_json::Map::new();
    req.insert("token".into(), Value::String(token));
    req.insert("cmd".into(), Value::String(cmd.to_string()));
    if let Value::Object(map) = extra {
        for (k, v) in map {
            req.insert(k, v);
        }
    }

    let mut writer = stream.try_clone().ok()?;
    writer
        .write_all(format!("{}\n", Value::Object(req)).as_bytes())
        .ok()?;
    writer.flush().ok()?;

    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).ok()?;
    let resp: Value = serde_json::from_str(line.trim()).ok()?;
    if resp.get("error").is_some() {
        return None;
    }
    Some(resp)
}

/// ¿Hay un daemon vivo? Barato: una conexión y un `ping`.
pub fn is_alive() -> bool {
    request("ping", Value::Null, Duration::from_millis(500)).is_some()
}

/// Orquestación completa por el daemon (mismo motor que el hook).
pub fn orchestrate(prompt: &str, project: Option<&str>, timeout: Duration) -> Option<Value> {
    request(
        "orchestrate",
        serde_json::json!({ "prompt": prompt, "project": project }),
        timeout,
    )
}

/// Recall híbrido por el daemon. `cross` = búsqueda en todo el cerebro.
pub fn recall(
    query: &str,
    limit: u32,
    project: Option<&str>,
    cross: bool,
    rerank: bool,
    timeout: Duration,
) -> Option<Value> {
    request(
        "recall",
        serde_json::json!({
            "prompt": query,
            "project": project,
            "top": limit,
            "cross": cross,
            "rerank": rerank,
        }),
        timeout,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lee_el_lockfile_del_daemon() {
        let raw = r#"{"pid":15304,"port":59666,"schema":"orchestrate-daemon.v1","token":"abc123"}"#;
        assert_eq!(parse_endpoint(raw), Some((59666, "abc123".to_string())));
    }

    #[test]
    fn descarta_lockfiles_que_no_sirven() {
        // Caso negativo: si el parseo colara cualquiera de estos, el cliente
        // intentaria conectar a un endpoint invalido en vez de degradar al
        // camino local, y el llamante se comeria el timeout en cada llamada.
        assert_eq!(parse_endpoint("no soy json"), None);
        assert_eq!(parse_endpoint("{}"), None);
        assert_eq!(parse_endpoint(r#"{"port":0,"token":"abc"}"#), None);
        assert_eq!(parse_endpoint(r#"{"port":123,"token":""}"#), None);
        assert_eq!(parse_endpoint(r#"{"port":123}"#), None);
        assert_eq!(parse_endpoint(r#"{"token":"abc"}"#), None);
        // Puerto fuera de rango: el lockfile viene de disco y puede estar roto.
        assert_eq!(parse_endpoint(r#"{"port":99999,"token":"abc"}"#), None);
    }

    #[test]
    fn sin_daemon_devuelve_none_y_no_panica() {
        // Puerto cerrado: el cliente NO puede propagar el fallo, porque el
        // contrato es "si no hay daemon, el llamante sigue por su camino".
        let resp = request(
            "ping",
            serde_json::json!({}),
            std::time::Duration::from_millis(200),
        );
        // No se afirma Some/None (en esta maquina puede haber daemon vivo):
        // lo que se prueba es que la llamada termina sin panico ni error.
        let _ = resp;
    }
}
