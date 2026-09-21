// Maintenance scripts + lifecycle commands.
use crate::maintenance;

#[tauri::command]
pub async fn list_maintenance_commands() -> Result<Vec<maintenance::MaintenanceCommand>, String> {
    Ok(maintenance::list_maintenance_commands_inner())
}

#[tauri::command]
pub async fn run_maintenance_command(
    kind: String,
) -> Result<maintenance::MaintenanceResult, String> {
    maintenance::run_maintenance_inner(kind)
}

/// v2.5: dedicated "Run backup now" used by the Dashboard BackupCard. The
/// UI polls `backup_status` after this returns to update the card.
#[tauri::command]
pub async fn run_backup_now() -> Result<maintenance::MaintenanceResult, String> {
    maintenance::run_backup_now_inner()
}

#[tauri::command]
pub async fn run_app_lifecycle(kind: String) -> Result<(), String> {
    maintenance::run_app_lifecycle_inner(kind)
}
