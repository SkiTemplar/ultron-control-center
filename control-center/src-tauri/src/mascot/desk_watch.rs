// Mascota — vigilante del escritorio: un único hilo («pupus-desk») que cada
// 500 ms mira qué hay en primer plano y si la barra de tareas ha cambiado.
//
//   * Primer plano → ForegroundState (exe, título, juego de la tabla y
//     silencio) y evento `mascot:foreground` SOLO cuando cambia.
//   * Auto-ocultación: pantalla completa en el monitor de Pupus (la regla
//     de siempre) o, en modo juego, un juego en su monitor que le deja sin
//     suelo libre.
//   * Barra de tareas: huella barata de ventanas; si cambia, relectura por
//     UIA 600 ms después (los botones se animan al aparecer) y otra de
//     seguridad cada 60 s; evento `mascot:taskbar` si cambia algo. Mientras
//     dura el silencio de juego no se lee la barra.
//   * Orden Z: si una barra de tareas tapa a Pupus, lo vuelve a subir
//     (zorder.rs).
//
// Cero tokens: Win32 y ficheros. Sustituye al antiguo bucle de
// screens::start_fullscreen_watch.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::games::{self, GameEntry, QuietLatch, QuietReason};
use super::{context, screens, taskbar, win, win_fg, LABEL};

const TICK: Duration = Duration::from_millis(500);
const SETTLE: Duration = Duration::from_millis(600);
const FULL_EVERY: Duration = Duration::from_secs(60);
const SETTINGS_EVERY: u32 = 10;
/// Anchura del sprite en píxeles de sprite (cuerpo + brazos).
const PET_SPRITE_W: f64 = 16.0;

static WATCHING: AtomicBool = AtomicBool::new(false);
static REFRESHING: AtomicBool = AtomicBool::new(false);
static STATE: Mutex<Option<ForegroundState>> = Mutex::new(None);

/// Lo que Pupus sabe de la ventana en primer plano.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct ForegroundState {
    pub exe: String,
    pub title: String,
    pub hwnd: u64,
    /// AUMID explícito de la ventana («ULTRON.Sessions»), o "".
    pub app_id: String,
    pub rect: (i32, i32, i32, i32),
    pub on_mascot_monitor: bool,
    pub game: Option<GameEntry>,
    pub quiet: bool,
    pub reason: Option<QuietReason>,
    /// Carpetas de las asignaturas (para el birrete, outfits.ts).
    pub uni_keys: Vec<String>,
}

/// Último estado calculado (estado inicial de la webview).
pub fn current() -> Option<ForegroundState> {
    STATE.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// ¿Toca releer la barra? Huella cambiada y asentada `SETTLE`, primera
/// lectura, o `FULL_EVERY` desde la última. Pura, para los tests.
pub fn should_refresh(
    last_fp: u64,
    fp: u64,
    changed_at: Option<Instant>,
    now: Instant,
    last_full: Option<Instant>,
) -> bool {
    let Some(last) = last_full else { return true };
    if now.duration_since(last) >= FULL_EVERY {
        return true;
    }
    if fp == last_fp {
        return false;
    }
    changed_at.is_none_or(|c| now.duration_since(c) >= SETTLE)
}

#[derive(Default)]
struct Loop {
    latch: QuietLatch,
    settings: Option<super::MascotSettings>,
    ticks: u32,
    /// El juego (cuando se vio por última vez) le quitaba el suelo a Pupus.
    game_blocks: bool,
    seen_fp: u64,
    refreshed_fp: u64,
    changed_at: Option<Instant>,
    last_full: Option<Instant>,
    /// (hwnd, AUMID): se lee solo cuando cambia la ventana.
    aumid: (u64, String),
}

pub fn start(app: AppHandle) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    super::shellhook::start(app.clone());
    let spawned = std::thread::Builder::new()
        .name("pupus-desk".into())
        .spawn(move || {
            // MTA: el AUMID se lee con SHGetPropertyStoreForWindow (COM).
            #[cfg(target_os = "windows")]
            let _ = unsafe {
                windows::Win32::System::Com::CoInitializeEx(
                    None,
                    windows::Win32::System::Com::COINIT_MULTITHREADED,
                )
            };
            let mut st = Loop::default();
            loop {
                std::thread::sleep(TICK);
                if app.get_webview_window(LABEL).is_none() {
                    continue;
                }
                tick(&app, &mut st);
            }
        });
    if let Err(e) = spawned {
        tracing::error!(error = %e, "mascota: no arrancó el vigilante del escritorio");
    }
}

fn settings(st: &mut Loop) -> super::MascotSettings {
    if st.settings.is_none() || st.ticks.is_multiple_of(SETTINGS_EVERY) {
        st.settings = Some(super::load_settings());
    }
    st.ticks = st.ticks.wrapping_add(1);
    st.settings.clone().unwrap_or_default()
}

fn tick(app: &AppHandle, st: &mut Loop) {
    let s = settings(st);
    let now = Instant::now();
    let own = screens::current_corner(app);
    let fg = win_fg::foreground_window(super::mascot_hwnd());
    let prev = current();
    let mut fullscreen_own = false;
    if let Some(fg) = fg {
        let on_own = own == Some((fg.monitor.0, fg.monitor.1));
        let covers = !fg.shell && win::covers_monitor(fg.rect, fg.monitor, fg.has_caption);
        fullscreen_own = covers && on_own;
        let state = foreground_state(st, &s, &fg, covers, on_own, prev.as_ref(), now, app);
        publish(app, state);
    } else if let Some(mut p) = prev {
        // Foco en la propia mascota: se mantiene lo último, pero el latch
        // sigue corriendo para que el silencio pueda terminar.
        p.quiet = st.latch.update(false, now) && s.game_mode;
        publish(app, p);
    }
    let quiet = current().is_some_and(|c| c.quiet);
    screens::set_auto_hidden(app, fullscreen_own || (quiet && st.game_blocks));
    if !quiet {
        // Pupus camina sobre la barra: si la barra se ha subido por encima
        // (al activarla o al reiniciar el Explorador), vuelve a quedar debajo.
        super::zorder::raise_above_taskbar(super::mascot_hwnd());
        watch_taskbar(app, st, now);
    }
}

#[allow(clippy::too_many_arguments)]
fn foreground_state(
    st: &mut Loop,
    s: &super::MascotSettings,
    fg: &win_fg::FgWindow,
    covers: bool,
    on_own: bool,
    prev: Option<&ForegroundState>,
    now: Instant,
    app: &AppHandle,
) -> ForegroundState {
    let (game, reason) = if fg.shell {
        (None, None)
    } else {
        let quns = win_fg::notification_state();
        games::classify(&fg.exe, covers, fg.has_caption, quns, &s.games)
    };
    let raw = s.game_mode && reason.is_some();
    let quiet = st.latch.update(raw, now) && s.game_mode;
    if raw {
        st.game_blocks = on_own && blocks_floor(app, s, fg);
    }
    // Durante la histéresis (Alt+Tab corto a otra ventana) no cambia nada:
    // ni el disfraz ni la ventana del juego, que sigue siendo la de antes.
    if let (false, true, Some(p)) = (raw, quiet, prev) {
        return p.clone();
    }
    // Sin modo juego no hay silencio, pero el disfraz sí (va con los gorros).
    if st.aumid.0 != fg.hwnd {
        st.aumid = (fg.hwnd, taskbar::window_aumid(fg.hwnd).unwrap_or_default());
    }
    ForegroundState {
        exe: fg.exe.clone(),
        title: fg.title.clone(),
        hwnd: fg.hwnd,
        app_id: st.aumid.1.clone(),
        rect: fg.rect,
        on_mascot_monitor: on_own,
        game,
        quiet,
        reason,
        uni_keys: context::uni_keys_cached(),
    }
}

/// El juego deja sin suelo a Pupus: menos de dos anchuras suyas libres.
fn blocks_floor(app: &AppHandle, s: &super::MascotSettings, fg: &win_fg::FgWindow) -> bool {
    let scale = screens::work_area(app).map(|(_, _, k)| k).unwrap_or(1.0);
    let pet_px = (PET_SPRITE_W * f64::from(s.scale) * scale).round() as i32;
    games::blocks_floor(fg.rect, fg.work, 2 * pet_px)
}

/// Guarda `next` en `slot` y lo devuelve si es distinto (hay que emitirlo).
fn replace_if_changed(
    slot: &mut Option<ForegroundState>,
    next: ForegroundState,
) -> Option<&ForegroundState> {
    if slot.as_ref() == Some(&next) {
        return None;
    }
    *slot = Some(next);
    slot.as_ref()
}

fn publish(app: &AppHandle, state: ForegroundState) {
    let mut cur = STATE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(changed) = replace_if_changed(&mut cur, state) {
        let _ = app.emit_to(LABEL, "mascot:foreground", changed);
    }
}

fn watch_taskbar(app: &AppHandle, st: &mut Loop, now: Instant) {
    let fp = win_fg::app_window_fingerprint();
    if fp != st.seen_fp {
        st.seen_fp = fp;
        st.changed_at = Some(now);
    }
    if !should_refresh(
        st.refreshed_fp,
        st.seen_fp,
        st.changed_at,
        now,
        st.last_full,
    ) {
        return;
    }
    if REFRESHING.swap(true, Ordering::SeqCst) {
        return;
    }
    st.refreshed_fp = st.seen_fp;
    st.changed_at = None;
    st.last_full = Some(now);
    let app = app.clone();
    // Hilo aparte: si explorer tarda, el sondeo del primer plano no espera.
    let spawned = std::thread::Builder::new()
        .name("pupus-taskbar".into())
        .spawn(move || {
            match taskbar::refresh() {
                Ok((snap, true)) => {
                    let _ = app.emit_to(LABEL, "mascot:taskbar", &snap);
                }
                Ok(_) => {}
                Err(e) => tracing::debug!(error = %e, "mascota: barra de tareas no leída"),
            }
            REFRESHING.store(false, Ordering::SeqCst);
        });
    if spawned.is_err() {
        REFRESHING.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_primera_vez_y_cada_60_s_se_lee_la_barra() {
        let t0 = Instant::now();
        assert!(should_refresh(1, 1, None, t0, None));
        assert!(should_refresh(
            1,
            1,
            None,
            t0 + Duration::from_secs(61),
            Some(t0)
        ));
    }

    #[test]
    fn un_cambio_de_huella_espera_600_ms() {
        let t0 = Instant::now();
        let changed = Some(t0 + Duration::from_secs(1));
        let at = |ms| t0 + Duration::from_millis(ms);
        assert!(!should_refresh(1, 2, changed, at(1200), Some(t0)));
        assert!(should_refresh(1, 2, changed, at(1600), Some(t0)));
    }

    #[test]
    fn misma_huella_y_menos_de_60_s_no_relee() {
        let t0 = Instant::now();
        assert!(!should_refresh(
            7,
            7,
            None,
            t0 + Duration::from_secs(30),
            Some(t0)
        ));
    }

    #[test]
    fn el_estado_solo_se_emite_al_cambiar() {
        let a = ForegroundState {
            exe: "cs2.exe".into(),
            quiet: true,
            ..Default::default()
        };
        let mut slot = None;
        assert!(
            replace_if_changed(&mut slot, a.clone()).is_some(),
            "primero: se emite"
        );
        assert!(
            replace_if_changed(&mut slot, a.clone()).is_none(),
            "igual: no se emite"
        );
        let b = ForegroundState {
            title: "Counter-Strike 2".into(),
            ..a
        };
        assert_eq!(replace_if_changed(&mut slot, b.clone()), Some(&b));
    }
}
