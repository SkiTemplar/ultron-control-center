// Maintenance scripts + lifecycle commands.
use crate::maintenance;

#[tauri::command]
pub async fn list_maintenance_commands() -> Result<Vec<maintenance::MaintenanceCommand>, String> {
    Ok(maintenance::list_maintenance_commands_inner())
}

#[tauri::command]
pub async fn run_maintenance_command(kind: String) -> Result<maintenance::MaintenanceResult, String> {
    maintenance::run_maintenance_inner(kind)
}

#[tauri::command]
pub async fn run_detect_gaps() -> Result<maintenance::GapsReport, String> {
    maintenance::run_detect_gaps_inner()
}

#[tauri::command]
pub async fn run_app_lifecycle(kind: String) -> Result<(), String> {
    maintenance::run_app_lifecycle_inner(kind)
}
