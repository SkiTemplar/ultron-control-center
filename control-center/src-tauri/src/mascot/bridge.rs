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
// El puerto y el token se escriben en ~/.ultron/cockpit/mascot-bridge.json
// al arrancar (el token cambia en cada arranque). Se rechaza cualquier
// petición con cabecera Origin: una web abierta en el navegador no puede
// hablar con el puente.
//
// Coordenadas: las del modelo son las de la ÚLTIMA imagen que devolvió
// `screenshot` (reducida a 1280 px de ancho como mucho); aquí se escalan a
// píxeles físicos con `image::shot_scale`, que es determinista.
//
// Sin ULTRON abierto el MCP responde con un error que lo dice; no hay
// camino alternativo que mueva el ratón «a ciegas».

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use once_cell::sync::OnceCell;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::image::{downscale_bgra_to_rgb, encode_png_rgb, shot_scale};
use super::win::{self, MouseButton};

struct BridgeInfo {
    port: u16,
}

static INFO: OnceCell<BridgeInfo> = OnceCell::new();
/// Una acción a la vez: dos agentes moviendo el mismo ratón a la vez solo
/// producen clics en sitios absurdos.
static ACTION_LOCK: Mutex<()> = Mutex::new(());
/// Generación del «modo conducción»: la mascota suelta el cursor cuando
/// pasa un rato sin acciones nuevas.
static DRIVE_GEN: AtomicU64 = AtomicU64::new(0);

const MAX_HEADER: usize = 16 * 1024;
const MAX_BODY: usize = 256 * 1024;
const MAX_TYPE_CHARS: usize = 5_000;

pub fn port() -> Option<u16> {
    INFO.get().map(|i| i.port)
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
    let _ = INFO.set(BridgeInfo { port });
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

// ---------------------------------------------------------------------------
// HTTP mínimo
// ---------------------------------------------------------------------------

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_request(stream: &mut impl Read) -> Result<Request, String> {
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
    let len: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        return Err("cuerpo demasiado grande".into());
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

fn respond(stream: &mut TcpStream, status: u16, body: &Value) -> Result<(), String> {
    let text = body.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
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

fn serve(mut stream: TcpStream, app: &AppHandle, token: &str) -> Result<(), String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let req = match parse_request(&mut stream) {
        Ok(r) => r,
        Err(e) => return respond(&mut stream, 400, &json!({"ok": false, "error": e})),
    };
    let (status, body) = route(&req, token, |v| run_action(app, v));
    respond(&mut stream, status, &body)
}

/// Autorización y enrutado, separados de la red y de Win32 para poder
/// probarlos.
fn route(req: &Request, token: &str, exec: impl FnOnce(&Value) -> Value) -> (u16, Value) {
    if req.header("origin").is_some() {
        return (
            403,
            json!({"ok": false, "error": "peticiones de navegador no permitidas"}),
        );
    }
    if req.header("x-ultron-token") != Some(token) {
        return (401, json!({"ok": false, "error": "token inválido"}));
    }
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/v1/health") => (200, json!({"ok": true})),
        ("POST", "/v1/action") => match serde_json::from_slice::<Value>(&req.body) {
            Ok(v) => (200, exec(&v)),
            Err(e) => (400, json!({"ok": false, "error": format!("JSON: {e}")})),
        },
        _ => (404, json!({"ok": false, "error": "ruta desconocida"})),
    }
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// Escala imagen → físico y su inversa.
fn screen_scale() -> f64 {
    shot_scale(win::primary_size().0)
}

fn to_phys(x: f64, y: f64) -> (i32, i32) {
    let s = screen_scale();
    ((x * s).round() as i32, (y * s).round() as i32)
}

fn to_image(x: i32, y: i32) -> (i64, i64) {
    let s = screen_scale();
    (
        (x as f64 / s).round() as i64,
        (y as f64 / s).round() as i64,
    )
}

fn point(v: &Value, kx: &str, ky: &str) -> Result<Option<(i32, i32)>, String> {
    match (num(v, kx), num(v, ky)) {
        (Some(x), Some(y)) => {
            let (w, h) = win::primary_size();
            let (px, py) = to_phys(x, y);
            if w > 0 && (px < 0 || py < 0 || px >= w as i32 || py >= h as i32) {
                return Err(format!(
                    "({x}, {y}) cae fuera de la pantalla (usa coordenadas de la última captura)"
                ));
            }
            Ok(Some((px, py)))
        }
        (None, None) => Ok(None),
        _ => Err(format!("faltan «{kx}» y «{ky}» juntos")),
    }
}

fn button(v: &Value) -> Result<MouseButton, String> {
    match v.get("button").and_then(Value::as_str).unwrap_or("left") {
        "left" | "izquierdo" => Ok(MouseButton::Left),
        "right" | "derecho" => Ok(MouseButton::Right),
        "middle" | "central" => Ok(MouseButton::Middle),
        other => Err(format!("botón desconocido: {other}")),
    }
}

struct Driver<'a> {
    app: &'a AppHandle,
    animate: bool,
}

impl<'a> Driver<'a> {
    fn new(app: &'a AppHandle) -> Self {
        let animate =
            super::load_settings().drive_with_mcp && app.get_webview_window(super::LABEL).is_some();
        let d = Self { app, animate };
        if animate {
            DRIVE_GEN.fetch_add(1, Ordering::SeqCst);
            // La ventana NO puede quedarse con el clic: atravesable ya, sin
            // esperar a que la webview procese el evento.
            if let Some(w) = app.get_webview_window(super::LABEL) {
                let _ = w.set_ignore_cursor_events(true);
            }
            d.emit(json!({"phase": "start"}));
        }
        d
    }

    fn emit(&self, payload: Value) {
        if self.animate {
            let _ = self.app.emit_to(super::LABEL, "mascot:drive", payload);
        }
    }

    fn act(&self, kind: &str, at: Option<(i32, i32)>) {
        let (x, y) = at.unwrap_or((i32::MIN, i32::MIN));
        self.emit(json!({"phase": "act", "kind": kind, "x": x, "y": y}));
        if self.animate {
            // Que se vea el «golpe» de la mascota antes del clic real.
            std::thread::sleep(Duration::from_millis(90));
        }
    }

    /// Mueve el cursor. Con la mascota activa, en un deslizamiento suave
    /// que ella sigue; sin ella, de golpe.
    fn glide(&self, to: (i32, i32)) -> Result<(), String> {
        if !self.animate {
            return win::move_cursor(to.0, to.1);
        }
        let from = win::cursor_state().map(|c| (c.x, c.y)).unwrap_or(to);
        let (dx, dy) = ((to.0 - from.0) as f64, (to.1 - from.1) as f64);
        let dist = (dx * dx + dy * dy).sqrt();
        let total = (dist * 0.55).clamp(220.0, 900.0);
        let started = Instant::now();
        loop {
            let t = (started.elapsed().as_secs_f64() * 1000.0 / total).min(1.0);
            // ease-in-out cúbica
            let e = if t < 0.5 {
                4.0 * t * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
            };
            win::move_cursor(
                from.0 + (dx * e).round() as i32,
                from.1 + (dy * e).round() as i32,
            )?;
            if t >= 1.0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
}

impl Drop for Driver<'_> {
    fn drop(&mut self) {
        if !self.animate {
            return;
        }
        let gen = DRIVE_GEN.load(Ordering::SeqCst);
        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1600));
            if DRIVE_GEN.load(Ordering::SeqCst) == gen {
                let _ = app.emit_to(super::LABEL, "mascot:drive", json!({"phase": "end"}));
            }
        });
    }
}

fn screenshot() -> Result<Value, String> {
    let raw = win::capture_primary()?;
    let scale = shot_scale(raw.width);
    let tw = ((raw.width as f64) / scale).round().max(1.0) as u32;
    let th = ((raw.height as f64) / scale).round().max(1.0) as u32;
    let rgb = downscale_bgra_to_rgb(&raw.bgra, raw.width, raw.height, tw, th);
    let png = encode_png_rgb(&rgb, tw, th)?;
    Ok(json!({
        "ok": true,
        "image_png_base64": base64::engine::general_purpose::STANDARD.encode(png),
        "width": tw,
        "height": th,
        "screen_width": raw.width,
        "screen_height": raw.height,
        "scale": scale,
    }))
}

fn run_action(app: &AppHandle, v: &Value) -> Value {
    let _guard = ACTION_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    match dispatch(app, v) {
        Ok(mut out) => {
            if let Some(obj) = out.as_object_mut() {
                obj.entry("ok").or_insert(Value::Bool(true));
            }
            out
        }
        Err(e) => json!({"ok": false, "error": e}),
    }
}

fn dispatch(app: &AppHandle, v: &Value) -> Result<Value, String> {
    let action = v
        .get("action")
        .and_then(Value::as_str)
        .ok_or("falta «action»")?;
    match action {
        "screenshot" => screenshot(),
        "cursor" => {
            let c = win::cursor_state().ok_or("cursor no disponible (solo Windows)")?;
            let (x, y) = to_image(c.x, c.y);
            Ok(json!({"x": x, "y": y}))
        }
        "windows" => {
            let list: Vec<Value> = win::desktop_windows(&[super::mascot_hwnd()])
                .into_iter()
                .map(|w| {
                    let (l, t) = to_image(w.left, w.top);
                    let (r, b) = to_image(w.right, w.bottom);
                    json!({"title": w.title, "left": l, "top": t, "right": r, "bottom": b})
                })
                .collect();
            Ok(json!({"windows": list}))
        }
        "move" => {
            let to = point(v, "x", "y")?.ok_or("faltan x, y")?;
            let d = Driver::new(app);
            d.glide(to)?;
            d.act("hover", Some(to));
            Ok(json!({}))
        }
        "click" => {
            let at = point(v, "x", "y")?;
            let b = button(v)?;
            let count = v.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 3);
            let d = Driver::new(app);
            if let Some(to) = at {
                d.glide(to)?;
            }
            d.act("click", at);
            for i in 0..count {
                if i > 0 {
                    std::thread::sleep(Duration::from_millis(60));
                }
                win::mouse_button(b, true)?;
                win::mouse_button(b, false)?;
            }
            Ok(json!({}))
        }
        "drag" => {
            let from = point(v, "x", "y")?.ok_or("faltan x, y")?;
            let to = point(v, "to_x", "to_y")?.ok_or("faltan to_x, to_y")?;
            let b = button(v)?;
            let d = Driver::new(app);
            d.glide(from)?;
            d.act("grab", Some(from));
            win::mouse_button(b, true)?;
            std::thread::sleep(Duration::from_millis(60));
            let moved = d.glide(to).or_else(|_| win::move_cursor(to.0, to.1));
            std::thread::sleep(Duration::from_millis(60));
            // Soltar SIEMPRE, aunque el movimiento fallara: un botón
            // pulsado colgado deja el escritorio inutilizable.
            win::mouse_button(b, false)?;
            moved?;
            d.act("drop", Some(to));
            Ok(json!({}))
        }
        "scroll" => {
            let at = point(v, "x", "y")?;
            let dy = num(v, "dy").unwrap_or(0.0).clamp(-50.0, 50.0) as i32;
            let dx = num(v, "dx").unwrap_or(0.0).clamp(-50.0, 50.0) as i32;
            if dx == 0 && dy == 0 {
                return Err("dx y dy son 0: nada que desplazar".into());
            }
            let d = Driver::new(app);
            if let Some(to) = at {
                d.glide(to)?;
            }
            d.act("scroll", at);
            win::scroll(dx, dy)?;
            Ok(json!({}))
        }
        "type" => {
            let text = v.get("text").and_then(Value::as_str).ok_or("falta «text»")?;
            if text.chars().count() > MAX_TYPE_CHARS {
                return Err(format!("texto de más de {MAX_TYPE_CHARS} caracteres"));
            }
            let d = Driver::new(app);
            d.act("type", None);
            win::type_text(text)?;
            Ok(json!({}))
        }
        "key" => {
            let combo = v.get("combo").and_then(Value::as_str).ok_or("falta «combo»")?;
            let vks = super::keys::parse_combo(combo)?;
            let d = Driver::new(app);
            d.act("key", None);
            win::key_combo(&vks)?;
            Ok(json!({}))
        }
        other => Err(format!("acción desconocida: {other}")),
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

    #[test]
    fn parsea_una_peticion_con_cuerpo() {
        let raw = b"POST /v1/action HTTP/1.1\r\nHost: x\r\nX-Ultron-Token: abc\r\nContent-Length: 20\r\n\r\n{\"action\":\"cursor\"}X";
        let r = parse_request(&mut &raw[..]).unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/v1/action");
        assert_eq!(r.header("x-ultron-token"), Some("abc"));
        assert_eq!(r.body.len(), 20);
    }

    #[test]
    fn sin_token_o_desde_navegador_no_ejecuta_nada() {
        let mut ran = false;
        let (s, _) = route(
            &req("POST", "/v1/action", &[], "{}"),
            "tok",
            |_| {
                ran = true;
                json!({})
            },
        );
        assert_eq!(s, 401);
        let (s, _) = route(
            &req(
                "POST",
                "/v1/action",
                &[("X-Ultron-Token", "tok"), ("Origin", "https://evil")],
                "{}",
            ),
            "tok",
            |_| {
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
            |v| json!({"echo": v["action"]}),
        );
        assert_eq!(s, 200);
        assert_eq!(v["echo"], "cursor");
    }
}
