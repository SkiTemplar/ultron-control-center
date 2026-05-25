// ULTRON Control Center — Project detach/reattach logic.
//
// Permite sacar cualquier Project tab a una WebviewWindow independiente.
// Label . Al cerrar, emite  a "main".

use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};

pub(crate) fn window_label(project_id: &str) -> String {
    let sanitised: String = project_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("project_{sanitised}")
}

#[derive(Debug, serde::Serialize)]
pub struct DetachResult {
    pub label: String,
    pub created: bool,
}

pub fn detach_project_window_inner(
    app: &AppHandle,
    project_id: String,
) -> Result<DetachResult, String> {
    if project_id.is_empty() {
        return Err("project_id no puede estar vacio".to_string());
    }
    if project_id.len() > 128 {
        return Err("project_id supera la longitud maxima (128)".to_string());
    }

    let label = window_label(&project_id);

    if let Some(existing) = app.get_webview_window(&label) {
        existing.show().map_err(|e| format!("show: {e}"))?;
        existing.unminimize().map_err(|e| format!("unminimize: {e}"))?;
        existing.set_focus().map_err(|e| format!("set_focus: {e}"))?;
        return Ok(DetachResult { label, created: false });
    }

    let url = format!("/detached/project?id={}", urlencoded(&project_id));

    let app_for_close = app.clone();
    let pid_for_close = project_id.clone();
    let label_for_close = label.clone();

    let window = WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App(url.into()),
    )
    .title(format!("Project — {project_id}"))
    .inner_size(1000.0, 700.0)
    .min_inner_size(700.0, 500.0)
    .resizable(true)
    .decorations(true)
    .skip_taskbar(false)
    .center()
    .visible(true)
    .build()
    .map_err(|e| format!("crear ventana '{project_id}': {e}"))?;

    window.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
        ) {
            if let Some(main) = app_for_close.get_webview_window("main") {
                let _ = main.emit(
                    &format!("project:reattached:{pid_for_close}"),
                    &label_for_close,
                );
            }
            let _ = app_for_close.emit(
                "project:window-closed",
                serde_json::json!({
                    "projectId": pid_for_close,
                    "label":     label_for_close,
                }),
            );
        }
    });

    Ok(DetachResult { label, created: true })
}

pub fn reattach_project_window_inner(
    app: &AppHandle,
    project_id: String,
) -> Result<(), String> {
    if project_id.is_empty() {
        return Err("project_id no puede estar vacio".to_string());
    }
    let label = window_label(&project_id);
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|e| format!("cerrar ventana '{label}': {e}"))?;
    }
    Ok(())
}

pub fn is_detached(app: &AppHandle, project_id: &str) -> bool {
    app.get_webview_window(&window_label(project_id)).is_some()
}

fn urlencoded(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                use std::fmt::Write as _;
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_reemplaza_chars_invalidos() {
        assert_eq!(window_label("my project!"), "project_my_project_");
    }

    #[test]
    fn label_preserva_chars_validos() {
        assert_eq!(window_label("my-project_1"), "project_my-project_1");
    }

    #[test]
    fn urlencoded_chars_seguros_sin_cambio() {
        assert_eq!(urlencoded("hello-world_1"), "hello-world_1");
    }

    #[test]
    fn urlencoded_codifica_espacios_y_slashes() {
        assert_eq!(urlencoded("my project/name"), "my%20project%2Fname");
    }
}
