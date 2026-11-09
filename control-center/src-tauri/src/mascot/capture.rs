// Mascota — salir (o no) en las capturas y grabaciones de pantalla.
//
// Por defecto Pupus SALE en las grabaciones (OBS, Win+Shift+R, Teams…):
// ajuste `capturable` en Settings → Pupus. Lo que no debe ver nunca es el
// MCP de escritorio: sus capturas (bridge.rs → win::capture_primary) las
// lee un agente, y Pupus encima de un botón le haría clicar donde no es.
// Por eso cada captura del MCP excluye la ventana un instante
// (WDA_EXCLUDEFROMCAPTURE + DwmFlush), captura y la restaura. Si Windows
// no acepta la exclusión, la oculta durante la captura.
//
// Coste conocido: una grabación en curso pierde a Pupus durante uno o dos
// fotogramas en cada captura del MCP.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewWindow};

use super::{page, win, LABEL};

/// La ventana está excluida de las capturas de forma permanente
/// (`capturable = false`).
static EXCLUDED: AtomicBool = AtomicBool::new(false);
/// Una captura del MCP a la vez (ver `serialized`).
static CAPTURE_LOCK: Mutex<()> = Mutex::new(());
/// Ya se avisó de que la exclusión temporal falló.
static AFFINITY_WARNED: AtomicBool = AtomicBool::new(false);

/// Margen para que el compositor retire la ventana oculta (respaldo).
const HIDE_SETTLE: Duration = Duration::from_millis(60);

/// Qué hacer con la ventana durante una captura del MCP. Pura, para tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Ya no sale en capturas (excluida u oculta) o no existe.
    Nothing,
    /// Excluirla durante la captura y restaurarla después.
    ToggleAffinity,
}

pub fn capture_plan(excluded: bool, hwnd: u64, visible: bool) -> Plan {
    if excluded || hwnd == 0 || !visible {
        Plan::Nothing
    } else {
        Plan::ToggleAffinity
    }
}

/// Aplica el ajuste a la ventana `hwnd`. Devuelve si Windows lo aceptó.
pub fn apply(hwnd: u64, capturable: bool) -> bool {
    if hwnd == 0 {
        return false;
    }
    let ok = win::set_capture_excluded(hwnd, !capturable);
    if ok {
        EXCLUDED.store(!capturable, Ordering::SeqCst);
    } else if !capturable {
        // Windows < 10 2004: la mascota saldrá también en las capturas.
        tracing::warn!("mascota: WDA_EXCLUDEFROMCAPTURE no disponible");
    }
    ok
}

/// Restaura la afinidad que manda el ajuste al salir (también si la
/// captura falla).
struct RestoreAffinity(u64);

impl Drop for RestoreAffinity {
    fn drop(&mut self) {
        win::set_capture_excluded(self.0, EXCLUDED.load(Ordering::SeqCst));
    }
}

/// Vuelve a enseñar la ventana oculta para la captura (respaldo).
struct Reshow(WebviewWindow);

impl Drop for Reshow {
    fn drop(&mut self) {
        let _ = page::show_if_allowed(&self.0);
    }
}

/// Ejecuta `f` bajo CAPTURE_LOCK: dos capturas del MCP a la vez no se
/// pisan (la primera en terminar restauraría la afinidad o volvería a
/// enseñar la ventana mientras la otra aún captura).
fn serialized<T>(f: impl FnOnce() -> T) -> T {
    let _guard = CAPTURE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    f()
}

/// true solo la primera vez que se llama con `flag` (aviso único).
fn first_time(flag: &AtomicBool) -> bool {
    !flag.swap(true, Ordering::SeqCst)
}

/// Ejecuta `f` (una captura de pantalla) sin que Pupus salga en ella.
pub fn without_mascot<T>(
    app: &AppHandle,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    serialized(|| capture_hidden(app, f))
}

fn capture_hidden<T>(app: &AppHandle, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let hwnd = super::mascot_hwnd();
    let window = app.get_webview_window(LABEL);
    let visible = window
        .as_ref()
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if capture_plan(EXCLUDED.load(Ordering::SeqCst), hwnd, visible) == Plan::Nothing {
        return f();
    }
    if win::set_capture_excluded(hwnd, true) {
        let _restore = RestoreAffinity(hwnd);
        win::dwm_flush();
        return f();
    }
    // Se llama desde el hilo del puente, no desde el de la ventana: si
    // Windows lo rechaza por eso, se avisa una vez y se usa el respaldo.
    if first_time(&AFFINITY_WARNED) {
        tracing::warn!(
            "mascota: SetWindowDisplayAffinity falló desde el hilo del puente; las capturas ocultan la ventana"
        );
    }
    let Some(w) = window else { return f() };
    if w.hide().is_err() {
        return f();
    }
    let _reshow = Reshow(w);
    std::thread::sleep(HIDE_SETTLE);
    win::dwm_flush();
    f()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capturable_y_visible_se_excluye_durante_la_captura() {
        assert_eq!(capture_plan(false, 42, true), Plan::ToggleAffinity);
    }

    #[test]
    fn excluida_oculta_o_sin_ventana_no_se_toca() {
        // Caso negativo: con `capturable = false` ya está excluida.
        assert_eq!(capture_plan(true, 42, true), Plan::Nothing);
        assert_eq!(capture_plan(false, 42, false), Plan::Nothing, "oculta");
        assert_eq!(capture_plan(false, 0, true), Plan::Nothing, "sin ventana");
    }

    #[test]
    fn dos_capturas_a_la_vez_no_se_solapan() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;
        let (inside, overlaps) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (inside, overlaps) = (inside.clone(), overlaps.clone());
                std::thread::spawn(move || {
                    serialized(|| {
                        if inside.fetch_add(1, Ordering::SeqCst) > 0 {
                            overlaps.fetch_add(1, Ordering::SeqCst);
                        }
                        std::thread::sleep(Duration::from_millis(30));
                        inside.fetch_sub(1, Ordering::SeqCst);
                    })
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(overlaps.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn el_fallo_de_afinidad_se_avisa_una_sola_vez() {
        let flag = AtomicBool::new(false);
        assert!(first_time(&flag));
        // Caso negativo: la segunda y siguientes ya no avisan.
        assert!(!first_time(&flag));
        assert!(!first_time(&flag));
    }
}
