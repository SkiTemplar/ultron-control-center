use crate::tabs::{self, OpenTab};

#[tauri::command]
pub async fn tabs_load() -> Result<Vec<OpenTab>, String> {
    tauri::async_runtime::spawn_blocking(tabs::load)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tabs_save(tabs: Vec<OpenTab>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || tabs::save(&tabs))
        .await
        .map_err(|e| e.to_string())?
}
