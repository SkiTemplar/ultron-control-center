// Auth status + ULTRON mode commands.
use crate::{auth, mode};

#[tauri::command]
pub async fn auth_status() -> Result<auth::AuthStatusReport, String> {
    Ok(auth::auth_status_inner())
}

#[tauri::command]
pub async fn get_ultron_mode() -> Result<mode::ModeInfo, String> {
    mode::get_mode_inner()
}

#[tauri::command]
pub async fn set_ultron_mode(mode: String) -> Result<mode::ModeSetResult, String> {
    mode::set_mode_inner(mode::ModeSetPayload { mode })
}

// F7: Settings refactor — reset mode to autodetect.
#[tauri::command]
pub async fn reset_mode_to_autodetect() -> Result<mode::ModeSetResult, String> {
    mode::reset_mode_to_autodetect_inner()
}

// Explicit full app exit. The tray's CloseRequested handler intercepts the
// window X button and hides the window so the app survives in the tray —
// good default, but it means the only way to fully terminate the process
// is the tray menu's Quit item. This command surfaces an opt-out from the
// UI so the user can:
//   1. Free file locks before a Rebuild (the new binary cannot overwrite
//      `control-center.exe` while this process is running).
//   2. Stop the global hotkey listener.
//   3. Recover from a wedged tray icon.
//
// `app.exit(0)` is the canonical Tauri shutdown — it runs the regular
// cleanup path (RunEvent::Exit, plugin teardown) which the OS process
// kill bypasses. Callers should `await` and assume the await never
// resolves on success.
#[tauri::command]
pub async fn close_control_center(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}
