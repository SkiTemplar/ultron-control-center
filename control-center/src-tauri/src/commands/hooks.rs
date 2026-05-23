// Hook admin commands (Claude Code settings.json hooks).
use crate::hooks_admin;

#[tauri::command]
pub async fn list_hooks() -> Result<hooks_admin::HooksList, String> {
    hooks_admin::list_hooks_inner()
}

#[tauri::command]
pub async fn add_hook(
    event: String,
    matcher: Option<String>,
    command: String,
) -> Result<hooks_admin::HookMutationResult, String> {
    hooks_admin::add_hook_inner(event, matcher, command)
}

#[tauri::command]
pub async fn update_hook(
    id: String,
    command: Option<String>,
    enabled: Option<bool>,
    matcher: Option<String>,
) -> Result<hooks_admin::HookMutationResult, String> {
    hooks_admin::update_hook_inner(id, command, enabled, matcher)
}

#[tauri::command]
pub async fn toggle_hook(id: String) -> Result<hooks_admin::HookMutationResult, String> {
    hooks_admin::toggle_hook_inner(id)
}

#[tauri::command]
pub async fn delete_hook(id: String) -> Result<hooks_admin::HookMutationResult, String> {
    hooks_admin::delete_hook_inner(id)
}

#[tauri::command]
pub async fn test_hook(
    id: String,
    mock_payload: Option<String>,
) -> Result<hooks_admin::HookTestResult, String> {
    hooks_admin::test_hook_inner(id, mock_payload)
}

#[tauri::command]
pub async fn recent_hook_fires(
    limit: Option<usize>,
) -> Result<hooks_admin::HookFiresReport, String> {
    hooks_admin::recent_hook_fires_inner(limit)
}

#[tauri::command]
pub async fn request_hook_via_ai(
    app: tauri::AppHandle,
    description: String,
) -> Result<String, String> {
    hooks_admin::request_hook_via_ai_inner(&app, description).await
}

#[tauri::command]
pub async fn hooks_last_fired(id: String) -> hooks_admin::HookLastFired {
    hooks_admin::hooks_last_fired_inner(id)
}
