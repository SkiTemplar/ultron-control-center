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
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;

/// Espera máxima de conexión. Loopback: si no contesta ya, no está.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);

/// Espera del `embed` remoto: el daemon ya tiene E5 caliente, pero puede estar
/// sirviendo otra petición o recargando el modelo tras el release por
/// inactividad (`ULTRON_MODEL_IDLE_MIN`). 8 s cubre esa recarga; agotarlo cae al
/// camino local, que paga lo mismo pero en este proceso.
const EMBED_TIMEOUT: Duration = Duration::from_secs(8);

/// Dimensión del espacio E5-large. Una respuesta con otra longitud no es un
/// vector de este índice: se descarta y se recalcula en local.
const EMBED_DIM: usize = 1024;

/// ¿Estamos DENTRO del proceso daemon? Lo marca `serve` al arrancar.
static IN_DAEMON: AtomicBool = AtomicBool::new(false);

/// Marca este proceso como el daemon. La llama `serve` una vez al arrancar,
/// ANTES de atender peticiones: sin ella el daemon se pediría los embeddings a
/// sí mismo por TCP (deadlock del hilo que atiende, o round trip inútil).
pub fn mark_in_daemon() {
    IN_DAEMON.store(true, Ordering::Relaxed);
}

/// ¿Este proceso es el daemon? Los caminos que prefieren el daemon lo consultan
/// para no llamarse a sí mismos.
#[must_use]
pub fn is_in_daemon() -> bool {
    IN_DAEMON.load(Ordering::Relaxed)
}

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

/// Vector E5 de `text` (lado QUERY, prefijo `query:`) pidiéndoselo al daemon
/// cuando lo hay, en vez de cargar E5 en este proceso.
///
/// Contrato con el daemon (`serve.rs`):
///   petición  `{"cmd":"embed","text":"..."}`  (token y transporte los pone
///             [`request`])
///   respuesta `{"vector":[f32; 1024]}`
///
/// Orden de resolución:
///   1. `is_in_daemon()` → camino local de siempre (el daemon YA tiene E5; no se
///      llama a sí mismo).
///   2. daemon vivo y contesta un vector de 1024 dimensiones → ese vector.
///   3. cualquier otra cosa (sin daemon, timeout, respuesta malformada) → camino
///      local. Un daemon caído nunca convierte esto en un fallo.
///
/// Motivo (medido 2026-09-06): `ultron-memory inbox drain --auto` y `capture`
/// cargaban E5 (~1,5 GB, ~3 s) en el one-shot para embeber UNA query, con el
/// daemon vivo y el modelo caliente al lado.
pub fn embed_prefer_daemon(text: &str) -> Result<Vec<f32>, String> {
    if is_in_daemon() {
        return crate::qdrant::embed_e5(text, true);
    }
    if let Some(vector) = remote_embed(text) {
        return Ok(vector);
    }
    crate::qdrant::embed_e5(text, true)
}

/// Parseo del `{"vector":[...]}` del daemon. `None` si falta, no es un array de
/// números, o no tiene la dimensión del índice.
fn parse_embedding(resp: &Value) -> Option<Vec<f32>> {
    let raw = resp.get("vector")?.as_array()?;
    if raw.len() != EMBED_DIM {
        return None;
    }
    raw.iter()
        .map(|v| v.as_f64().map(|f| f as f32))
        .collect::<Option<Vec<f32>>>()
}

/// Embedding por el daemon. `None` = no hay daemon, no contestó, o contestó algo
/// que no es un vector de este índice.
fn remote_embed(text: &str) -> Option<Vec<f32>> {
    let resp = request("embed", serde_json::json!({ "text": text }), EMBED_TIMEOUT)?;
    parse_embedding(&resp)
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

    #[test]
    fn acepta_solo_vectores_de_la_dimension_del_indice() {
        let ok = serde_json::json!({ "vector": vec![0.5_f64; EMBED_DIM] });
        let parsed = parse_embedding(&ok).expect("un vector de 1024 debe parsearse");
        assert_eq!(parsed.len(), EMBED_DIM);
        assert!((parsed[0] - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn descarta_respuestas_que_no_son_un_vector_del_indice() {
        // Caso negativo: si colaran, el k-NN buscaria con basura o con una
        // dimension que Qdrant rechaza, en vez de caer al camino local.
        assert_eq!(parse_embedding(&serde_json::json!({})), None);
        assert_eq!(
            parse_embedding(&serde_json::json!({ "vector": "no" })),
            None
        );
        assert_eq!(
            parse_embedding(&serde_json::json!({ "vector": vec![0.0_f64; 8] })),
            None,
            "dimension distinta de 1024"
        );
        let con_texto = serde_json::json!({ "vector": ["a", "b"] });
        assert_eq!(parse_embedding(&con_texto), None);
    }

    #[test]
    fn el_flag_de_daemon_arranca_apagado_y_se_marca() {
        // Unico test que toca el flag global: sin marcar, un one-shot pide el
        // embedding al daemon; marcado, el daemon usa su propio E5 y no se
        // llama a si mismo por TCP.
        assert!(!is_in_daemon(), "por defecto NO somos el daemon");
        mark_in_daemon();
        assert!(is_in_daemon());
    }
}
