// ULTRON Control Center — Per-project hotkeys
//
// User-defined global shortcuts that map a key combo to a project. The
// user picks an arbitrary (combo, project_id) pair per slot (slots 1..10)
// in Settings → Project hotkeys; the set is persisted at
// `~/.ultron/cockpit/project-hotkeys.json`. Nothing is bound unless the
// user configures it.
//
// History
// -------
// A legacy layer used to auto-register `Ctrl+Alt+1..9` mapped to the first
// 9 pinned projects. It was removed in v15.5.21: on international keyboards
// `AltGr` emits `Ctrl+Alt`, so `Ctrl+Alt+2` silently hijacked the `@` key
// (and `Ctrl+Alt+1`→`|`, `Ctrl+Alt+3`→`#`, …). Only the user-defined slots
// below remain.
//
// Tauri 2's global-shortcut plugin (the wrapped `global-hotkey` crate)
// accepts at most one non-modifier key per combination, so every slot
// combo is `MODIFIER(S) + KEY`.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Helper for the global-shortcut handler. Returns true if `shortcut`
/// was handled as a project-slot press. The caller (handler in lib.rs)
/// should short-circuit further dispatch when this returns true so
/// other shortcuts (e.g. the Ctrl+Alt+U toggle) keep working.
pub fn handle_shortcut(
    app: &AppHandle,
    shortcut: &Shortcut,
    state: ShortcutState,
) -> bool {
    if state != ShortcutState::Pressed {
        return false;
    }
    if let Some(slot) = match_custom_combo(shortcut) {
        dispatch_custom_event(app, slot);
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// User-defined slots — Settings → Project hotkeys
//
// The user picks an arbitrary (combo, project_id) pair per slot
// (slots 1..10). Persisted at `~/.ultron/cockpit/project-hotkeys.json`.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectHotkeySlot {
    pub slot: usize,
    pub combo: String,
    pub project_id: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct CustomSlotsFile {
    #[serde(default)]
    slots: HashMap<String, ProjectHotkeySlot>,
}

fn custom_slots_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/cockpit/project-hotkeys.json"))
}

fn load_custom_slots() -> CustomSlotsFile {
    let Some(p) = custom_slots_path() else {
        return CustomSlotsFile::default();
    };
    let Ok(raw) = fs::read_to_string(&p) else {
        return CustomSlotsFile::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_custom_slots(file: &CustomSlotsFile) -> Result<(), String> {
    let p = custom_slots_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let body = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

/// In-memory cache so `handle_shortcut` can match combos -> slot
/// without parsing JSON on every keypress. Kept in sync via
/// `refresh_custom_cache()` called by every mutator.
fn custom_cache() -> &'static Mutex<Vec<(Shortcut, usize)>> {
    static CACHE: OnceLock<Mutex<Vec<(Shortcut, usize)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// Reuses the same accelerator grammar as the toggle-window hotkey so
/// "Ctrl+Alt+P" and similar specs parse identically across the app.
/// Kept local to avoid a cross-module dep on lib.rs.
fn parse_combo(spec: &str) -> Option<Shortcut> {
    let parts: Vec<String> = spec
        .split('+')
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return None;
    }
    let mut mods = Modifiers::empty();
    let mut key: Option<Code> = None;
    for p in &parts {
        match p.as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "alt" | "option" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "super" | "meta" | "win" | "cmd" => mods |= Modifiers::SUPER,
            other => {
                if key.is_some() {
                    return None;
                }
                key = code_from_combo_name(other);
                key.as_ref()?;
            }
        }
    }
    let code = key?;
    if mods.is_empty() {
        return None;
    }
    Some(Shortcut::new(Some(mods), code))
}

fn code_from_combo_name(name: &str) -> Option<Code> {
    let n = name.to_ascii_lowercase();
    if n.len() == 1 {
        let c = n.chars().next().unwrap();
        if c.is_ascii_alphabetic() {
            return Some(match c {
                'a' => Code::KeyA, 'b' => Code::KeyB, 'c' => Code::KeyC,
                'd' => Code::KeyD, 'e' => Code::KeyE, 'f' => Code::KeyF,
                'g' => Code::KeyG, 'h' => Code::KeyH, 'i' => Code::KeyI,
                'j' => Code::KeyJ, 'k' => Code::KeyK, 'l' => Code::KeyL,
                'm' => Code::KeyM, 'n' => Code::KeyN, 'o' => Code::KeyO,
                'p' => Code::KeyP, 'q' => Code::KeyQ, 'r' => Code::KeyR,
                's' => Code::KeyS, 't' => Code::KeyT, 'u' => Code::KeyU,
                'v' => Code::KeyV, 'w' => Code::KeyW, 'x' => Code::KeyX,
                'y' => Code::KeyY, 'z' => Code::KeyZ,
                _ => return None,
            });
        }
        if c.is_ascii_digit() {
            return Some(match c {
                '0' => Code::Digit0, '1' => Code::Digit1, '2' => Code::Digit2,
                '3' => Code::Digit3, '4' => Code::Digit4, '5' => Code::Digit5,
                '6' => Code::Digit6, '7' => Code::Digit7, '8' => Code::Digit8,
                '9' => Code::Digit9,
                _ => return None,
            });
        }
    }
    match n.as_str() {
        "space" => Some(Code::Space),
        "enter" | "return" => Some(Code::Enter),
        "tab" => Some(Code::Tab),
        "f1" => Some(Code::F1), "f2" => Some(Code::F2), "f3" => Some(Code::F3),
        "f4" => Some(Code::F4), "f5" => Some(Code::F5), "f6" => Some(Code::F6),
        "f7" => Some(Code::F7), "f8" => Some(Code::F8), "f9" => Some(Code::F9),
        "f10" => Some(Code::F10), "f11" => Some(Code::F11), "f12" => Some(Code::F12),
        _ => None,
    }
}

fn refresh_custom_cache(file: &CustomSlotsFile) {
    let mut out: Vec<(Shortcut, usize)> = Vec::new();
    for (_, entry) in &file.slots {
        if let Some(sc) = parse_combo(&entry.combo) {
            out.push((sc, entry.slot));
        }
    }
    if let Ok(mut guard) = custom_cache().lock() {
        *guard = out;
    }
}

fn match_custom_combo(shortcut: &Shortcut) -> Option<usize> {
    let guard = custom_cache().lock().ok()?;
    for (sc, slot) in guard.iter() {
        if sc == shortcut {
            return Some(*slot);
        }
    }
    None
}

fn dispatch_custom_event(app: &AppHandle, slot: usize) {
    let file = load_custom_slots();
    let Some(entry) = file.slots.get(&slot.to_string()).cloned() else {
        return;
    };
    let payload = json!({
        "slot": entry.slot,
        "project_id": entry.project_id,
        "combo": entry.combo,
    });
    if let Err(e) = app.emit("project-hotkey-custom", payload) {
        eprintln!("[ultron] emit project-hotkey-custom failed: {}", e);
    }
}

/// Re-register every custom slot against the global-shortcut plugin.
/// Idempotent: unregisters previously cached combos first so updates
/// take effect immediately. Failures on individual slots are logged
/// and skipped — registering 4 of 5 beats failing all 5.
pub fn register_custom_hotkeys(app: &AppHandle) -> Result<(), String> {
    let handle = app.global_shortcut();
    // Unregister the previous set first.
    if let Ok(guard) = custom_cache().lock() {
        for (sc, _) in guard.iter() {
            let _ = handle.unregister(*sc);
        }
    }
    let file = load_custom_slots();
    let mut new_cache: Vec<(Shortcut, usize)> = Vec::new();
    for (_, entry) in &file.slots {
        let Some(sc) = parse_combo(&entry.combo) else {
            eprintln!("[ultron] custom slot {} bad combo '{}'", entry.slot, entry.combo);
            continue;
        };
        if let Err(e) = handle.register(sc) {
            eprintln!(
                "[ultron] custom slot {} register '{}' failed: {} (skipping)",
                entry.slot, entry.combo, e
            );
            continue;
        }
        new_cache.push((sc, entry.slot));
    }
    if let Ok(mut guard) = custom_cache().lock() {
        *guard = new_cache;
    }
    Ok(())
}

#[tauri::command]
pub fn get_project_hotkeys() -> Result<Vec<ProjectHotkeySlot>, String> {
    let file = load_custom_slots();
    let mut out: Vec<ProjectHotkeySlot> = file.slots.into_values().collect();
    out.sort_by_key(|s| s.slot);
    Ok(out)
}

#[tauri::command]
pub fn set_project_at_slot(
    app: AppHandle,
    slot: usize,
    project_id: String,
    combo: String,
) -> Result<(), String> {
    if !(1..=10).contains(&slot) {
        return Err(format!("slot {} out of range 1..=10", slot));
    }
    let combo_t = combo.trim().to_string();
    if combo_t.is_empty() {
        return Err("combo cannot be empty".into());
    }
    if parse_combo(&combo_t).is_none() {
        return Err(format!("combo '{}' is not a valid accelerator", combo_t));
    }
    let mut file = load_custom_slots();
    file.slots.insert(
        slot.to_string(),
        ProjectHotkeySlot {
            slot,
            combo: combo_t,
            project_id,
        },
    );
    save_custom_slots(&file)?;
    refresh_custom_cache(&file);
    register_custom_hotkeys(&app)?;
    Ok(())
}

#[tauri::command]
pub fn clear_project_at_slot(app: AppHandle, slot: usize) -> Result<(), String> {
    let mut file = load_custom_slots();
    file.slots.remove(&slot.to_string());
    save_custom_slots(&file)?;
    refresh_custom_cache(&file);
    register_custom_hotkeys(&app)?;
    Ok(())
}
