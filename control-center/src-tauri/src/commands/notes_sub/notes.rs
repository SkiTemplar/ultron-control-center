// Global notes commands (v2.6, card-v26-fb-005) — cross-project markdown notes.
//
// Thin async wrappers around `crate::notes::*_global_inner`. The body is plain
// markdown — the frontend renderer at `src/lib/markdown.tsx` controls the
// presentation.
//
// (2026-08-11, decisión del usuario — audit 08-09 #37) El subsistema de notas
// POR-PROYECTO (7 comandos: project_notes_* / project_note_* /
// notes_send_to_project) se RETIRÓ: nunca se registró en generate_handler! ni
// tuvo consumidor en la UI — las notas globales lo reemplazaron.

use crate::notes;

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
