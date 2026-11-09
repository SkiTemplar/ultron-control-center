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
// ALCANCE REAL: solo Windows. La ventana vive en un monitor y salta al de
// al lado cuando Pupus cruza un borde (screens.rs). En otros sistemas
// la ventana puede abrirse pero sin cursor global ni ventanas, y el puente
// del MCP responde con un error explícito.

pub mod alerts;
pub mod approve;
pub mod bridge;
pub mod build_detect;
pub mod calendar;
pub mod calendar_fetch;
pub mod calendar_kanban;
pub mod calls;
pub mod capture;
pub mod chat;
pub mod chat_gate;
pub mod chat_log;
pub mod context;
pub mod course;
pub mod deliveries;
pub mod desk_watch;
pub mod drive;
pub mod drop_assist;
pub mod explorer;
pub mod games;
pub mod guardrail;
pub mod ics;
pub mod image;
pub mod keys;
pub mod media;
pub mod open;
pub mod page;
pub mod permission;
pub mod presence;
pub mod screens;
pub mod sessions_surfaces;
pub mod sessions_windows;
pub mod shellhook;
pub mod targets;
pub mod taskbar;
pub mod taskbar_islands;
pub mod taskbar_uia;
pub mod test_results;
pub mod transcripts;
pub mod win;
pub mod win_fg;
pub mod zorder;

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
    /// Colgado de una chincheta: false = tranquilo, brazos abajo; true =
    /// patalea para soltarse.
    pub hang_struggle: bool,
    /// Gorros según la ventana activa, la temporada y la noche.
    pub hats: bool,
    /// De vez en cuando se agarra al cursor y tira un poco de él.
    pub cursor_pranks: bool,
    /// Modelo para `claude -p` ("" = el de la CLI). Por defecto Sonnet 5.5:
    /// la CLI hereda Opus de ~/.claude/settings.json, caro para el chat de Pupus.
    pub claude_model: String,
    /// Modelo para `codex exec` ("" = el de ~/.codex/config.toml).
    pub codex_model: String,
    /// Con un juego delante, Pupus no molesta (games.rs, desk_watch.rs).
    pub game_mode: bool,
    /// Juegos conocidos y su disfraz. Vive en el struct para que guardar
    /// los ajustes no borre la tabla de mascot.json.
    pub games: Vec<games::GameEntry>,
    /// Va a señalar en la barra de tareas el botón que reclama atención.
    pub taskbar_hints: bool,
    /// Barra de tareas transparente con islas: la ventana baja hasta el
    /// borde de la pantalla, las islas (botones y bandeja) son plataformas y
    /// en los huecos se apoya abajo del todo (taskbar.rs, useDesktopWindows.ts).
    pub taskbar_islands: bool,
    /// Sale en grabaciones y capturas de pantalla (no en las del MCP de
    /// escritorio, capture.rs).
    pub capturable: bool,
    /// Se esconde mientras alguna aplicación usa el micrófono (calls.rs).
    pub hide_in_calls: bool,
    /// Avisa de builds y tests en rojo (alerts.rs).
    pub build_alerts: bool,
    /// Avisa de entregas del calendario de la uni (calendar.rs).
    pub calendar: bool,
    /// Su ánimo reacciona a lo que haces (presence.rs + ventana delante).
    pub ambient_mood: bool,
    /// Actividades por su cuenta: leer, pescar, malabares, avión de papel…
    pub activities: bool,
    /// Baila cuando suena música (media.rs).
    pub music_dance: bool,
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
            hang_struggle: false,
            hats: true,
            cursor_pranks: true,
            claude_model: "claude-sonnet-5-5".into(),
            codex_model: String::new(),
            game_mode: true,
            games: games::default_games(),
            taskbar_hints: true,
            taskbar_islands: false,
            capturable: true,
            hide_in_calls: true,
            build_alerts: true,
            calendar: true,
            ambient_mood: true,
            activities: true,
            music_dance: true,
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
        self.games = games::normalize_games(self.games);
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
    screens::work_area(app)
}

/// Ajusta la ventana al área de trabajo actual (cambia al mover la barra de
/// tareas, cambiar la resolución o el escalado). Con `taskbar_islands` y la
/// barra abajo, baja hasta el borde de la pantalla y cubre la barra.
fn fit_to_work_area(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<MascotEnv, String> {
    let (pos, mut size, scale) = work_area(app)?;
    if load_settings().taskbar_islands {
        let bottom = screens::monitor_bottom(app)?;
        size.height = screens::mascot_height(pos.y, size.height, bottom, true);
    }
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
        return page::show_if_allowed(&w);
    }
    page::mark_created(app);
    let window = WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("/mascot".into()))
        .title("ULTRON · Pupus")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        // Se enseña al terminar de cargar la página (page.rs), no antes.
        .on_page_load(page::on_page_load)
        .build()
        .map_err(|e| format!("crear ventana de la mascota: {e}"))?;
    // Dictado por voz del chat: WebView2 pide permiso de micrófono; se concede
    // como en Sessions (solo al origen de la app), sin diálogo propio.
    crate::sesiones::ventana::conceder_microfono(&window);
    fit_to_work_area(app, &window)?;
    // Empieza atravesable: hasta que la webview diga que el cursor está
    // encima de la mascota, la ventana no debe robar ni un clic.
    let _ = window.set_ignore_cursor_events(true);
    let hwnd = hwnd_of(&window);
    MASCOT_HWND.store(hwnd, Ordering::Relaxed);
    // Sale en grabaciones según el ajuste; las capturas del MCP lo excluyen
    // siempre (capture.rs).
    capture::apply(hwnd, load_settings().capturable);
    // La página puede haber terminado de cargar mientras se ajustaba.
    page::show_if_allowed(&window)
}

pub fn close_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
    MASCOT_HWND.store(0, Ordering::Relaxed);
}

/// Arranque: puente del MCP siempre (para que el MCP funcione aunque la
/// mascota esté oculta) y la ventana si está activada. Los hilos de avisos y
/// calendario arrancan siempre, pero en cada vuelta comprueban
/// `watchers_active` y no hacen nada con la mascota apagada.
pub fn init(app: &AppHandle) {
    if let Err(e) = bridge::start(app.clone()) {
        tracing::error!(error = %e, "mascota: el puente del MCP de escritorio no arrancó");
    }
    if load_settings().enabled {
        if let Err(e) = ensure_window(app) {
            tracing::error!(error = %e, "mascota: no se pudo crear la ventana");
        }
    }
    screens::sync_shortcut(app, load_settings().enabled);
    desk_watch::start(app.clone());
    drop_assist::start(app.clone());
    calls::start(app.clone());
    alerts::start_watch(app.clone());
    calendar::start(app.clone());
}

/// Los vigilantes con coste (avisos de builds, calendario) solo trabajan con
/// la mascota activada y su ventana creada. Pura, para los tests.
pub fn watchers_active(s: &MascotSettings, has_window: bool) -> bool {
    s.enabled && has_window
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
    let was_enabled = load_settings().enabled;
    save_settings(&s)?;
    screens::sync_shortcut(&app, s.enabled);
    if s.enabled {
        ensure_window(&app)?;
        if !was_enabled {
            // Activarla es pedir verla: la ocultación manual sobrevive a cerrar
            // la ventana. Un motivo automático no es un fallo del guardado.
            let _ = screens::unhide_for_summon(&app);
        }
        capture::apply(mascot_hwnd(), s.capturable);
    } else {
        close_window(&app);
    }
    let _ = app.emit("mascot:settings", &s);
    Ok(s)
}

/// Trae la mascota al monitor del cursor (o al de ULTRON), la deja caer
/// junto al cursor y deshace la ocultación manual. Llamarla es pedir verla:
/// si estaba apagada, queda activada también en mascot.json. Error si la tapa
/// un motivo automático (pantalla completa, micrófono).
#[tauri::command]
pub async fn mascot_summon(app: AppHandle) -> Result<(), String> {
    let mut s = load_settings();
    if !s.enabled {
        s.enabled = true;
        save_settings(&s)?;
        screens::sync_shortcut(&app, true);
        let _ = app.emit("mascot:settings", &s);
    }
    ensure_window(&app)?;
    let point = screens::summon_point(win::cursor_state().map(|c| (c.x, c.y)), main_center(&app));
    // Si la mudanza falla, cae en su monitor de siempre.
    let env = point.and_then(|(x, y)| screens::move_to_point(&app, x, y).ok());
    let x = env.as_ref().and_then(|e| screens::summon_x(e, point));
    let shown = screens::unhide_for_summon(&app);
    app.emit_to(
        LABEL,
        "mascot:summon",
        serde_json::json!({ "env": env, "x": x }),
    )
    .map_err(|e| e.to_string())?;
    shown
}

/// Centro físico de la ventana principal de ULTRON, si se ve.
fn main_center(app: &AppHandle) -> Option<(i32, i32)> {
    let w = app.get_webview_window("main")?;
    if w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(false) {
        return None;
    }
    let p = w.outer_position().ok()?;
    let s = w.outer_size().ok()?;
    Some((p.x + s.width as i32 / 2, p.y + s.height as i32 / 2))
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

/// Travesura: mueve el cursor a (x, y) físicos. La webview lo hace a
/// pasitos durante medio segundo y para en cuanto el usuario mueve el ratón.
#[tauri::command]
pub fn mascot_nudge_cursor(x: i32, y: i32) -> Result<(), String> {
    if !load_settings().cursor_pranks {
        return Err("travesuras con el cursor desactivadas".into());
    }
    win::move_cursor(x, y)
}

/// Clic derecho en Pupus → «Ajustes»: trae la ventana principal y le pide
/// que abra Settings → Pupus (App.tsx escucha `mascot:open-settings`).
#[tauri::command]
pub fn mascot_open_settings(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "la ventana principal no existe".to_string())?;
    let _ = main.unminimize();
    main.show().map_err(|e| e.to_string())?;
    let _ = main.set_focus();
    app.emit_to("main", "mascot:open-settings", ())
        .map_err(|e| e.to_string())
}

/// Abre un enlace del bocadillo en el navegador. Solo web y correo: la
/// ventana de la mascota no tiene el plugin opener (capabilities/mascot.json),
/// así que este es su único camino y no abre rutas ni programas.
#[tauri::command]
pub async fn mascot_open_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !is_web_link(&url) {
        return Err(format!("solo se abren enlaces web: {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

fn is_web_link(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    ["https://", "http://", "mailto:"]
        .iter()
        .any(|p| lower.starts_with(p))
}

#[tauri::command]
pub async fn mascot_ask(
    agent: chat::Agent,
    history: Vec<chat::Turn>,
    message: String,
    with_files: Option<bool>,
    tainted: Option<bool>,
) -> Result<chat::AskResult, String> {
    let settings = load_settings();
    let with_files = with_files.unwrap_or(false);
    // Una webview que no mande la marca con historial no limpia la conversación.
    let tainted = tainted.unwrap_or(!history.is_empty());
    tauri::async_runtime::spawn_blocking(move || {
        chat::ask(agent, &history, &message, &settings, with_files, tainted)
    })
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
pub async fn mascot_bridge_status() -> Result<BridgeStatus, String> {
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
            chat::scrub_cli_env(
                &mut cmd,
                chat::Agent::Claude,
                crate::sesiones::motores::variables_de_la_app(),
            );
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            crate::ai_router::exec::run_with_timeout(cmd, std::time::Duration::from_secs(30), None)
        };
        // Quitar el registro previo (si no existía, falla y da igual).
        let _ = run(["mcp", "remove", "--scope", "user", "ultron-desktop"]
            .iter()
            .map(|s| s.to_string())
            .collect());
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
    fn un_mascot_json_antiguo_activa_grabaciones_llamadas_y_avisos() {
        let s: MascotSettings = serde_json::from_str(r#"{"scale":4,"hats":true}"#).unwrap();
        assert!(s.capturable && s.hide_in_calls && s.build_alerts && s.calendar && s.ambient_mood);
    }

    #[test]
    fn un_mascot_json_antiguo_activa_actividades_y_baile() {
        let s: MascotSettings =
            serde_json::from_str(r#"{"scale":4,"ambient_mood":false}"#).unwrap();
        assert!(s.activities && s.music_dance);
        // Caso negativo: un false explícito se respeta.
        let off: MascotSettings =
            serde_json::from_str(r#"{"activities":false,"music_dance":false}"#).unwrap();
        assert!(!off.activities && !off.music_dance);
    }

    #[test]
    fn un_capturable_false_explicito_se_conserva() {
        let s: MascotSettings =
            serde_json::from_str(r#"{"capturable":false,"calendar":false}"#).unwrap();
        assert!(!s.capturable && !s.calendar);
        assert!(s.hide_in_calls && s.build_alerts);
    }

    #[test]
    fn solo_abre_enlaces_web() {
        assert!(is_web_link("https://example.com/x"));
        assert!(is_web_link("  HTTP://a.b"));
        assert!(is_web_link("mailto:a@b.c"));
        assert!(!is_web_link("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_web_link("C:\\Windows\\notepad.exe"));
        assert!(!is_web_link("javascript:alert(1)"));
    }

    #[test]
    fn el_registro_del_mcp_apunta_al_script() {
        let a = register_args("C:/x/server.mjs");
        assert_eq!(
            &a[..5],
            &["mcp", "add", "--scope", "user", "ultron-desktop"]
        );
        assert_eq!(a.last().unwrap(), "C:/x/server.mjs");
    }
}
