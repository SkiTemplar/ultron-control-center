// Memory layer commands (qdrant probe, brain query, vault reads).
use crate::memory;

#[tauri::command]
pub async fn memory_status(app: tauri::AppHandle) -> Result<memory::MemoryStatus, String> {
    // F2: route through *_with_emit so qdrant.health alerts fire on probe failure
    Ok(memory::memory_status_with_emit(&app))
}

#[tauri::command]
pub async fn brain_query(
    app: tauri::AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<memory::BrainResult>, String> {
    memory::brain_query_inner(&app, query, limit).await
}

#[tauri::command]
pub async fn read_vault_note(path: String) -> Result<String, String> {
    memory::read_vault_note_inner(path)
}

#[tauri::command]
pub async fn memory_action(
    app: tauri::AppHandle,
    action: String,
) -> Result<memory::ActionResult, String> {
    memory::memory_action_inner(&app, action).await
}

#[tauri::command]
pub async fn list_recent_vault_notes(
    limit: Option<usize>,
) -> Result<Vec<memory::RecentNote>, String> {
    memory::list_recent_vault_notes_inner(limit)
}
