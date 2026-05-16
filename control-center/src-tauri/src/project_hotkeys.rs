// ULTRON Control Center — Per-project hotkeys
//
// Registers global shortcuts that map to the first 9 entries of the
// "pinned" projects list (or, if `pinned` is absent, the first 9 of
// `projects[]`) from `~/.ultron/cockpit/projects.json`.
//
// Chord design decision
// ---------------------
// The user-facing chord we want is `Shift+G` then `1..9`. Tauri 2's
// global-shortcut plugin (the wrapped `global-hotkey` crate) does NOT
// support multi-stroke chords natively: each registration is a single
// accelerator combination. There are two ways to fake it:
//
//   A. Register `Shift+G` alone, then on press flip an
//      `expecting_digit: AtomicBool` for 2 seconds. Problem: `1..9`
//      digit presses *without* modifiers don't trigger a global hook
//      — global shortcuts are intercepted before the focused app,
//      and registering bare digit keys would steal them from every
//      other application. Hard no.
//
//   B. Register N four-key combos that the user can press in one
//      gesture. The doc text suggested `Ctrl+Shift+G+1` .. but the
//      underlying global-hotkey crate accepts at most one non-modifier
//      key per combination. `G+1` is two non-modifier keys, which is
//      rejected by the OS hotkey APIs (RegisterHotKey on Windows in
//      particular).
//
// So the only combos that actually register are `MODIFIER(S) + KEY`.
// We therefore use `Ctrl+Alt+1` .. `Ctrl+Alt+9` as documented in the
// fallback. The "Shift+G chord" name is preserved in event payloads
// and docs for parity with the spec, but the binding is the Ctrl+Alt
// combo. This is the documented deviation.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Debug, Deserialize)]
struct ProjectsRoot {
    #[serde(default)]
    pinned: Option<Vec<String>>,
    #[serde(default)]
    projects: Vec<ProjectEntry>,
}

#[derive(Debug, Deserialize, Clone)]
struct ProjectEntry {
    id: String,
}

fn projects_json_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/cockpit/projects.json"))
}

/// Load the first 9 project ids. Honours a top-level `pinned: [id, ...]`
/// array when present, otherwise falls back to the first 9 entries of
/// `projects[]`. Returns at most 9 ids in slot order (slot 1 .. slot 9).
pub fn load_project_slots() -> Vec<String> {
    let Some(path) = projects_json_path() else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_str::<ProjectsRoot>(&raw) else {
        return Vec::new();
    };

    if let Some(pinned) = root.pinned {
        // Filter pinned ids to those that actually exist in the
        // registry — a stale pin shouldn't fire a bogus open_project.
        let valid_ids: std::collections::HashSet<&str> =
            root.projects.iter().map(|p| p.id.as_str()).collect();
        pinned
            .into_iter()
            .filter(|id| valid_ids.contains(id.as_str()))
            .take(9)
            .collect()
    } else {
        root.projects.into_iter().take(9).map(|p| p.id).collect()
    }
}

/// Map digit index (1..=9) to a `Code`. Returns None for invalid input.
fn digit_to_code(n: usize) -> Option<Code> {
    Some(match n {
        1 => Code::Digit1,
        2 => Code::Digit2,
        3 => Code::Digit3,
        4 => Code::Digit4,
        5 => Code::Digit5,
        6 => Code::Digit6,
        7 => Code::Digit7,
        8 => Code::Digit8,
        9 => Code::Digit9,
        _ => return None,
    })
}

/// Build the shortcut for slot N. See module doc for chord decision
/// rationale — we register `Ctrl+Alt+<N>`, not `Shift+G+<N>`.
pub fn slot_shortcut(n: usize) -> Option<Shortcut> {
    let code = digit_to_code(n)?;
    Some(Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::ALT),
        code,
    ))
}

/// Returns true if `shortcut` is one of the project-slot shortcuts.
/// If yes, returns the slot index (1..=9). Used by the global-shortcut
/// plugin handler in lib.rs to dispatch correctly when multiple
/// shortcuts share a single handler.
pub fn match_slot(shortcut: &Shortcut) -> Option<usize> {
    for n in 1..=9 {
        if let Some(s) = slot_shortcut(n) {
            if &s == shortcut {
                return Some(n);
            }
        }
    }
    None
}

/// Register the 9 project-slot shortcuts. Failures on individual
/// slots (e.g. another app already owns the binding) are logged and
/// skipped — registering 7 of 9 is better than failing the whole app.
///
/// Call from `setup` AFTER the global-shortcut plugin has been
/// installed. The plugin's `with_handler` in lib.rs should call
/// `dispatch_slot_event` when it sees a press whose shortcut matches
/// `match_slot`.
pub fn register_project_hotkeys(
    app: &AppHandle,
) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.global_shortcut();
    for n in 1..=9 {
        let Some(shortcut) = slot_shortcut(n) else {
            continue;
        };
        if let Err(e) = handle.register(shortcut) {
            eprintln!(
                "[ultron] project-hotkey slot {} register failed: {} (continuing)",
                n, e
            );
        }
    }
    Ok(())
}

/// Emit the `project-hotkey` event with the resolved slot index.
/// The frontend listens for this and invokes `open_project` with the
/// id at that slot, so the slot -> id mapping is recomputed on the
/// frontend side. This means changes to `projects.json` (e.g. user
/// reorders pins) take effect on the next emit without restarting
/// the app or re-registering shortcuts.
pub fn dispatch_slot_event(app: &AppHandle, slot: usize) {
    let payload = json!({ "index": slot });
    if let Err(e) = app.emit("project-hotkey", payload) {
        eprintln!("[ultron] emit project-hotkey failed: {}", e);
    }
}

/// Convenience: returns the project id at slot N right now, by reading
/// `projects.json` fresh. Exposed as a Tauri command so the frontend
/// can resolve a slot to an id without re-implementing the pinned/
/// fallback logic in TypeScript.
#[tauri::command]
pub fn project_at_slot(slot: usize) -> Option<String> {
    if slot < 1 || slot > 9 {
        return None;
    }
    let slots = load_project_slots();
    slots.get(slot - 1).cloned()
}

/// Helper for the global-shortcut handler. Returns true if `shortcut`
/// was handled as a project-slot press. The caller (handler in lib.rs)
/// should short-circuit further dispatch when this returns true so
/// other shortcuts (e.g. the legacy Ctrl+Alt+U toggle) keep working.
pub fn handle_shortcut(
    app: &AppHandle,
    shortcut: &Shortcut,
    state: ShortcutState,
) -> bool {
    if state != ShortcutState::Pressed {
        return false;
    }
    // First check user-defined custom slots — these win over the legacy
    // pin-derived Ctrl+Alt+1..9 set so a user-overridden slot can rebind
    // its combo without colliding.
    if let Some(slot) = match_custom_combo(shortcut) {
        dispatch_custom_event(app, slot);
        return true;
    }
    if let Some(slot) = match_slot(shortcut) {
        dispatch_slot_event(app, slot);
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// Custom user-defined slots — Settings → Project hotkeys
//
// The legacy implementation above mapped slot N -> Nth pinned project.
// The new layer below lets the user pick an arbitrary
// (combo, project_id) pair per slot (slots 1..10). Persisted at
// `~/.ultron/cockpit/project-hotkeys.json`.
//
// LIB_RS_WIRING:
// 1. Append to the `tauri::generate_handler![...]` macro:
//
//        project_hotkeys::get_project_hotkeys,
//        project_hotkeys::set_project_at_slot,
//        project_hotkeys::clear_project_at_slot,
//
// 2. After `register_project_hotkeys` in the setup() block:
//
//        if let Err(e) = project_hotkeys::register_custom_hotkeys(app.handle()) {
//            eprintln!("[ultron] custom project hotkeys init failed: {}", e);
//        }
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
        // Refuse to register a combo that collides with the legacy
        // pin-derived slot range — otherwise the user could double-bind
        // Ctrl+Alt+1 and produce ambiguous routing.
        if match_slot(&sc).is_some() {
            eprintln!(
                "[ultron] custom slot {} combo '{}' collides with legacy pin slot, skipping",
                entry.slot, entry.combo
            );
            continue;
        }
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
