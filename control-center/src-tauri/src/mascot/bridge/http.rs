// Mascota — HTTP mínimo del puente (bridge.rs): lectura de la petición,
// autorización por cabeceras antes del cuerpo y respuesta JSON.

use std::io::{Read, Write};
use std::net::TcpStream;

use serde_json::{json, Value};

const MAX_HEADER: usize = 16 * 1024;
/// La entrada del hook PreToolUse trae el contenido entero de un Write.
const MAX_BODY: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct Request {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Vec<u8>,
}

impl Request {
    pub(super) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Lee hasta el final de las cabeceras. Devuelve la petición con el cuerpo
/// vacío y los bytes del cuerpo que llegaron en el mismo bloque.
fn read_head(stream: &mut impl Read) -> Result<(Request, Vec<u8>), String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(i) = find_header_end(&buf) {
            break i;
        }
        if buf.len() > MAX_HEADER {
            return Err("cabeceras demasiado grandes".into());
        }
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("conexión cerrada".into());
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    let rest = buf[header_end + 4..].to_vec();
    Ok((
        Request {
            method,
            path,
            headers,
            body: Vec::new(),
        },
        rest,
    ))
}

fn content_length(req: &Request) -> usize {
    req.header("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Completa el cuerpo hasta `len` bytes a partir de lo ya leído (`body`).
fn read_body(stream: &mut impl Read, mut body: Vec<u8>, len: usize) -> Result<Vec<u8>, String> {
    let mut chunk = [0u8; 4096];
    while body.len() < len {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    Ok(body)
}

/// Lee una petición autorizándola con las cabeceras ANTES del cuerpo: sin
/// token (o desde un navegador) se rechaza sin leer nada más, de modo que
/// nadie sin token hace que el puente reserve y lea hasta `MAX_BODY`.
/// `Err` lleva el estado y el cuerpo de la respuesta.
pub(super) fn read_request(stream: &mut impl Read, token: &str) -> Result<Request, (u16, Value)> {
    let (mut req, rest) = read_head(stream).map_err(|e| (400, json!({"ok": false, "error": e})))?;
    authorize(&req, token)?;
    let len = content_length(&req);
    if len > MAX_BODY {
        return Err((
            413,
            json!({"ok": false, "error": "cuerpo demasiado grande"}),
        ));
    }
    req.body = read_body(stream, rest, len).map_err(|e| (400, json!({"ok": false, "error": e})))?;
    Ok(req)
}

/// Autoridad (`host[:puerto]`) de loopback: `127.0.0.1`, `localhost` o
/// `[::1]`, con puerto numérico opcional.
fn is_loopback_authority(authority: &str) -> bool {
    let a = authority.trim();
    let (host, port) = match a.strip_prefix('[') {
        Some(rest) => match rest.split_once(']') {
            Some((h, "")) => (h, None),
            Some((h, tail)) => match tail.strip_prefix(':') {
                Some(p) => (h, Some(p)),
                None => return false,
            },
            None => return false,
        },
        None => match a.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (a, None),
        },
    };
    let port_ok = port.is_none_or(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    port_ok && (host == "127.0.0.1" || host == "::1" || host.eq_ignore_ascii_case("localhost"))
}

/// `Origin` de loopback sin ruta (`http://127.0.0.1:1234`). `null` no cuenta:
/// lo mandan los iframes aislados y las páginas `file://`.
fn is_loopback_origin(origin: &str) -> bool {
    origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .is_some_and(|rest| !rest.contains('/') && is_loopback_authority(rest))
}

/// Señales de que la petición sale de un navegador:
///   * cualquier cabecera `Sec-Fetch-*`: la añaden todos los navegadores
///     actuales y el JavaScript de la página no puede quitarla;
///   * un `Host` que no es de loopback: DNS rebinding (una web que resuelve
///     su dominio a 127.0.0.1 para parecer del mismo origen);
///   * un `Origin` que no es de loopback.
///
/// Un cliente HTTP de línea de comandos no manda ninguna: el hook `http` de
/// Claude Code (medido con 2.1.302: axios, sin `Origin` ni `Sec-Fetch-*`,
/// `Host: 127.0.0.1:<puerto>`) y el MCP de escritorio (`node:http`). Si una
/// versión futura del hook añadiera un `Origin` de loopback, sigue pasando en
/// vez de bloquear el chat entero (el hook falla cerrado). Un navegador
/// antiguo sin `Sec-Fetch-*` en una página de loopback tampoco llega: la
/// cabecera `X-Ultron-Token` obliga a un preflight CORS que el puente no
/// concede, y sin el token no hay nada que hacer.
fn is_browser_request(req: &Request) -> bool {
    let sec_fetch = req.headers.iter().any(|(k, _)| {
        k.get(..10)
            .is_some_and(|p| p.eq_ignore_ascii_case("sec-fetch-"))
    });
    if sec_fetch {
        return true;
    }
    if req
        .header("host")
        .is_some_and(|h| !is_loopback_authority(h))
    {
        return true;
    }
    req.header("origin").is_some_and(|o| !is_loopback_origin(o))
}

/// Autorización con las cabeceras solamente (no necesita el cuerpo).
pub(super) fn authorize(req: &Request, token: &str) -> Result<(), (u16, Value)> {
    if is_browser_request(req) {
        return Err((
            403,
            json!({"ok": false, "error": "peticiones de navegador no permitidas"}),
        ));
    }
    if req.header("x-ultron-token") != Some(token) {
        return Err((401, json!({"ok": false, "error": "token inválido"})));
    }
    Ok(())
}

pub(super) fn respond(stream: &mut TcpStream, status: u16, body: &Value) -> Result<(), String> {
    let text = body.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        text.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(text.as_bytes()))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsea_una_peticion_con_cuerpo() {
        let raw = b"POST /v1/action HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nX-Ultron-Token: abc\r\nContent-Length: 20\r\n\r\n{\"action\":\"cursor\"}X";
        let r = read_request(&mut &raw[..], "abc").unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/v1/action");
        assert_eq!(r.header("x-ultron-token"), Some("abc"));
        assert_eq!(r.body.len(), 20);
    }

    /// Lector que entrega bloques fijos y cuenta las lecturas que se le piden
    /// cuando ya no le quedan (es decir, los intentos de leer el cuerpo).
    struct Blocks {
        parts: std::collections::VecDeque<Vec<u8>>,
        extra_reads: usize,
    }

    impl Blocks {
        fn new(parts: &[&[u8]]) -> Self {
            Self {
                parts: parts.iter().map(|p| p.to_vec()).collect(),
                extra_reads: 0,
            }
        }
    }

    impl Read for Blocks {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let Some(mut part) = self.parts.pop_front() else {
                self.extra_reads += 1;
                return Ok(0);
            };
            let n = part.len().min(out.len());
            out[..n].copy_from_slice(&part[..n]);
            if n < part.len() {
                self.parts.push_front(part.split_off(n));
            }
            Ok(n)
        }
    }

    const BIG_HEAD: &[u8] =
        b"POST /v1/pretool HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nX-Ultron-Token: otro\r\nContent-Length: 8000000\r\n\r\n";

    #[test]
    fn sin_token_rechaza_antes_de_leer_el_cuerpo() {
        let mut r = Blocks::new(&[BIG_HEAD]);
        let (status, _) = read_request(&mut r, "tok").expect_err("token incorrecto");
        assert_eq!(status, 401);
        assert_eq!(r.extra_reads, 0, "no debe intentar leer el cuerpo");

        // Desde un navegador, igual: 403 sin leer el cuerpo.
        let head = b"POST /v1/pretool HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nOrigin: https://evil.example\r\nX-Ultron-Token: tok\r\nContent-Length: 8000000\r\n\r\n";
        let mut r = Blocks::new(&[head]);
        assert_eq!(read_request(&mut r, "tok").unwrap_err().0, 403);
        assert_eq!(r.extra_reads, 0);
    }

    #[test]
    fn con_token_un_cuerpo_excesivo_se_rechaza_sin_leerlo() {
        let head = b"POST /v1/pretool HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nX-Ultron-Token: tok\r\nContent-Length: 9000000\r\n\r\n";
        let mut r = Blocks::new(&[head]);
        assert_eq!(read_request(&mut r, "tok").unwrap_err().0, 413);
        assert_eq!(r.extra_reads, 0);

        // Caso negativo: con token y tamaño válido, el cuerpo troceado en
        // varios bloques se lee entero.
        let head = b"POST /v1/pretool HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nX-Ultron-Token: tok\r\nContent-Length: 20\r\n\r\n{\"tool_";
        let mut r = Blocks::new(&[head, b"name\":\"Bash\"}"]);
        let req = read_request(&mut r, "tok").unwrap();
        assert_eq!(req.body, br#"{"tool_name":"Bash"}"#);
    }
}
