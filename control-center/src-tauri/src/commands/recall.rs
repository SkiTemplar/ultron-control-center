// Recall last Claude session — Tauri command wrappers.
//
// Thin delegations to `crate::recall::*_inner`. Frontend invokes from
// `RecallSessionDialog.tsx` (per-project) and from the global Control Center
// terminal recall button.

use crate::recall::{recall_last_session_global_inner, recall_last_session_inner, RecallResult};

#[tauri::command]
pub async fn recall_last_session(
    project_id: Option<String>,
    cwd: Option<String>,
) -> Result<RecallResult, String> {
    recall_last_session_inner(project_id, cwd).await
}

#[tauri::command]
pub async fn recall_last_session_global() -> Result<RecallResult, String> {
    recall_last_session_global_inner().await
}
