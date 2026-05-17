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

/// v15.4.21: returns true when the running install is a developer clone
/// (i.e. a .git directory exists at ~/.ultron). End-user installs that
/// came through bootstrap.ps1 / the NSIS / MSI installer have no .git,
/// so the UI can hide developer-only affordances like the version-drift
/// doctor row and the "Sync version numbers" maintenance command. They
/// cannot edit Cargo.toml / tauri.conf.json / package.json and shouldn't
/// see noise about it.
#[tauri::command]
pub async fn is_developer_install() -> Result<bool, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let git_dir = home.join(".ultron").join(".git");
    Ok(git_dir.exists())
}
