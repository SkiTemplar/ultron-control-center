// Mascota — adónde ir con un aviso de build o tests en rojo.
//
//   * "sesiones": la ventana de Sessions de ULTRON (si está visible).
//   * "editor": la ventana de un editor o terminal; con `hint` (nombre de
//     la carpeta del proyecto) gana la que lo lleva en el título y, si no,
//     la más alta en orden Z.
// Devuelve el rectángulo en píxeles físicos; la webview camina hasta el
// centro de su borde superior (navigator.ts).

use tauri::{AppHandle, Manager};

use super::{win, win_fg};

/// Ejecutables que cuentan como editor o terminal (en minúsculas).
pub const EDITOR_EXES: &[&str] = &[
    "code.exe",
    "cursor.exe",
    "windowsterminal.exe",
    "devenv.exe",
    "rider64.exe",
    "clion64.exe",
    "unrealeditor.exe",
    "wezterm-gui.exe",
    "alacritty.exe",
];

/// Ventana del editor elegida entre (exe, título), en orden Z. Pura.
pub fn pick_editor(cands: &[(String, String)], hint: Option<&str>) -> Option<usize> {
    let editors: Vec<usize> = cands
        .iter()
        .enumerate()
        .filter(|(_, (exe, _))| EDITOR_EXES.contains(&exe.as_str()))
        .map(|(i, _)| i)
        .collect();
    let hint = hint
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(str::to_lowercase);
    if let Some(h) = hint {
        if let Some(&i) = editors
            .iter()
            .find(|&&i| cands[i].1.to_lowercase().contains(&h))
        {
            return Some(i);
        }
    }
    editors.first().copied()
}

fn sessions_rect(app: &AppHandle) -> Option<win::WinRect> {
    let w = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("sesiones"))
        .map(|(_, w)| w)
        .find(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true))?;
    let pos = w.outer_position().ok()?;
    let size = w.outer_size().ok()?;
    Some(win::WinRect {
        id: 0,
        left: pos.x,
        top: pos.y,
        right: pos.x + size.width as i32,
        bottom: pos.y + size.height as i32,
        title: w.title().unwrap_or_default(),
    })
}

fn editor_rect(hint: Option<&str>) -> Option<win::WinRect> {
    let wins = win::desktop_windows(&[super::mascot_hwnd()]);
    let cands: Vec<(String, String)> = wins
        .iter()
        .map(|w| (win_fg::window_process(w.id).0, w.title.clone()))
        .collect();
    pick_editor(&cands, hint).map(|i| wins[i].clone())
}

#[tauri::command]
pub async fn mascot_target_window(
    app: AppHandle,
    target: String,
    hint: Option<String>,
) -> Option<win::WinRect> {
    match target.as_str() {
        "sesiones" => sessions_rect(&app),
        "editor" => editor_rect(hint.as_deref()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(exe: &str, title: &str) -> (String, String) {
        (exe.into(), title.into())
    }

    #[test]
    fn prefiere_el_editor_con_el_proyecto_en_el_titulo() {
        let list = [
            c("chrome.exe", "Arcadia - Docs"),
            c("code.exe", "main.rs - ultron - Visual Studio Code"),
            c("windowsterminal.exe", "Arcadia"),
        ];
        assert_eq!(pick_editor(&list, Some("arcadia")), Some(2));
        assert_eq!(
            pick_editor(&list, Some("otro")),
            Some(1),
            "sin coincidencia: el más alto"
        );
        assert_eq!(pick_editor(&list, None), Some(1));
    }

    #[test]
    fn sin_editores_no_hay_destino() {
        let list = [c("chrome.exe", "Arcadia"), c("explorer.exe", "Descargas")];
        assert_eq!(pick_editor(&list, Some("Arcadia")), None);
        assert_eq!(pick_editor(&[], None), None);
    }
}
