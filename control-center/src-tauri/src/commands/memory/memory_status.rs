// ULTRON Control Center — memory status command wrappers
//
// Backs the new Memory tab redesign (T1) with live probes for mem0, the ECC
// graph, graphify and file-based MEMORY.md collections. Plus two side-effect
// commands the UI uses to drive operations directly from the cards.

use crate::memory_status::{
    self, EccCardStatus, GraphifyCardStatus, IndexResult, Mem0CardStatus, MemoryFilesCardStatus,
    SyncResult,
};

#[tauri::command]
pub async fn memory_status_mem0() -> Result<Mem0CardStatus, String> {
    memory_status::mem0_card_inner().await
}

#[tauri::command]
pub async fn memory_status_ecc() -> Result<EccCardStatus, String> {
    tauri::async_runtime::spawn_blocking(memory_status::ecc_card_inner)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn memory_status_graphify() -> Result<GraphifyCardStatus, String> {
    tauri::async_runtime::spawn_blocking(memory_status::graphify_card_inner)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn memory_status_files() -> Result<MemoryFilesCardStatus, String> {
    tauri::async_runtime::spawn_blocking(memory_status::memory_files_card_inner)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn memory_sync_mem0_manual() -> Result<SyncResult, String> {
    tauri::async_runtime::spawn_blocking(memory_status::sync_mem0_manual_inner)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn memory_graphify_index(path: String) -> Result<IndexResult, String> {
    tauri::async_runtime::spawn_blocking(move || memory_status::graphify_index_inner(path))
        .await
        .map_err(|e| e.to_string())?
}
