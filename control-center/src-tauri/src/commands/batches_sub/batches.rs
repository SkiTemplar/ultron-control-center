// ULTRON Control Center - Batches commands
use crate::batches::{self, BatchCleanupReport, BatchEntry, BatchRunResult};

#[tauri::command]
pub async fn list_batches() -> Result<Vec<BatchEntry>, String> {
    tauri::async_runtime::spawn_blocking(batches::list_batches_inner)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn execute_batch(name: String) -> Result<BatchRunResult, String> {
    tauri::async_runtime::spawn_blocking(move || batches::execute_batch_inner(name))
        .await
        .map_err(|e| e.to_string())?
}

/// Delete a single batch script by name (user-initiated, no age filter).
/// The name must be a bare filename — path separators and `..` are rejected.
#[tauri::command]
pub async fn delete_batch_single(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || batches::delete_batch_single_inner(name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cleanup_old_batches(
    older_than_days: u32,
) -> Result<BatchCleanupReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        batches::cleanup_old_batches_inner(older_than_days)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete ALL batch scripts (user-initiated "Clear all", with confirmation in
/// the UI). card-bug-runbatch-clear.
#[tauri::command]
pub async fn clear_all_batches() -> Result<BatchCleanupReport, String> {
    tauri::async_runtime::spawn_blocking(batches::clear_all_batches_inner)
        .await
        .map_err(|e| e.to_string())?
}
