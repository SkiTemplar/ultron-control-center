// ULTRON Control Center 2.0 — Tauri command wrappers for the Mem0 client.

use crate::mem0::{
    add_inner, delete_inner, diagnostics_inner, search_inner, status_inner,
    test_connection_inner, Mem0Diagnostics, Mem0Memory, Mem0Status,
};

#[tauri::command]
pub async fn mem0_status() -> Result<Mem0Status, String> {
    status_inner().await
}

#[tauri::command]
pub async fn mem0_search(
    query: String,
    project_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<Mem0Memory>, String> {
    search_inner(query, project_id, limit).await
}

#[tauri::command]
pub async fn mem0_add(
    content: String,
    project_id: String,
    metadata: Option<serde_json::Value>,
) -> Result<Mem0Memory, String> {
    add_inner(content, project_id, metadata).await
}

#[tauri::command]
pub async fn mem0_delete(id: String) -> Result<(), String> {
    delete_inner(id).await
}

#[tauri::command]
pub fn mem0_diagnostics() -> Result<Mem0Diagnostics, String> {
    diagnostics_inner()
}

#[tauri::command]
pub async fn mem0_test_connection() -> Result<Mem0Status, String> {
    test_connection_inner().await
}
