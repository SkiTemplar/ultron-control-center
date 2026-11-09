// Mascota — ventanas de Sessions abiertas, tal como las necesita Pupus para
// moverse por dentro de ellas (sessions_surfaces.rs): HWND, visibilidad,
// esquina del área cliente e informe de su columna
// (sesiones/barra_lateral.rs). Solo lectura y cero tokens.

use tauri::{AppHandle, Manager};

use crate::sesiones::barra_lateral::{self, RailReport};
use crate::sesiones::registro::{self, WINDOW_LABEL};

/// Una ventana de Sessions abierta.
#[derive(Debug, Clone)]
pub struct Cand {
    pub label: String,
    pub hwnd: u64,
    pub visible: bool,
    pub minimized: bool,
    /// Esquina del área cliente, px físicos.
    pub inner: (i32, i32),
    pub report: Option<RailReport>,
}

fn hwnd_of(w: &tauri::WebviewWindow) -> u64 {
    #[cfg(target_os = "windows")]
    {
        w.hwnd().map(|h| h.0 as usize as u64).unwrap_or(0)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = w;
        0
    }
}

/// Ventanas de Sessions abiertas; la principal, la primera.
pub(super) fn candidatos(app: &AppHandle) -> Vec<Cand> {
    let mut out: Vec<Cand> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| registro::is_sessions_window(label))
        .map(|(label, w)| Cand {
            hwnd: hwnd_of(&w),
            visible: w.is_visible().unwrap_or(false),
            minimized: w.is_minimized().unwrap_or(false),
            inner: w.inner_position().map(|p| (p.x, p.y)).unwrap_or((0, 0)),
            report: barra_lateral::informe(&label),
            label,
        })
        .collect();
    out.sort_by_key(|c| (c.label != WINDOW_LABEL, c.label.clone()));
    out
}
