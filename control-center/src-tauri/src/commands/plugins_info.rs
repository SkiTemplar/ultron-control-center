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
