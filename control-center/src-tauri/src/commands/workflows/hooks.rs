// Hook admin commands (Claude Code settings.json hooks).
use crate::hooks_admin;

#[tauri::command]
pub async fn list_hooks() -> Result<hooks_admin::HooksList, String> {
    hooks_admin::list_hooks_inner()
}

/// Assign a human-readable kebab-case name to a single hook.
/// Uses AI Router (utility zone) with heuristic fallback.
/// Results are cached in ~/.ultron/cockpit/hooks-names.json.
#[tauri::command]
pub async fn analyze_hook_name(id: String) -> Result<hooks_admin::HookNameResult, String> {
    // *_inner may call ai_router::route(), which is fully blocking
    // (reqwest::blocking + thread::sleep backoff + CLI timeouts up to 90s):
    // run on a blocking thread so the async runtime isn't frozen.
    tauri::async_runtime::spawn_blocking(move || hooks_admin::analyze_hook_name_inner(id))
        .await
        .map_err(|e| e.to_string())?
}

/// Assign names to all hooks that don't have a cached name yet.
#[tauri::command]
pub async fn bulk_analyze_hook_names() -> Result<Vec<hooks_admin::HookNameResult>, String> {
    // Same as analyze_hook_name: route() is blocking, keep it off the runtime.
    tauri::async_runtime::spawn_blocking(hooks_admin::bulk_analyze_hook_names_inner)
        .await
        .map_err(|e| e.to_string())?
}

/// Return the current hooks-names.json cache as a flat object.
#[tauri::command]
pub async fn get_hook_names_cache() -> serde_json::Value {
    serde_json::Value::Object(hooks_admin::get_hook_names_cache_inner())
}

/// Readable title + one-line summary for every hook, derived by analysing the
/// referenced script (curated catalog + header-comment parsing). No AI calls.
#[tauri::command]
pub async fn get_hook_descriptions() -> Vec<hooks_admin::HookDescription> {
    hooks_admin::get_hook_descriptions_inner()
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
