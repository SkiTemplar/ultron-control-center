// Mascota — acciones del MCP de escritorio que ejecuta el puente
// (bridge.rs): ratón, teclado, capturas y la mascota que «lleva» el cursor.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::mascot::drive;
use crate::mascot::image::{downscale_bgra_to_rgb, encode_png_rgb, shot_scale};
use crate::mascot::win::{self, MouseButton};

/// Una acción a la vez: dos agentes moviendo el mismo ratón a la vez solo
/// producen clics en sitios absurdos.
static ACTION_LOCK: Mutex<()> = Mutex::new(());
const MAX_TYPE_CHARS: usize = 5_000;

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
    ((x as f64 / s).round() as i64, (y as f64 / s).round() as i64)
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
        let window = app.get_webview_window(crate::mascot::LABEL);
        let animate = crate::mascot::load_settings().drive_with_mcp && window.is_some();
        let d = Self { app, animate };
        if let Some(w) = &window {
            // La ventana NO puede quedarse con el clic: atravesable ya, sin
            // esperar a la webview, y también sin animación (con el cursor
            // encima de Pupus, el SendInput caería en su ventana).
            let _ = w.set_ignore_cursor_events(true);
        }
        if animate {
            drive::begin();
            d.emit(json!({"phase": "start"}));
        } else if window.is_some() {
            // La webview no lo sabría: que no crea que sigue interactiva.
            let _ = app.emit_to(crate::mascot::LABEL, "mascot:passthrough", ());
        }
        d
    }

    fn emit(&self, payload: Value) {
        if self.animate {
            let _ = self
                .app
                .emit_to(crate::mascot::LABEL, "mascot:drive", payload);
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
        if self.animate {
            drive::schedule_end(self.app, drive::current());
        }
    }
}

fn screenshot(app: &AppHandle) -> Result<Value, String> {
    // Pupus puede salir en grabaciones, pero nunca en lo que ve el agente.
    let raw = crate::mascot::capture::without_mascot(app, win::capture_primary)?;
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

pub(super) fn run_action(app: &AppHandle, v: &Value) -> Value {
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
    if matches!(action, "screenshot" | "cursor" | "windows") {
        // El agente mira antes de la acción siguiente: Pupus no suelta el
        // cursor a mitad (efecto yoyó). Solo si ya estaba conduciendo.
        drive::keep_alive(app);
    }
    match action {
        "screenshot" => screenshot(app),
        "cursor" => {
            let c = win::cursor_state().ok_or("cursor no disponible (solo Windows)")?;
            let (x, y) = to_image(c.x, c.y);
            Ok(json!({"x": x, "y": y}))
        }
        "windows" => {
            let list: Vec<Value> = win::desktop_windows(&[crate::mascot::mascot_hwnd()])
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
            let count = v
                .get("count")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 3);
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
            let text = v
                .get("text")
                .and_then(Value::as_str)
                .ok_or("falta «text»")?;
            if text.chars().count() > MAX_TYPE_CHARS {
                return Err(format!("texto de más de {MAX_TYPE_CHARS} caracteres"));
            }
            let d = Driver::new(app);
            d.act("type", None);
            win::type_text(text)?;
            Ok(json!({}))
        }
        "key" => {
            let combo = v
                .get("combo")
                .and_then(Value::as_str)
                .ok_or("falta «combo»")?;
            let vks = crate::mascot::keys::parse_combo(combo)?;
            let d = Driver::new(app);
            d.act("key", None);
            win::key_combo(&vks)?;
            Ok(json!({}))
        }
        other => Err(format!("acción desconocida: {other}")),
    }
}
