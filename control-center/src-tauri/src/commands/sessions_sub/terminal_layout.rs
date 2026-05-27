// ULTRON Control Center — terminal layout commands
//
// Thin wrappers over `crate::terminal_layout::{load_layout, save_layout}`.

use crate::terminal_layout::{load_layout, save_layout, ProjectTerminalLayout};

#[tauri::command]
pub async fn project_terminal_layout_load(
    project_id: String,
) -> Result<ProjectTerminalLayout, String> {
    load_layout(&project_id)
}

#[tauri::command]
pub async fn project_terminal_layout_save(
    project_id: String,
    layout: ProjectTerminalLayout,
) -> Result<(), String> {
    save_layout(&project_id, &layout)
}
