// ULTRON Control Center — In-app keyboard shortcuts (window-scoped)
//
// These are NOT global OS hotkeys. They're matched inside the React
// shell (see `src/App.tsx` keydown listener) and only fire while the
// Control Center window has focus. The Rust side is just the storage
// layer: load + persist `key -> combo` map at
// `~/.ultron/.tmp/in-app-shortcuts.json`.
//
// `key` is a logical action name (e.g. "tab.dashboard", "command.palette").
// `combo` is a human-readable accelerator like "Alt+1", "Ctrl+K".
// Combo parsing/matching lives in TypeScript because we already detect
// keydown events there — the Rust process never sees these key presses.
//
// LIB_RS_WIRING:
// 1. Add `mod in_app_shortcuts;` to the module list at the top of lib.rs.
// 2. Append these two commands to the `tauri::generate_handler![...]` macro
//    (no extra wrapper functions needed — they're #[tauri::command]
//    already on the module functions):
//
//        in_app_shortcuts::get_in_app_shortcuts,
//        in_app_shortcuts::set_in_app_shortcuts,
//
// 3. No setup() changes — these shortcuts are handled by the frontend.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};

fn shortcuts_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME dir".to_string())?;
    Ok(home.join(".ultron/.tmp/in-app-shortcuts.json"))
}

/// Default bindings — match what `src/App.tsx` hardcoded historically.
/// Returned when the file doesn't exist yet OR a key is missing. The
/// frontend merges these on top of whatever it gets back, so adding a
/// new default here automatically surfaces in the editor.
fn default_bindings() -> HashMap<String, String> {
    let pairs: &[(&str, &str)] = &[
        ("command.palette", "Ctrl+K"),
        ("open.settings", "Ctrl+,"),
        ("refresh.all", "Ctrl+R"),
        ("tab.dashboard", "Alt+1"),
        ("tab.usage", "Alt+2"),
        ("tab.notifications", "Alt+3"),
        ("tab.sessions", "Alt+4"),
        ("tab.projects", "Alt+5"),
        ("tab.plans", "Alt+6"),
        ("tab.memory", "Alt+7"),
        ("tab.skills", "Alt+8"),
        ("tab.logs", "Alt+9"),
        ("tab.settings", "Alt+0"),
    ];
    pairs.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect()
}

/// Read the on-disk map and merge over defaults. Missing file or
/// malformed JSON is treated as "no overrides" — we never error on read
/// because the UI should always render with sensible defaults.
#[tauri::command]
pub fn get_in_app_shortcuts() -> Result<HashMap<String, String>, String> {
    let mut out = default_bindings();
    let path = match shortcuts_path() {
        Ok(p) => p,
        Err(_) => return Ok(out),
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ok(out);
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Ok(out);
    };
    if let Some(map) = parsed.as_object() {
        for (k, v) in map {
            if let Some(combo) = v.as_str() {
                let trimmed = combo.trim();
                if !trimmed.is_empty() {
                    out.insert(k.clone(), trimmed.to_string());
                }
            }
        }
    }
    Ok(out)
}

/// Persist the full map. We don't validate combos here — the frontend
/// already filters by capturing key events. Empty strings are silently
/// dropped (= "use default"). Atomic write via temp + rename so a
/// crash mid-save can't truncate the file.
#[tauri::command]
pub fn set_in_app_shortcuts(map: HashMap<String, String>) -> Result<(), String> {
    let path = shortcuts_path()?;
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut obj = Map::new();
    for (k, v) in map.into_iter() {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            continue;
        }
        obj.insert(k, Value::String(trimmed.to_string()));
    }
    let body =
        serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}
