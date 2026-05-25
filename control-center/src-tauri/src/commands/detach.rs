// ULTRON Control Center — Tauri commands para detach/reattach de Projects.

use crate::detach::{self, DetachResult};

#[tauri::command]
pub async fn detach_project_window(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<DetachResult, String> {
    detach::detach_project_window_inner(&app, project_id)
}

#[tauri::command]
pub async fn reattach_project_window(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<(), String> {
    detach::reattach_project_window_inner(&app, project_id)
}

#[tauri::command]
pub async fn is_project_detached(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<bool, String> {
    Ok(detach::is_detached(&app, &project_id))
}
