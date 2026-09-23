// ULTRON Control Center — Tauri commands para detach de Projects.

use crate::detach::{self, DetachResult};

#[tauri::command]
pub async fn detach_project_window(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<DetachResult, String> {
    detach::detach_project_window_inner(&app, project_id)
}
