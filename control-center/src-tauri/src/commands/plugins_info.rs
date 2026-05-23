// Phase 7: ECC plugin cache introspection handler.
use crate::plugins_info as pi;

#[tauri::command]
pub fn read_plugin_info() -> Result<pi::PluginInfo, String> {
    pi::read_plugin_info_inner()
}
