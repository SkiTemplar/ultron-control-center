// ULTRON Control Center — PTY commands (Tauri bindings)
//
// Thin wrappers over `crate::pty::*_inner`. The `spawn_inner` call is
// wrapped in `spawn_blocking` because it does sync I/O (env iteration +
// portable-pty spawn) and we don't want to stall the async runtime.

use crate::pty::{
    kill_inner, list_inner, resize_inner, spawn_inner, write_inner, PtySessionSummary,
};
use tauri::{AppHandle, Runtime};

#[tauri::command]
pub async fn pty_spawn<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    card_id: Option<String>,
    provider: String,
    agent: Option<String>,
    cwd: String,
    prompt: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        spawn_inner(app, project_id, card_id, provider, agent, cwd, prompt)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pty_write(session_id: String, data: String) -> Result<(), String> {
    write_inner(session_id, data)
}

#[tauri::command]
pub async fn pty_resize(session_id: String, rows: u16, cols: u16) -> Result<(), String> {
    resize_inner(session_id, rows, cols)
}

#[tauri::command]
pub async fn pty_kill(session_id: String) -> Result<(), String> {
    kill_inner(session_id)
}

#[tauri::command]
pub async fn pty_list(project_id: String) -> Result<Vec<PtySessionSummary>, String> {
    list_inner(project_id)
}
