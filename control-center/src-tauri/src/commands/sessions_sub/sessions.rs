// Claude session spawn / inline run / history commands.
use crate::{claude_sessions, sessions};

#[tauri::command]
pub async fn spawn_session(
    app: tauri::AppHandle,
    provider: String,
    prompt: Option<String>,
    cwd: Option<String>,
    flags: Option<sessions::SpawnFlags>,
) -> Result<sessions::SpawnResult, String> {
    sessions::spawn_session_inner(&app, provider, prompt, cwd, flags).await
}

#[tauri::command]
pub async fn run_inline(
    app: tauri::AppHandle,
    provider: String,
    model: Option<String>,
    prompt: String,
) -> Result<sessions::InlineResult, String> {
    sessions::run_inline_inner(&app, provider, model, prompt).await
}

#[tauri::command]
pub async fn list_claude_sessions(
    limit: Option<usize>,
) -> Result<Vec<claude_sessions::ClaudeSession>, String> {
    claude_sessions::list_claude_sessions_inner(limit)
}

/// Aggregated workspace view for the redesigned Sessions tab. Returns one
/// entry per unique cwd under `~/.claude/projects/`, sorted by most-recent
/// activity. Enriched with project metadata when the cwd matches an entry
/// in `projects.json`. See `claude_sessions::WorkspaceSummary` for the
/// field-level docs.
#[tauri::command]
pub async fn list_workspaces() -> Result<Vec<claude_sessions::WorkspaceSummary>, String> {
    tauri::async_runtime::spawn_blocking(claude_sessions::list_workspaces_inner)
        .await
        .map_err(|e| e.to_string())?
}
