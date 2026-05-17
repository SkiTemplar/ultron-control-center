// Installed apps commands.
use crate::installed_apps;

#[tauri::command]
pub async fn list_installed_apps(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<installed_apps::InstalledAppsReport, String> {
    installed_apps::list_installed_apps_inner(&app, force.unwrap_or(false)).await
}

#[tauri::command]
pub async fn open_app_folder(install_location: String) -> Result<String, String> {
    installed_apps::open_app_folder_inner(install_location)
}

#[tauri::command]
pub async fn uninstall_app(
    app: tauri::AppHandle,
    name: String,
    provider: String,
    package_id: Option<String>,
) -> Result<installed_apps::UninstallResult, String> {
    installed_apps::uninstall_app_inner(&app, name, provider, package_id).await
}
