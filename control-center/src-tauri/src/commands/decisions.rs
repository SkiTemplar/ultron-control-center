// ULTRON Control Center — Tauri command wrappers for the Decision Registry
// (KIRKARDO 24). All heavy I/O is delegated to `crate::decisions::*_inner`
// so this file stays a thin async façade — the same pattern used by
// commands/kanban.rs and commands/kg.rs.

use crate::decisions::{
    add_inner, delete_inner, list_inner, search_inner, update_inner, DecisionPatch,
    DecisionPayload, DecisionRecord, DecisionSearchResult,
};

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn decisions_add(
    project_id: String,
    payload: DecisionPayload,
) -> Result<DecisionRecord, String> {
    tauri::async_runtime::spawn_blocking(move || add_inner(&project_id, payload))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn decisions_update(
    project_id: String,
    id: String,
    patch: DecisionPatch,
) -> Result<DecisionRecord, String> {
    tauri::async_runtime::spawn_blocking(move || update_inner(&project_id, &id, patch))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn decisions_list(project_id: String) -> Result<Vec<DecisionRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || list_inner(&project_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn decisions_delete(project_id: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_inner(&project_id, &id))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// Search decisions within a specific project.
/// Scoring: decision*3 + rationale*2 + tags*2 + alternatives*1 + author*1
#[tauri::command]
pub async fn decisions_search(
    query: String,
    project_id: String,
) -> Result<Vec<DecisionSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || search_inner(&query, Some(&project_id)))
        .await
        .map_err(|e| e.to_string())?
}

/// Search decisions across ALL projects (wraps decisions_search with scope=None).
/// This is the `kanban_decisions_search` variant mentioned in KIRKARDO 24.
#[tauri::command]
pub async fn kanban_decisions_search(
    query: String,
) -> Result<Vec<DecisionSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || search_inner(&query, None))
        .await
        .map_err(|e| e.to_string())?
}
