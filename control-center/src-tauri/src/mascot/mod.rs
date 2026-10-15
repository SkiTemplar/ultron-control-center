// ULTRON Control Center — Mascota de escritorio.
//
// Una ventana transparente, sin bordes y siempre encima («mascot») que cubre
// el ÁREA DE TRABAJO del monitor principal: el borde inferior de la ventana
// es el borde superior de la barra de tareas, así que la mascota camina
// sobre ella sin taparla. La ventana ignora el ratón (los clics atraviesan)
// salvo cuando el cursor está encima de la mascota o de sus bocadillos: la
// webview pregunta el cursor global (`mascot_cursor`) y lo pide con
// `mascot_set_interactive`.
//
// Piezas:
//   * win.rs    — Win32: cursor, ventanas del escritorio, entrada y captura.
//   * chat.rs   — botones Claude / Codex / Antigravity.
//   * bridge.rs — servidor HTTP local para el MCP de escritorio
//                 (tools/ultron-desktop-mcp): cuando Claude mueve el ratón,
//                 la mascota «lleva» el cursor.
//   * keys.rs / image.rs — utilidades puras (con tests).
//
// La física, las animaciones y el comportamiento viven en la webview
// (`src/components/mascot/`). Ajustes en ~/.ultron/cockpit/mascot.json,
// editables en Settings → Mascota.
//
// ALCANCE REAL: solo Windows y solo el monitor principal. En otros sistemas
// la ventana puede abrirse pero sin cursor global ni ventanas, y el puente
// del MCP responde con un error explícito.

pub mod bridge;
pub mod chat;
pub mod image;
pub mod keys;
pub mod win;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindowBuilder};

pub const LABEL: &str = "mascot";

/// HWND de la ventana de la mascota (0 = no existe). Se excluye de la
/// lista de ventanas sobre las que puede subirse (sería su propio suelo).
static MASCOT_HWND: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MascotSettings {
    /// Mostrar la mascota.
    pub enabled: bool,
    /// Píxeles de pantalla por píxel del sprite (2..=8).
    pub scale: u32,
    /// Pasea sola cuando nadie le hace caso.
    pub wander: bool,
    /// Puede subirse y caminar por el borde superior de las ventanas.
    pub climb_windows: bool,
    /// Las ventanas son sólidas: al lanzarla choca y se estampa contra sus
    /// laterales y su parte de abajo, no solo contra la pantalla.
    pub collide_windows: bool,
    /// Salta a ventanas cercanas por su cuenta.
    pub jump: bool,
    /// Se queda «espachurrada» al chocar fuerte.
    pub splat: bool,
    /// Multiplicador de gravedad (0.3..=2.5).
    pub gravity: f64,
    /// Rebote (0 = nada, 0.9 = pelota).
    pub bounciness: f64,
    /// Los ojos siguen al cursor.
    pub eyes_follow_cursor: bool,
    /// Minutos sin interacción antes de dormirse (0 = nunca).
    pub sleep_after_min: u32,
    /// Cuando un agente usa el MCP de escritorio, la mascota lleva el cursor.
    pub drive_with_mcp: bool,
    /// Modelo para `claude -p` ("" = el de la CLI).
    pub claude_model: String,
    /// Modelo para `codex exec` ("" = el de ~/.codex/config.toml).
    pub codex_model: String,
}

impl Default for MascotSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            scale: 4,
            wander: true,
            climb_windows: true,
            collide_windows: false,
            jump: true,
            splat: true,
            gravity: 1.0,
            bounciness: 0.45,
            eyes_follow_cursor: true,
            sleep_after_min: 3,
            drive_with_mcp: true,
            claude_model: String::new(),
            codex_model: String::new(),
        }
    }
}

impl MascotSettings {
    pub fn normalized(mut self) -> Self {
        self.scale = self.scale.clamp(2, 8);
        self.gravity = if self.gravity.is_finite() {
            self.gravity.clamp(0.3, 2.5)
        } else {
            1.0
        };
        self.bounciness = if self.bounciness.is_finite() {
            self.bounciness.clamp(0.0, 0.9)
        } else {
            0.45
        };
        self.sleep_after_min = self.sleep_after_min.min(120);
        self.claude_model = self.claude_model.trim().to_string();
        self.codex_model = self.codex_model.trim().to_string();
        self
    }
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(crate::ultron_root()?.join("cockpit").join("mascot.json"))
}

pub fn load_settings() -> MascotSettings {
    settings_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<MascotSettings>(&s).ok())
        .unwrap_or_default()
        .normalized()
}

fn save_settings(s: &MascotSettings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("crear {}: {e}", dir.display()))?;
    }
    let body = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("escribir {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("renombrar {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Ventana
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct MascotEnv {
    /// Origen y tamaño del área de trabajo (píxeles físicos de pantalla).
    pub origin_x: i32,
    pub origin_y: i32,
    pub width: u32,
    pub height: u32,
    /// Factor de escala del monitor (píxeles físicos por píxel CSS).
    pub scale_factor: f64,
    /// false fuera de Windows: sin cursor global ni ventanas.
    pub supported: bool,
}

fn hwnd_of(window: &tauri::WebviewWindow) -> u64 {
    #[cfg(target_os = "windows")]
    {
        window.hwnd().map(|h| h.0 as usize as u64).unwrap_or(0)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        0
    }
}

fn work_area(app: &AppHandle) -> Result<(PhysicalPosition<i32>, PhysicalSize<u32>, f64), String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("monitor: {e}"))?
        .ok_or_else(|| "no hay monitor principal".to_string())?;
    let area = monitor.work_area();
    Ok((area.position, area.size, monitor.scale_factor()))
}

/// Ajusta la ventana al área de trabajo actual (cambia al mover la barra de
/// tareas, cambiar la resolución o el escalado).
fn fit_to_work_area(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<MascotEnv, String> {
    let (pos, size, scale) = work_area(app)?;
    let cur_pos = window.outer_position().ok();
    let cur_size = window.outer_size().ok();
    if cur_pos != Some(pos) {
        window.set_position(pos).map_err(|e| e.to_string())?;
    }
    if cur_size != Some(size) {
        window.set_size(size).map_err(|e| e.to_string())?;
    }
    Ok(MascotEnv {
        origin_x: pos.x,
        origin_y: pos.y,
        width: size.width,
        height: size.height,
        scale_factor: scale,
        supported: cfg!(target_os = "windows"),
    })
}

/// Crea (o muestra) la ventana de la mascota.
pub fn ensure_window(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        fit_to_work_area(app, &w)?;
        w.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("/mascot".into()))
        .title("ULTRON · mascota")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| format!("crear ventana de la mascota: {e}"))?;
    fit_to_work_area(app, &window)?;
    // Empieza atravesable: hasta que la webview diga que el cursor está
    // encima de la mascota, la ventana no debe robar ni un clic.
    let _ = window.set_ignore_cursor_events(true);
    let hwnd = hwnd_of(&window);
    MASCOT_HWND.store(hwnd, Ordering::Relaxed);
    if hwnd != 0 && !win::exclude_from_capture(hwnd) {
        // Windows < 10 2004: la mascota saldrá en las capturas del MCP.
        tracing::warn!("mascota: WDA_EXCLUDEFROMCAPTURE no disponible");
    }
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn close_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
    MASCOT_HWND.store(0, Ordering::Relaxed);
}

/// Arranque: puente del MCP siempre (para que el MCP funcione aunque la
/// mascota esté oculta) y la ventana si está activada.
pub fn init(app: &AppHandle) {
    if let Err(e) = bridge::start(app.clone()) {
        tracing::error!(error = %e, "mascota: el puente del MCP de escritorio no arrancó");
    }
    if load_settings().enabled {
        if let Err(e) = ensure_window(app) {
            tracing::error!(error = %e, "mascota: no se pudo crear la ventana");
        }
    }
}

pub(crate) fn mascot_hwnd() -> u64 {
    MASCOT_HWND.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// Comandos Tauri
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mascot_get_settings() -> MascotSettings {
    load_settings()
}

#[tauri::command]
pub async fn mascot_save_settings(
    app: AppHandle,
    settings: MascotSettings,
) -> Result<MascotSettings, String> {
    let s = settings.normalized();
    save_settings(&s)?;
    if s.enabled {
        ensure_window(&app)?;
    } else {
        close_window(&app);
    }
    let _ = app.emit("mascot:settings", &s);
    Ok(s)
}

/// Trae la mascota al centro de la pantalla (y la muestra si estaba oculta).
#[tauri::command]
pub async fn mascot_summon(app: AppHandle) -> Result<(), String> {
    ensure_window(&app)?;
    app.emit_to(LABEL, "mascot:summon", ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mascot_env(app: AppHandle) -> Result<MascotEnv, String> {
    let w = app
        .get_webview_window(LABEL)
        .ok_or_else(|| "la ventana de la mascota no existe".to_string())?;
    fit_to_work_area(&app, &w)
}

// Cursor y ventanas: async para que el sondeo (60 Hz y 4 Hz) corra en el
// pool de tareas y no compita con el hilo principal de la app.
#[tauri::command]
pub async fn mascot_cursor(app: AppHandle) -> Option<win::CursorState> {
    if let Some(c) = win::cursor_state() {
        return Some(c);
    }
    // Fuera de Windows: posición sí, teclas no.
    app.cursor_position().ok().map(|p| win::CursorState {
        x: p.x.round() as i32,
        y: p.y.round() as i32,
        ..Default::default()
    })
}

#[tauri::command]
pub async fn mascot_windows() -> Vec<win::WinRect> {
    win::desktop_windows(&[mascot_hwnd()])
}

/// `true` = la ventana recibe el ratón (cursor encima de la mascota o de un
/// bocadillo); `false` = los clics la atraviesan.
#[tauri::command]
pub fn mascot_set_interactive(app: AppHandle, interactive: bool) -> Result<(), String> {
    let w = app
        .get_webview_window(LABEL)
        .ok_or_else(|| "la ventana de la mascota no existe".to_string())?;
    w.set_ignore_cursor_events(!interactive)
        .map_err(|e| e.to_string())
}

/// Foco de teclado para el cuadro de texto (la ventana nace sin foco para no
/// robárselo a lo que estés usando).
#[tauri::command]
pub fn mascot_focus(app: AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window(LABEL)
        .ok_or_else(|| "la ventana de la mascota no existe".to_string())?;
    w.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mascot_ask(
    agent: chat::Agent,
    history: Vec<chat::Turn>,
    message: String,
) -> Result<chat::AskResult, String> {
    let settings = load_settings();
    tauri::async_runtime::spawn_blocking(move || chat::ask(agent, &history, &message, &settings))
        .await
        .map_err(|e| format!("tarea interrumpida: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeStatus {
    pub running: bool,
    pub port: u16,
    pub info_file: String,
    pub mcp_script: String,
    pub mcp_script_exists: bool,
    pub register_command: String,
}

fn mcp_script_path() -> Result<PathBuf, String> {
    Ok(crate::ultron_root()?
        .join("tools")
        .join("ultron-desktop-mcp")
        .join("server.mjs"))
}

fn register_args(script: &str) -> Vec<String> {
    [
        "mcp",
        "add",
        "--scope",
        "user",
        "ultron-desktop",
        "--",
        "node",
        script,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[tauri::command]
pub fn mascot_bridge_status() -> Result<BridgeStatus, String> {
    let script = mcp_script_path()?;
    let script_s = script.to_string_lossy().to_string();
    Ok(BridgeStatus {
        running: bridge::port().is_some(),
        port: bridge::port().unwrap_or(0),
        info_file: bridge::info_path()?.to_string_lossy().to_string(),
        mcp_script_exists: script.is_file(),
        register_command: format!(
            "claude mcp add --scope user ultron-desktop -- node \"{script_s}\""
        ),
        mcp_script: script_s,
    })
}

/// Registra el MCP de escritorio en Claude Code (ámbito usuario). Si ya
/// existía, lo sustituye para que apunte a este script.
#[tauri::command]
pub async fn mascot_register_mcp() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let script = mcp_script_path()?;
        if !script.is_file() {
            return Err(format!(
                "No encuentro {} (¿repo de ULTRON fuera de ~/.ultron?)",
                script.display()
            ));
        }
        let script_s = script.to_string_lossy().to_string();
        #[cfg(target_os = "windows")]
        let prog = crate::ai_router::exec::resolve_windows_cli_program("claude");
        #[cfg(not(target_os = "windows"))]
        let prog = "claude".to_string();
        let run = |args: Vec<String>| {
            let mut cmd = std::process::Command::new(&prog);
            cmd.args(&args);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            crate::ai_router::exec::run_with_timeout(cmd, std::time::Duration::from_secs(30), None)
        };
        // Quitar el registro previo (si no existía, falla y da igual).
        let _ = run(
            ["mcp", "remove", "--scope", "user", "ultron-desktop"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        );
        let out = run(register_args(&script_s)).map_err(|e| format!("claude: {e}"))?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        if out.status.success() {
            Ok(text.trim().to_string())
        } else {
            Err(format!("claude mcp add falló: {}", text.trim()))
        }
    })
    .await
    .map_err(|e| format!("tarea interrumpida: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normaliza_valores_fuera_de_rango() {
        let s = MascotSettings {
            scale: 40,
            gravity: f64::NAN,
            bounciness: 3.0,
            sleep_after_min: 9999,
            claude_model: "  opus ".into(),
            ..Default::default()
        }
        .normalized();
        assert_eq!(s.scale, 8);
        assert_eq!(s.gravity, 1.0);
        assert_eq!(s.bounciness, 0.9);
        assert_eq!(s.sleep_after_min, 120);
        assert_eq!(s.claude_model, "opus");
    }

    #[test]
    fn un_json_parcial_rellena_con_los_valores_por_defecto() {
        let s: MascotSettings = serde_json::from_str(r#"{"scale":6,"jump":false}"#).unwrap();
        assert_eq!(s.scale, 6);
        assert!(!s.jump);
        assert!(s.enabled && s.climb_windows && s.drive_with_mcp);
    }

    #[test]
    fn el_registro_del_mcp_apunta_al_script() {
        let a = register_args("C:/x/server.mjs");
        assert_eq!(&a[..5], &["mcp", "add", "--scope", "user", "ultron-desktop"]);
        assert_eq!(a.last().unwrap(), "C:/x/server.mjs");
    }
}
