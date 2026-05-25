// ULTRON Control Center - Batches commands
use crate::batches::{self, BatchEntry, BatchRunResult};

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
