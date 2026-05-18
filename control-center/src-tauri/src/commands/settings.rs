// Settings.json / backup root / autostart commands.
use crate::{backup_status, settings};

#[tauri::command]
pub async fn settings_read() -> Result<settings::SettingsSnapshot, String> {
    settings::settings_read_inner()
}

#[tauri::command]
pub async fn settings_save(
    content: serde_json::Value,
) -> Result<settings::SettingsSaveResult, String> {
    settings::settings_save_inner(settings::SettingsSavePayload { content })
}

#[tauri::command]
pub async fn purge_legacy_autostart() -> Result<settings::AutostartPurgeResult, String> {
    settings::purge_legacy_autostart_inner()
}

#[tauri::command]
pub async fn get_backup_root() -> Result<backup_status::BackupRootInfo, String> {
    backup_status::get_backup_root_inner()
}

#[tauri::command]
pub async fn set_backup_root(path: String) -> Result<backup_status::BackupRootInfo, String> {
    backup_status::set_backup_root_inner(backup_status::SetBackupRootPayload { path })
}

#[tauri::command]
pub async fn backup_status() -> Result<backup_status::BackupStatusReport, String> {
    backup_status::backup_status_inner()
}

#[tauri::command]
pub async fn get_backup_sources() -> Result<backup_status::BackupSourcesInfo, String> {
    backup_status::get_backup_sources_inner()
}

#[tauri::command]
pub async fn set_backup_sources(
    sources: Vec<String>,
) -> Result<backup_status::BackupSourcesInfo, String> {
    backup_status::set_backup_sources_inner(backup_status::SetBackupSourcesPayload { sources })
}
