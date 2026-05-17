// Gaming-mode commands: game detection, kill switch, Windows tweaks.
use crate::gaming;

// F2: gaming.detected probe — emits alert + toast when a new game process is detected.
#[tauri::command]
pub async fn detect_running_games(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    gaming::detect_running_games_inner(&app).await
}

#[tauri::command]
pub async fn list_killable_processes(
    app: tauri::AppHandle,
) -> Result<Vec<gaming::GameProcessInfo>, String> {
    gaming::list_killable_inner(&app).await
}

#[tauri::command]
pub async fn kill_processes(
    app: tauri::AppHandle,
    pids: Vec<i64>,
) -> Result<gaming::KillResult, String> {
    gaming::kill_processes_inner(&app, pids).await
}

#[tauri::command]
pub async fn windows_tweaks_status(
    app: tauri::AppHandle,
) -> Result<Vec<gaming::WindowsTweak>, String> {
    gaming::windows_tweaks_status_inner(&app).await
}

#[tauri::command]
pub async fn windows_tweak_set(
    app: tauri::AppHandle,
    key: String,
    enabled: bool,
) -> Result<Vec<gaming::WindowsTweak>, String> {
    gaming::windows_tweak_set_inner(&app, key, enabled).await
}
