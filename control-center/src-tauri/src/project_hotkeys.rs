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

use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
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
    if let Some(slot) = match_slot(shortcut) {
        dispatch_slot_event(app, slot);
        return true;
    }
    false
}
