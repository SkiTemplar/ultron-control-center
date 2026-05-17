// Global hotkey runtime commands (main toggle + pause/resume).
//
// Parsing helpers (`parse_hotkey`, `load_hotkey_spec`, `save_hotkey_spec`,
// `code_from_name`, `hotkey_config_path`) live in `crate::hotkeys` so both
// `lib.rs` setup() and these commands share one source of truth.

use crate::hotkeys;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[tauri::command]
pub async fn get_global_hotkey() -> Result<String, String> {
    Ok(hotkeys::load_hotkey_spec())
}

#[tauri::command]
pub async fn pause_global_hotkeys(app: tauri::AppHandle) -> Result<(), String> {
    hotkeys::pause_global_hotkeys_inner(&app)
}

#[tauri::command]
pub async fn resume_global_hotkeys(app: tauri::AppHandle) -> Result<(), String> {
    // Re-register inbox shortcut + restore the current main toggle binding.
    hotkeys::resume_global_hotkeys_inner(&app)?;
    let spec = hotkeys::load_hotkey_spec();
    if let Ok(sc) = hotkeys::parse_hotkey(&spec) {
        let _ = app.global_shortcut().register(sc);
    }
    Ok(())
}

#[tauri::command]
pub async fn set_global_hotkey(app: tauri::AppHandle, spec: String) -> Result<String, String> {
    let new_shortcut = hotkeys::parse_hotkey(&spec)?;
    let handle = app.global_shortcut();
    // Unregister whatever is currently bound, then register the new one.
    // If the new register fails (e.g. another app owns it), we attempt to
    // restore the previous spec so the user isn't left with NO hotkey.
    let previous = hotkeys::load_hotkey_spec();
    if let Ok(prev_sc) = hotkeys::parse_hotkey(&previous) {
        let _ = handle.unregister(prev_sc);
    }
    if let Err(e) = handle.register(new_shortcut) {
        if let Ok(prev_sc) = hotkeys::parse_hotkey(&previous) {
            let _ = handle.register(prev_sc);
        }
        return Err(format!("register '{}' failed: {}", spec, e));
    }
    hotkeys::save_hotkey_spec(&spec)?;
    Ok(spec)
}
