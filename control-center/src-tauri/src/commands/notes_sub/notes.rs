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

// v2.6 (card-v26-fb-005): global notes — cross-project markdown notes.

#[tauri::command]
pub async fn notes_list_global() -> Result<Vec<notes::NoteEntry>, String> {
    tauri::async_runtime::spawn_blocking(notes::list_global_inner)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn notes_load_global(slug: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || notes::load_global_inner(&slug))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn notes_save_global(slug: String, body: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || notes::save_global_inner(&slug, &body))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn notes_delete_global(slug: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || notes::delete_global_inner(&slug))
        .await
        .map_err(|e| e.to_string())?
}

// v2.6 (card-v26-fb-046): per-project notebook — multiple notes per project.

#[tauri::command]
pub async fn project_notes_list(project_id: String) -> Result<Vec<notes::NoteEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || notes::list_project_notes_inner(&project_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_note_load(project_id: String, slug: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || notes::load_project_note_inner(&project_id, &slug))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_note_save(
    project_id: String,
    slug: String,
    body: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        notes::save_project_note_inner(&project_id, &slug, &body)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_note_delete(project_id: String, slug: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        notes::delete_project_note_inner(&project_id, &slug)
    })
    .await
    .map_err(|e| e.to_string())?
}

// v2.6 (card-v26-fb-045): send a global note to a project notebook.
// Returns the final slug used inside the project (uniqued on conflict).
#[tauri::command]
pub async fn notes_send_to_project(slug: String, project_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        notes::send_global_to_project_inner(&slug, &project_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
