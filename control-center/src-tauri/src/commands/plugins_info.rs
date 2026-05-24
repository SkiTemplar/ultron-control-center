// Plugin cache introspection handlers.
use crate::plugins_info as pi;

#[tauri::command]
pub fn read_plugin_info() -> Result<pi::PluginInfo, String> {
    pi::read_plugin_info_inner()
}

#[tauri::command]
pub fn list_all_plugins() -> Result<Vec<pi::PluginEntry>, String> {
    pi::list_all_plugins_inner()
}

#[tauri::command]
pub fn uninstall_plugin_cache(name: String, marketplace: String) -> Result<(), String> {
    pi::uninstall_plugin_cache_inner(&name, &marketplace)
}

#[tauri::command]
pub async fn check_plugin_updates() -> Result<Vec<pi::PluginUpdateStatus>, String> {
    // Runs `gh repo view` per plugin which is I/O-bound. We push it to a
    // blocking thread so the Tauri main loop stays responsive while users
    // wait for the spinner. Uses tauri's runtime helper (the rest of the
    // codebase consistently goes through `tauri::async_runtime`).
    tauri::async_runtime::spawn_blocking(pi::check_plugin_updates_inner)
        .await
        .map_err(|e| format!("join error: {e}"))?
}
