// Mascota — pantallas: en qué monitor vive la ventana, saltar al de al lado
// y esconderse.
//
// La ventana cubre el área de trabajo de UN monitor (con DPI mezclados, una
// ventana que cruzara varios pintaría a Pupus con la escala de uno solo).
// Cuando Pupus cruza un borde que da a otro monitor (volando, cayendo o
// arrastrado), la webview pide `mascot_move_to_screen` con un punto físico
// del monitor de destino y la ventana se muda allí.
//
// Esconderse: Ctrl+Alt+P (registrado solo con Pupus activado) lo oculta o lo
// muestra a mano, y el vigilante del escritorio (desk_watch.rs) lo oculta
// solo mientras haya una ventana a pantalla completa (juego, vídeo,
// presentación) en primer plano en SU monitor, o un juego en ventana que le
// deje sin suelo; y el vigilante de
// llamadas (calls.rs), mientras alguna aplicación usa el micrófono. Cada
// motivo es un bit de AUTO_REASONS: Pupus vuelve solo cuando no queda ninguno.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use super::{MascotEnv, LABEL};

/// Esquina superior izquierda (física) del monitor donde vive la ventana.
/// `None` = el principal.
static CURRENT: Mutex<Option<(i32, i32)>> = Mutex::new(None);
static MANUAL_HIDDEN: AtomicBool = AtomicBool::new(false);
/// Motivos de auto-ocultación activos (máscara de bits).
static AUTO_REASONS: AtomicU8 = AtomicU8::new(0);
/// Ctrl+Alt+P registrado, según el último `sync_shortcut`. Copia propia
/// porque `is_registered` toma el `Mutex` de atajos del plugin, y el plugin
/// llama a `handle_shortcut` con ese `Mutex` todavía tomado: preguntarle
/// desde ahí bloqueaba el hilo principal (todas las ventanas congeladas).
static SHORTCUT_REGISTERED: AtomicBool = AtomicBool::new(false);

/// Pantalla completa o juego sin suelo (desk_watch.rs).
pub const FULLSCREEN: u8 = 1;
/// Micrófono en uso (calls.rs).
pub const CALL: u8 = 2;

pub fn is_hidden() -> bool {
    MANUAL_HIDDEN.load(Ordering::SeqCst) || AUTO_REASONS.load(Ordering::SeqCst) != 0
}

/// Motivo de ocultación vigente ("manual", "call" o "fullscreen"), o `None`.
pub fn hidden_reason() -> Option<&'static str> {
    reason_label(
        MANUAL_HIDDEN.load(Ordering::SeqCst),
        AUTO_REASONS.load(Ordering::SeqCst),
    )
}

/// Máscara con el motivo `bit` puesto o quitado. Pura, para los tests.
pub fn with_reason(mask: u8, bit: u8, on: bool) -> u8 {
    if on {
        mask | bit
    } else {
        mask & !bit
    }
}

/// Motivo que se cuenta a la webview: el manual manda; luego la llamada.
fn reason_label(manual: bool, mask: u8) -> Option<&'static str> {
    if manual {
        Some("manual")
    } else if mask & CALL != 0 {
        Some("call")
    } else if mask & FULLSCREEN != 0 {
        Some("fullscreen")
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ScreenInfo {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub work_x: i32,
    pub work_y: i32,
    pub work_width: u32,
    pub work_height: u32,
    pub scale: f64,
    pub current: bool,
}

fn current_key() -> Option<(i32, i32)> {
    *CURRENT.lock().unwrap_or_else(|p| p.into_inner())
}

fn set_current(key: (i32, i32)) {
    *CURRENT.lock().unwrap_or_else(|p| p.into_inner()) = Some(key);
}

fn monitor_list(app: &AppHandle) -> Result<Vec<tauri::Monitor>, String> {
    let list = app
        .available_monitors()
        .map_err(|e| format!("monitores: {e}"))?;
    if list.is_empty() {
        return Err("no hay monitores".into());
    }
    Ok(list)
}

/// Monitor donde vive la ventana (el principal si no se ha movido o si el
/// suyo ya no existe: monitor desconectado).
fn current_monitor(app: &AppHandle) -> Result<tauri::Monitor, String> {
    let list = monitor_list(app)?;
    if let Some((x, y)) = current_key() {
        if let Some(m) = list
            .iter()
            .find(|m| m.position().x == x && m.position().y == y)
        {
            return Ok(m.clone());
        }
    }
    app.primary_monitor()
        .map_err(|e| format!("monitor: {e}"))?
        .or_else(|| list.into_iter().next())
        .ok_or_else(|| "no hay monitor principal".to_string())
}

/// Área de trabajo del monitor actual: (posición, tamaño, escala).
pub fn work_area(
    app: &AppHandle,
) -> Result<(PhysicalPosition<i32>, PhysicalSize<u32>, f64), String> {
    let m = current_monitor(app)?;
    let area = m.work_area();
    Ok((area.position, area.size, m.scale_factor()))
}

/// Borde inferior (px físicos) del monitor actual.
pub fn monitor_bottom(app: &AppHandle) -> Result<i32, String> {
    let m = current_monitor(app)?;
    Ok(m.position().y + m.size().height as i32)
}

/// Alto de la ventana de la mascota: el del área de trabajo o, con las islas
/// de la barra y la barra abajo (el área acaba antes que el monitor), hasta
/// el borde de la pantalla. Pura, para los tests.
pub fn mascot_height(work_y: i32, work_h: u32, monitor_bottom: i32, islands: bool) -> u32 {
    let work_bottom = work_y + work_h as i32;
    if islands && monitor_bottom > work_bottom {
        (monitor_bottom - work_y) as u32
    } else {
        work_h
    }
}

/// Índice del rectángulo que contiene el punto. Pura, para los tests.
pub fn screen_at(rects: &[(i32, i32, u32, u32)], px: i32, py: i32) -> Option<usize> {
    rects
        .iter()
        .position(|&(x, y, w, h)| px >= x && px < x + w as i32 && py >= y && py < y + h as i32)
}

#[tauri::command]
pub fn mascot_screens(app: AppHandle) -> Result<Vec<ScreenInfo>, String> {
    let cur = current_monitor(&app)?;
    let cur_pos = *cur.position();
    Ok(monitor_list(&app)?
        .iter()
        .map(|m| {
            let a = m.work_area();
            ScreenInfo {
                x: m.position().x,
                y: m.position().y,
                width: m.size().width,
                height: m.size().height,
                work_x: a.position.x,
                work_y: a.position.y,
                work_width: a.size.width,
                work_height: a.size.height,
                scale: m.scale_factor(),
                current: *m.position() == cur_pos,
            }
        })
        .collect())
}

/// Muda la ventana al monitor que contiene el punto físico (x, y).
#[tauri::command]
pub fn mascot_move_to_screen(app: AppHandle, x: i32, y: i32) -> Result<MascotEnv, String> {
    move_to_point(&app, x, y)
}

/// Punto físico al que llamar a Pupus: el del cursor (quien pulsa «Llamar»
/// está ahí) o, sin cursor, el centro de la ventana de ULTRON. Pura.
pub fn summon_point(
    cursor: Option<(i32, i32)>,
    main_center: Option<(i32, i32)>,
) -> Option<(i32, i32)> {
    cursor.or(main_center)
}

/// X (CSS de la ventana de Pupus) donde cae al llamarlo: la del punto si
/// está en su área de trabajo. Pura, para los tests.
pub fn summon_x(env: &MascotEnv, point: Option<(i32, i32)>) -> Option<f64> {
    let (px, py) = point?;
    let inside = px >= env.origin_x
        && px < env.origin_x + env.width as i32
        && py >= env.origin_y
        && py < env.origin_y + env.height as i32;
    (inside && env.scale_factor > 0.0).then(|| (px - env.origin_x) as f64 / env.scale_factor)
}

pub(super) fn move_to_point(app: &AppHandle, x: i32, y: i32) -> Result<MascotEnv, String> {
    let list = monitor_list(app)?;
    let rects: Vec<_> = list
        .iter()
        .map(|m| {
            (
                m.position().x,
                m.position().y,
                m.size().width,
                m.size().height,
            )
        })
        .collect();
    let i = screen_at(&rects, x, y).ok_or_else(|| format!("no hay monitor en ({x}, {y})"))?;
    set_current((rects[i].0, rects[i].1));
    let w = app
        .get_webview_window(LABEL)
        .ok_or_else(|| "la ventana de la mascota no existe".to_string())?;
    super::fit_to_work_area(app, &w)
}

// ---------------------------------------------------------------------------
// Esconderse
// ---------------------------------------------------------------------------

fn hide_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyP)
}

fn apply_visibility(app: &AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else {
        return;
    };
    let hidden = is_hidden();
    // Mostrar solo con la página cargada: si no, se vería el fondo negro.
    let _ = if hidden {
        w.hide().map_err(|e| e.to_string())
    } else {
        super::page::show_if_allowed(&w)
    };
    // A todas las ventanas: Settings → Pupus enseña el motivo.
    let _ = app.emit("mascot:hidden", hidden_status());
}

/// Estado de ocultación a partir de los atómicos, sin pasar por el plugin de
/// atajos: se llama desde `handle_shortcut` (ver `SHORTCUT_REGISTERED`).
fn hidden_status() -> HiddenStatus {
    let manual = MANUAL_HIDDEN.load(Ordering::SeqCst);
    HiddenStatus {
        hidden: is_hidden(),
        manual,
        reason: reason_label(manual, AUTO_REASONS.load(Ordering::SeqCst)),
        shortcut: SHORTCUT_REGISTERED.load(Ordering::SeqCst),
    }
}

/// Estado de ocultación para Settings → Pupus.
#[derive(Debug, Clone, Serialize)]
pub struct HiddenStatus {
    pub hidden: bool,
    pub manual: bool,
    /// "manual", "call", "fullscreen" o nada.
    pub reason: Option<&'static str>,
    /// Ctrl+Alt+P registrado (solo con Pupus activado).
    pub shortcut: bool,
}

#[tauri::command]
pub fn mascot_hidden_status() -> HiddenStatus {
    hidden_status()
}

/// Esconder o mostrar a mano (Ctrl+Alt+P o Settings).
#[tauri::command]
pub fn mascot_set_hidden(app: AppHandle, hidden: bool) {
    MANUAL_HIDDEN.store(hidden, Ordering::SeqCst);
    apply_visibility(&app);
}

/// Motivo automático que impide enseñar a Pupus al llamarlo. Pura, para los
/// tests.
fn summon_blocker(mask: u8) -> Option<&'static str> {
    match reason_label(false, mask)? {
        "call" => Some("Pupus sigue escondido porque una aplicación usa el micrófono; vuelve solo cuando se libera."),
        _ => Some("Pupus sigue escondido por una ventana a pantalla completa (o un juego que le quita el suelo) en su monitor; vuelve solo cuando deja de estar delante."),
    }
}

/// Quita la ocultación manual y devuelve el motivo automático que quede.
fn clear_manual_hidden() -> Option<&'static str> {
    MANUAL_HIDDEN.store(false, Ordering::SeqCst);
    summon_blocker(AUTO_REASONS.load(Ordering::SeqCst))
}

/// «Llamar a la mascota» deshace la ocultación manual (Ctrl+Alt+P o el menú).
/// Error si sigue escondido por un motivo automático, para no anunciar que ha
/// vuelto cuando no se ve.
pub fn unhide_for_summon(app: &AppHandle) -> Result<(), String> {
    let blocker = clear_manual_hidden();
    apply_visibility(app);
    blocker.map_or(Ok(()), |m| Err(m.to_string()))
}

/// Atajos globales: devuelve true si era el de la mascota.
pub fn handle_shortcut(app: &AppHandle, shortcut: &Shortcut) -> bool {
    if *shortcut != hide_shortcut() {
        return false;
    }
    let now = !MANUAL_HIDDEN.load(Ordering::SeqCst);
    MANUAL_HIDDEN.store(now, Ordering::SeqCst);
    apply_visibility(app);
    true
}

/// Ctrl+Alt+P solo con Pupus activado: apagado, el atajo queda libre para
/// otras aplicaciones. Idempotente.
pub fn sync_shortcut(app: &AppHandle, enabled: bool) {
    let shortcuts = app.global_shortcut();
    let active = shortcuts.is_registered(hide_shortcut());
    let result = match (enabled, active) {
        (true, false) => shortcuts.register(hide_shortcut()),
        (false, true) => shortcuts.unregister(hide_shortcut()),
        _ => Ok(()),
    };
    if let Err(e) = result {
        tracing::warn!(error = %e, enabled, "mascota: no se pudo cambiar el registro de Ctrl+Alt+P");
    }
    SHORTCUT_REGISTERED.store(shortcuts.is_registered(hide_shortcut()), Ordering::SeqCst);
}

/// Auto-ocultación que decide el vigilante del escritorio (desk_watch.rs):
/// pantalla completa o juego sin suelo libre en el monitor de la mascota.
pub(super) fn set_auto_hidden(app: &AppHandle, hidden: bool) {
    set_auto_reason(app, FULLSCREEN, hidden);
}

/// Pone o quita un motivo de auto-ocultación. Solo toca la ventana si cambia
/// la visibilidad resultante.
pub(super) fn set_auto_reason(app: &AppHandle, bit: u8, on: bool) {
    let before = AUTO_REASONS
        .try_update(Ordering::SeqCst, Ordering::SeqCst, |m| {
            Some(with_reason(m, bit, on))
        })
        .unwrap_or(0);
    if before != with_reason(before, bit, on) {
        apply_visibility(app);
    }
}

/// Esquina superior izquierda (física) del monitor donde vive la ventana.
pub(super) fn current_corner(app: &AppHandle) -> Option<(i32, i32)> {
    current_monitor(app)
        .ok()
        .map(|m| (m.position().x, m.position().y))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mascot::win;

    #[test]
    fn el_estado_del_atajo_sale_del_atomico_y_no_del_plugin() {
        // Regresión del bloqueo del hilo principal al esconder con Ctrl+Alt+P:
        // `hidden_status` no recibe AppHandle, así que no puede volver a entrar
        // en el `Mutex` del plugin desde su propio handler.
        SHORTCUT_REGISTERED.store(true, Ordering::SeqCst);
        assert!(hidden_status().shortcut);
        SHORTCUT_REGISTERED.store(false, Ordering::SeqCst);
        assert!(
            !hidden_status().shortcut,
            "caso negativo: sin registrar no se anuncia"
        );
    }

    #[test]
    fn con_islas_y_la_barra_abajo_la_ventana_baja_hasta_el_borde() {
        // Pantalla de 1600 con la barra abajo (área de trabajo 0..1528).
        assert_eq!(mascot_height(0, 1528, 1600, true), 1600);
        // Casos negativos: sin el ajuste, o con la barra arriba o a un lado
        // (el área acaba con el monitor), se queda en el área de trabajo.
        assert_eq!(mascot_height(0, 1528, 1600, false), 1528);
        assert_eq!(mascot_height(72, 1528, 1600, true), 1528);
        assert_eq!(mascot_height(0, 1600, 1600, true), 1600);
    }

    #[test]
    fn pantalla_completa_si_tapa_el_monitor_entero() {
        let m = (0, 0, 2560, 1440);
        assert!(
            win::covers_monitor(m, m, true),
            "exacta, aunque tenga título"
        );
        assert!(
            win::covers_monitor((-8, -8, 2568, 1448), m, false),
            "sin bordes estirada"
        );
        // Caso negativo: una ventana maximizada normal (con título, que no
        // tapa la barra de tareas) no es pantalla completa.
        assert!(!win::covers_monitor((-8, -8, 2568, 1392), m, true));
        assert!(!win::covers_monitor((-8, -8, 2568, 1448), m, true));
    }

    #[test]
    fn al_colgar_no_vuelve_si_sigue_la_pantalla_completa() {
        let m = with_reason(0, FULLSCREEN, true);
        let m = with_reason(m, CALL, true);
        assert_eq!(reason_label(false, m), Some("call"));
        // Caso negativo: acabar la llamada deja el motivo de pantalla completa.
        let m = with_reason(m, CALL, false);
        assert_ne!(m, 0);
        assert_eq!(reason_label(false, m), Some("fullscreen"));
        assert_eq!(with_reason(m, FULLSCREEN, false), 0);
        assert_eq!(reason_label(true, 0), Some("manual"));
        assert_eq!(reason_label(false, 0), None);
    }

    #[test]
    fn llamar_quita_la_ocultacion_manual_pero_no_la_automatica() {
        MANUAL_HIDDEN.store(true, Ordering::SeqCst);
        AUTO_REASONS.store(0, Ordering::SeqCst);
        assert_eq!(clear_manual_hidden(), None);
        assert!(!is_hidden(), "escondido a mano: llamar lo enseña");
        // Caso negativo: con el micrófono en uso sigue oculto y se dice por qué.
        MANUAL_HIDDEN.store(true, Ordering::SeqCst);
        AUTO_REASONS.store(CALL, Ordering::SeqCst);
        let blocker = clear_manual_hidden().expect("motivo automático");
        assert!(blocker.contains("micrófono"));
        assert!(is_hidden());
        assert!(!MANUAL_HIDDEN.load(Ordering::SeqCst));
        assert!(summon_blocker(FULLSCREEN)
            .unwrap()
            .contains("pantalla completa"));
        AUTO_REASONS.store(0, Ordering::SeqCst);
    }

    fn env_at(origin_x: i32, width: u32, scale: f64) -> MascotEnv {
        MascotEnv {
            origin_x,
            origin_y: 0,
            width,
            height: 1400,
            scale_factor: scale,
            supported: true,
        }
    }

    #[test]
    fn llamar_lo_trae_al_monitor_del_cursor_o_de_ultron() {
        assert_eq!(
            summon_point(Some((10, 20)), Some((500, 500))),
            Some((10, 20))
        );
        assert_eq!(summon_point(None, Some((500, 500))), Some((500, 500)));
        assert_eq!(summon_point(None, None), None);
        // Monitor de la derecha con escala 1,5: cae bajo el cursor.
        let env = env_at(2560, 1920, 1.5);
        assert_eq!(summon_x(&env, Some((2560 + 300, 100))), Some(200.0));
        // Caso negativo: un punto en otro monitor no fija la X (cae al centro).
        assert_eq!(summon_x(&env, Some((100, 100))), None);
        assert_eq!(summon_x(&env, None), None);
    }

    #[test]
    fn encuentra_el_monitor_de_un_punto_con_monitores_a_izquierda_y_derecha() {
        // Disposición real medida el 2026-10-15: portátil a la izquierda,
        // principal en el centro y otro a la derecha (px físicos).
        let rects = [
            (-2560, 436, 2560, 1600),
            (0, 0, 2560, 1440),
            (2560, 162, 1920, 1080),
        ];
        assert_eq!(screen_at(&rects, -10, 900), Some(0));
        assert_eq!(screen_at(&rects, 0, 0), Some(1));
        assert_eq!(screen_at(&rects, 2559, 1439), Some(1));
        assert_eq!(screen_at(&rects, 2560, 500), Some(2));
        // Hueco entre monitores de distinta altura: ninguno.
        assert_eq!(screen_at(&rects, 3000, 100), None);
        assert_eq!(screen_at(&rects, -100, 100), None);
    }
}
