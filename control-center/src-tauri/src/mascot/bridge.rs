// Mascota — puente local para el MCP de escritorio.
//
// Claude Code en terminal no trae control del escritorio. El MCP
// `tools/ultron-desktop-mcp/server.mjs` (Node, sin dependencias) se lo da,
// pero no toca Windows por sí mismo: reenvía cada herramienta a este
// servidor HTTP dentro de ULTRON, que ya tiene Win32 a mano y, sobre todo,
// la mascota. Así, cuando un agente mueve el ratón, la mascota vuela hasta
// el punto llevando el cursor, «pulsa» al clicar y teclea al escribir.
//
// Protocolo: HTTP/1.1 mínimo en 127.0.0.1:<puerto aleatorio>.
//   POST /v1/action   cabecera X-Ultron-Token   cuerpo {"action": "...", ...}
//   POST /v1/approve  confirmación en el bocadillo (approve.rs)
//   POST /v1/pretool  hook PreToolUse del chat de Pupus (chat_gate.rs)
//   POST /v1/permission  hook PermissionRequest de Claude Code en terminal
//                        (permission.rs); espera abierta hasta la respuesta
// El puerto y el token se escriben en ~/.ultron/cockpit/mascot-bridge.json
// al arrancar (el token cambia en cada arranque). Se rechaza lo que delata
// un navegador (`Sec-Fetch-*`, un `Origin` o un `Host` que no son de
// loopback; ver `is_browser_request`): una web abierta en el navegador no
// puede hablar con el puente. El token se comprueba con las cabeceras, antes
// de leer el cuerpo (hasta `MAX_BODY`): sin token no se lee ni un byte más.
//
// Coordenadas: las del modelo son las de la ÚLTIMA imagen que devolvió
// `screenshot` (reducida a 1280 px de ancho como mucho); aquí se escalan a
// píxeles físicos con `image::shot_scale`, que es determinista.
//
// Sin ULTRON abierto el MCP responde con un error que lo dice; no hay
// camino alternativo que mueva el ratón «a ciegas».
//
// Piezas:
//   * bridge.rs         — arranque, enrutado y autorización de cada ruta.
//   * bridge/http.rs    — HTTP mínimo: lectura, cabeceras y respuesta.
//   * bridge/actions.rs — ratón, teclado y capturas del MCP de escritorio.

mod actions;
mod http;

use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use once_cell::sync::OnceCell;
use serde_json::{json, Value};
use tauri::AppHandle;

use actions::run_action;
use http::{authorize, read_request, respond, Request};

struct BridgeInfo {
    port: u16,
    token: String,
}

static INFO: OnceCell<BridgeInfo> = OnceCell::new();

pub fn port() -> Option<u16> {
    INFO.get().map(|i| i.port)
}

/// Token del arranque actual (para el hook del chat de Pupus, chat_gate.rs).
pub fn token() -> Option<String> {
    INFO.get().map(|i| i.token.clone())
}

pub fn info_path() -> Result<PathBuf, String> {
    Ok(crate::ultron_root()?
        .join("cockpit")
        .join("mascot-bridge.json"))
}

pub fn start(app: AppHandle) -> Result<(), String> {
    if INFO.get().is_some() {
        return Ok(());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = uuid::Uuid::new_v4().simple().to_string();

    let path = info_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = json!({
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    std::fs::write(&path, body.to_string()).map_err(|e| format!("{}: {e}", path.display()))?;
    let _ = INFO.set(BridgeInfo {
        port,
        token: token.clone(),
    });
    tracing::info!(port, "mascota: puente del MCP de escritorio escuchando");

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                if let Err(e) = serve(stream, &app, &token) {
                    tracing::debug!(error = %e, "mascota: petición del puente descartada");
                }
            });
        }
    });
    Ok(())
}

fn serve(mut stream: TcpStream, app: &AppHandle, token: &str) -> Result<(), String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let req = match read_request(&mut stream, token) {
        Ok(r) => r,
        Err((status, body)) => return respond(&mut stream, status, &body),
    };
    let (status, body) = route(&req, token, |kind, v| match kind {
        Endpoint::Approve => super::approve::ask(app, v),
        Endpoint::Action => run_action(app, v),
        Endpoint::PreTool => super::chat_gate::pretool(app, v),
        Endpoint::Permission => super::permission::handle(app, v, &|| peer_closed(&stream)),
    });
    respond(&mut stream, status, &body)
}

/// ¿Cerró el otro extremo? (el hook se cortó: el usuario contestó en la
/// terminal). Mira sin consumir y sin bloquear; ante la duda, sigue abierto.
fn peer_closed(stream: &TcpStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return false;
    }
    let mut byte = [0u8; 1];
    let closed = match stream.peek(&mut byte) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) => e.kind() != std::io::ErrorKind::WouldBlock,
    };
    let _ = stream.set_nonblocking(false);
    closed
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Endpoint {
    /// Ratón, teclado, capturas.
    Action,
    /// Confirmación del usuario para una herramienta destructiva (approve.rs).
    Approve,
    /// Hook PreToolUse del chat de Pupus (chat_gate.rs).
    PreTool,
    /// Hook PermissionRequest de Claude Code en terminal (permission.rs).
    Permission,
}

/// Autorización y enrutado, separados de la red y de Win32 para poder
/// probarlos. `serve` ya autorizó al leer; se repite aquí para que ninguna
/// ruta dependa de quién la llame.
fn route(req: &Request, token: &str, exec: impl FnOnce(Endpoint, &Value) -> Value) -> (u16, Value) {
    if let Err(denied) = authorize(req, token) {
        return denied;
    }
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/v1/health") => (200, json!({"ok": true})),
        ("POST", path @ ("/v1/action" | "/v1/approve" | "/v1/pretool" | "/v1/permission")) => {
            let kind = match path {
                "/v1/approve" => Endpoint::Approve,
                "/v1/pretool" => Endpoint::PreTool,
                "/v1/permission" => Endpoint::Permission,
                _ => Endpoint::Action,
            };
            match serde_json::from_slice::<Value>(&req.body) {
                Ok(v) => (200, exec(kind, &v)),
                Err(e) => (400, json!({"ok": false, "error": format!("JSON: {e}")})),
            }
        }
        _ => (404, json!({"ok": false, "error": "ruta desconocida"})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Request {
        Request {
            method: method.into(),
            path: path.into(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: body.as_bytes().to_vec(),
        }
    }

    /// Cabeceras que manda el hook `http` de Claude Code 2.1.302 (medidas con
    /// un servidor de prueba).
    fn claude_hook_headers() -> Vec<(&'static str, &'static str)> {
        vec![
            ("accept", "application/json, text/plain, */*"),
            ("content-type", "application/json"),
            ("x-ultron-token", "tok"),
            ("user-agent", "axios/1.15.2"),
            ("content-length", "20"),
            ("accept-encoding", "gzip, compress, deflate, br"),
            ("host", "127.0.0.1:56619"),
            ("connection", "keep-alive"),
        ]
    }

    fn pretool_status(headers: &[(&str, &str)]) -> (u16, bool) {
        let mut ran = false;
        let (s, _) = route(
            &req("POST", "/v1/pretool", headers, r#"{"tool_name":"Bash"}"#),
            "tok",
            |_, _| {
                ran = true;
                json!({})
            },
        );
        (s, ran)
    }

    #[test]
    fn el_hook_http_de_claude_code_llega_al_freno() {
        assert_eq!(pretool_status(&claude_hook_headers()), (200, true));
        // Si una versión futura añadiera un Origin de loopback, sigue pasando:
        // rechazarlo bloquearía el chat entero (el hook falla cerrado).
        for origin in [
            "http://127.0.0.1:56619",
            "http://localhost",
            "http://[::1]:8080",
        ] {
            let mut h = claude_hook_headers();
            h.push(("origin", origin));
            assert_eq!(pretool_status(&h), (200, true), "{origin}");
        }
    }

    #[test]
    fn el_navegador_no_llega_al_freno_ni_con_el_token() {
        let cases: &[(&str, &str)] = &[
            ("origin", "https://evil.example"),
            ("origin", "null"),
            ("origin", "http://127.0.0.1.evil.example"),
            ("origin", "http://localhost:80/x"),
            ("sec-fetch-mode", "cors"),
            ("Sec-Fetch-Site", "same-origin"),
            // DNS rebinding: mismo origen para el navegador, Host ajeno.
            ("host", "evil.example:56619"),
            ("host", "localhost.evil.example"),
        ];
        for (k, v) in cases {
            let mut h: Vec<(&str, &str)> = claude_hook_headers()
                .into_iter()
                .filter(|(name, _)| !(*k == "host" && *name == "host"))
                .collect();
            h.push((k, v));
            assert_eq!(pretool_status(&h), (403, false), "{k}: {v}");
        }
    }

    #[test]
    fn sin_token_o_desde_navegador_no_ejecuta_nada() {
        let mut ran = false;
        let (s, _) = route(&req("POST", "/v1/action", &[], "{}"), "tok", |_, _| {
            ran = true;
            json!({})
        });
        assert_eq!(s, 401);
        let (s, _) = route(
            &req(
                "POST",
                "/v1/action",
                &[("X-Ultron-Token", "tok"), ("Origin", "https://evil")],
                "{}",
            ),
            "tok",
            |_, _| {
                ran = true;
                json!({})
            },
        );
        assert_eq!(s, 403);
        assert!(!ran);
    }

    #[test]
    fn con_token_ejecuta_la_accion() {
        let (s, v) = route(
            &req(
                "POST",
                "/v1/action",
                &[("x-ultron-token", "tok")],
                r#"{"action":"cursor"}"#,
            ),
            "tok",
            |k, v| json!({"echo": v["action"], "approve": k == Endpoint::Approve}),
        );
        assert_eq!(s, 200);
        assert_eq!(v["echo"], "cursor");
        assert_eq!(v["approve"], false);

        let (s, v) = route(
            &req("POST", "/v1/approve", &[("x-ultron-token", "tok")], "{}"),
            "tok",
            |k, _| json!({"approve": k == Endpoint::Approve}),
        );
        assert_eq!(s, 200);
        assert_eq!(v["approve"], true);

        let (s, v) = route(
            &req(
                "POST",
                "/v1/pretool",
                &[("x-ultron-token", "tok")],
                r#"{"tool_name":"Bash"}"#,
            ),
            "tok",
            |k, _| json!({"pretool": k == Endpoint::PreTool}),
        );
        assert_eq!(s, 200);
        assert_eq!(v["pretool"], true);

        let (s, v) = route(
            &req("POST", "/v1/permission", &[("x-ultron-token", "tok")], "{}"),
            "tok",
            |k, _| json!({"permission": k == Endpoint::Permission}),
        );
        assert_eq!(s, 200);
        assert_eq!(v["permission"], true);
    }

    #[test]
    fn el_hook_de_permisos_sin_token_no_llega_al_bocadillo() {
        let mut ran = false;
        let (s, _) = route(
            &req("POST", "/v1/permission", &[], r#"{"tool_name":"Bash"}"#),
            "tok",
            |_, _| {
                ran = true;
                json!({})
            },
        );
        assert_eq!(s, 401);
        assert!(!ran);
    }

    #[test]
    fn peer_closed_distingue_abierto_de_cerrado() {
        let l = TcpListener::bind("127.0.0.1:0").expect("bind");
        let client = TcpStream::connect(l.local_addr().expect("addr")).expect("connect");
        let (server, _) = l.accept().expect("accept");
        assert!(
            !peer_closed(&server),
            "con el cliente conectado sigue abierto"
        );
        drop(client);
        std::thread::sleep(Duration::from_millis(50));
        assert!(peer_closed(&server), "al cortar el cliente se ve cerrado");
    }

    #[test]
    fn el_hook_del_chat_sin_token_no_llega_al_freno() {
        let mut ran = false;
        let (s, _) = route(
            &req("POST", "/v1/pretool", &[("x-ultron-token", "otro")], "{}"),
            "tok",
            |_, _| {
                ran = true;
                json!({})
            },
        );
        // Un 401 hace fallar el hook y, con onFailure: block, Claude Code
        // bloquea la herramienta.
        assert_eq!(s, 401);
        assert!(!ran);
    }
}
