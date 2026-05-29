// ULTRON Control Center — PTY commands (Tauri bindings)
//
// Thin wrappers over `crate::pty::*_inner`. The `spawn_inner` call is
// wrapped in `spawn_blocking` because it does sync I/O (env iteration +
// portable-pty spawn) and we don't want to stall the async runtime.

use crate::pty::{
    capture_output_inner, kill_inner, list_inner, list_one_inner, replay_inner, resize_inner,
    spawn_inner, write_inner, CaptureResult, PtySessionSummary,
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

/// Summary of a single session by id (no project filter). Powers the embedded
/// terminal's active-CLI badge. Returns None when the id is unknown.
#[tauri::command]
pub async fn pty_summary(session_id: String) -> Option<PtySessionSummary> {
    list_one_inner(&session_id)
}

/// Return the buffered output captured by the reader thread (base64).
///
/// The frontend calls this once, immediately after its `pty:data:<id>`
/// listener registers, to recover the early output that the reader thread
/// emitted before the IPC listener was subscribed. Without this, TUIs
/// (Claude/Codex/Gemini) that paint their UI in the first burst and never
/// repaint left the embedded terminal blank — the canonical P0 bug.
#[tauri::command]
pub async fn pty_replay(session_id: String) -> Result<String, String> {
    replay_inner(session_id)
}

/// Return new PTY output bytes since `since_offset`, base64-encoded.
///
/// Used by `delegate_task_inner` for deterministic polling: spawn the PTY,
/// snapshot the current buffer offset (0 on first call), then call this
/// repeatedly with the previous `new_offset` to receive only the bytes
/// produced since the last poll.
///
/// - `since_offset == 0` → full buffer (initial replay without subscribing)
/// - `since_offset >= buffer.len()` → empty `data_b64`, same `new_offset`
/// - Unknown session → empty `data_b64`, `session_status: null`
///
/// Unlike `pty_replay`, this command does NOT flip the `subscribed` flag, so
/// it is safe to call concurrently with a live terminal tab that is already
/// receiving `pty:data:<id>` events.
#[tauri::command]
pub async fn pty_capture_output(
    session_id: String,
    since_offset: usize,
) -> Result<CaptureResult, String> {
    capture_output_inner(&session_id, since_offset)
}
