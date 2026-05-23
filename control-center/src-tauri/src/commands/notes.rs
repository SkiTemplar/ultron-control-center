// Per-project notes commands (load + save).
//
// Thin async wrappers around `crate::notes::{load_inner, save_inner}`.
// The body is plain markdown — the frontend renderer at
// `src/lib/markdown.tsx` controls the presentation.

use crate::notes;

#[tauri::command]
pub async fn project_notes_load(project_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || notes::load_inner(&project_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_notes_save(project_id: String, body: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || notes::save_inner(&project_id, &body))
        .await
        .map_err(|e| e.to_string())?
}
