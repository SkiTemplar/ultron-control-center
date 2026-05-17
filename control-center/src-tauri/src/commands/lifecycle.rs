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
