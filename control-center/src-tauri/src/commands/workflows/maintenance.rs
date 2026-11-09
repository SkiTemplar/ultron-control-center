// Maintenance scripts + lifecycle commands.
use crate::maintenance;

/// Corre una acción que puede tardar horas fuera de los workers de tokio.
async fn off_main_worker<F>(f: F) -> Result<maintenance::MaintenanceResult, String>
where
    F: FnOnce() -> Result<maintenance::MaintenanceResult, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("mantenimiento: la tarea se interrumpió: {e}"))?
}

#[tauri::command]
pub async fn list_maintenance_commands() -> Result<Vec<maintenance::MaintenanceCommand>, String> {
    Ok(maintenance::list_maintenance_commands_inner())
}

#[tauri::command]
pub async fn run_maintenance_command(
    kind: String,
) -> Result<maintenance::MaintenanceResult, String> {
    off_main_worker(move || maintenance::run_maintenance_inner(kind)).await
}

/// v2.5: dedicated "Run backup now" used by the Dashboard BackupCard. The
/// UI polls `backup_status` after this returns to update the card.
#[tauri::command]
pub async fn run_backup_now() -> Result<maintenance::MaintenanceResult, String> {
    off_main_worker(maintenance::run_backup_now_inner).await
}

#[tauri::command]
pub async fn run_app_lifecycle(kind: String) -> Result<(), String> {
    maintenance::run_app_lifecycle_inner(kind)
}
