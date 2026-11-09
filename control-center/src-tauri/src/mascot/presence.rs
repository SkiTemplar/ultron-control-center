// Mascota — presencia del usuario para el ánimo de Pupus (useVitality.ts):
// cuánto lleva sin tocar teclado ni ratón y si alguna app usa el micrófono.
//
// El tiempo sin entrada sale de GetLastInputInfo (feature ya activa
// Win32_UI_Input_KeyboardAndMouse). Su `dwTime` va en la base de
// GetTickCount, que está en otra feature; para no añadirla, se mide con un
// `Instant` que se reinicia cada vez que `dwTime` cambia (IdleTracker). Error
// máximo: el intervalo de sondeo de la webview (5 s), y al arrancar la app
// la ausencia empieza a contar desde la primera consulta.
//
// Cero tokens: Win32 y registro (calls.rs). Nada sale del equipo.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Presence {
    /// Milisegundos sin tocar teclado ni ratón (None = no se sabe).
    pub idle_ms: Option<u64>,
    /// Alguna app usa el micrófono ahora (calls.rs).
    pub mic: bool,
}

/// Mide el tiempo desde el último cambio de `dwTime`.
#[derive(Debug, Default)]
pub struct IdleTracker {
    last: Option<(u32, Instant)>,
}

impl IdleTracker {
    pub const fn new() -> Self {
        Self { last: None }
    }

    /// Tiempo sin entrada a partir de la marca `dw_time` vista en `now`.
    /// La primera marca y cada marca nueva cuentan como entrada en `now`.
    pub fn observe(&mut self, dw_time: u32, now: Instant) -> Duration {
        match self.last {
            Some((dw, since)) if dw == dw_time => now.saturating_duration_since(since),
            _ => {
                self.last = Some((dw_time, now));
                Duration::ZERO
            }
        }
    }
}

static TRACKER: Mutex<IdleTracker> = Mutex::new(IdleTracker::new());

#[cfg(target_os = "windows")]
fn last_input_tick() -> Option<u32> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: la estructura va inicializada y con su tamaño; la API solo la rellena.
    let ok = unsafe { GetLastInputInfo(&mut info) };
    (ok != 0).then_some(info.dwTime)
}

#[cfg(not(target_os = "windows"))]
fn last_input_tick() -> Option<u32> {
    None
}

fn idle_ms() -> Option<u64> {
    let tick = last_input_tick()?;
    let mut tracker = TRACKER.lock().unwrap_or_else(|p| p.into_inner());
    let idle = tracker.observe(tick, Instant::now());
    Some(u64::try_from(idle.as_millis()).unwrap_or(u64::MAX))
}

/// Presencia del usuario (la sondea la webview cada pocos segundos).
#[tauri::command]
pub async fn mascot_presence() -> Result<Presence, String> {
    tauri::async_runtime::spawn_blocking(|| Presence {
        idle_ms: idle_ms(),
        mic: super::calls::mic_in_use(),
    })
    .await
    .map_err(|e| format!("tarea interrumpida: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_primera_marca_cuenta_como_entrada() {
        let mut t = IdleTracker::new();
        let t0 = Instant::now();
        assert_eq!(t.observe(100, t0), Duration::ZERO);
    }

    #[test]
    fn la_misma_marca_acumula_tiempo_sin_entrada() {
        let mut t = IdleTracker::new();
        let t0 = Instant::now();
        t.observe(100, t0);
        assert_eq!(
            t.observe(100, t0 + Duration::from_secs(300)),
            Duration::from_secs(300)
        );
    }

    #[test]
    fn una_marca_nueva_reinicia_la_cuenta() {
        let mut t = IdleTracker::new();
        let t0 = Instant::now();
        t.observe(100, t0);
        t.observe(100, t0 + Duration::from_secs(400));
        // Caso negativo: con una entrada nueva no puede seguir contando la ausencia.
        assert_eq!(
            t.observe(250, t0 + Duration::from_secs(401)),
            Duration::ZERO
        );
        assert_eq!(
            t.observe(250, t0 + Duration::from_secs(403)),
            Duration::from_secs(2)
        );
    }

    #[test]
    fn se_serializa_con_los_nombres_que_espera_la_webview() {
        let v = serde_json::to_value(Presence {
            idle_ms: Some(5),
            mic: true,
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "idle_ms": 5, "mic": true }));
        let none = serde_json::to_value(Presence {
            idle_ms: None,
            mic: false,
        })
        .unwrap();
        assert_eq!(none["idle_ms"], serde_json::Value::Null);
    }
}
