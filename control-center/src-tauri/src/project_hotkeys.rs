// ULTRON Control Center — Per-project hotkeys
//
// User-defined global shortcuts that map a key combo to a project. The
// user writes an arbitrary (combo, project_id) pair per slot (slots 1..10)
// in `~/.ultron/cockpit/project-hotkeys.json`, by hand: the Settings editor
// was retired in v2.5.2 (LifecyclePanel.tsx keeps only the main hotkey).
// Nothing is bound unless the file has slots.
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
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Helper for the global-shortcut handler. Returns true if `shortcut`
/// was handled as a project-slot press. The caller (handler in lib.rs)
/// should short-circuit further dispatch when this returns true so
/// other shortcuts (e.g. the Ctrl+Alt+U toggle) keep working.
pub fn handle_shortcut(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) -> bool {
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
// User-defined slots (hand-edited JSON, see the header)
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

/// In-memory cache so `handle_shortcut` can match combos -> slot
/// without parsing JSON on every keypress.
fn custom_cache() -> &'static Mutex<Vec<(Shortcut, usize)>> {
    static CACHE: OnceLock<Mutex<Vec<(Shortcut, usize)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

fn match_custom_combo(shortcut: &Shortcut) -> Option<usize> {
    let guard = custom_cache().lock().ok()?;
    guard
        .iter()
        .find(|(sc, _)| sc == shortcut)
        .map(|(_, slot)| *slot)
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
        tracing::warn!(slot, error = %e, "no se pudo emitir project-hotkey-custom");
    }
}

/// Parse every slot with the same grammar as the toggle-window hotkey
/// (`crate::hotkeys::parse_hotkey`), so "Ctrl+Alt+P" means the same in both
/// places. Returns the parsed combos and one message per slot that failed.
fn parse_slots(file: &CustomSlotsFile) -> (Vec<(Shortcut, usize, String)>, Vec<String>) {
    let mut parsed = Vec::new();
    let mut failures = Vec::new();
    for entry in file.slots.values() {
        match crate::hotkeys::parse_hotkey(&entry.combo) {
            Ok(sc) => parsed.push((sc, entry.slot, entry.combo.clone())),
            Err(e) => failures.push(format!("slot {} '{}': {e}", entry.slot, entry.combo)),
        }
    }
    (parsed, failures)
}

/// Re-register every custom slot against the global-shortcut plugin.
/// Idempotent: unregisters previously cached combos first so updates take
/// effect immediately. A slot that fails does not block the rest (4 of 5
/// beats 0 of 5), but the call returns `Err` naming every failed slot, so
/// the caller logs it instead of the failure staying invisible.
pub fn register_custom_hotkeys(app: &AppHandle) -> Result<usize, String> {
    let handle = app.global_shortcut();
    if let Ok(guard) = custom_cache().lock() {
        for (sc, slot) in guard.iter() {
            if let Err(e) = handle.unregister(*sc) {
                tracing::warn!(slot, error = %e, "no se pudo soltar el atajo de proyecto");
            }
        }
    }
    let (parsed, mut failures) = parse_slots(&load_custom_slots());
    let mut new_cache: Vec<(Shortcut, usize)> = Vec::new();
    for (sc, slot, combo) in parsed {
        match handle.register(sc) {
            Ok(()) => new_cache.push((sc, slot)),
            Err(e) => failures.push(format!("slot {slot} '{combo}': {e}")),
        }
    }
    let registered = new_cache.len();
    if let Ok(mut guard) = custom_cache().lock() {
        *guard = new_cache;
    }
    if failures.is_empty() {
        Ok(registered)
    } else {
        Err(format!(
            "{registered} atajos de proyecto registrados; fallaron {}: {}",
            failures.len(),
            failures.join("; ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_with(combos: &[(usize, &str)]) -> CustomSlotsFile {
        let slots = combos
            .iter()
            .map(|(slot, combo)| {
                let entry = ProjectHotkeySlot {
                    slot: *slot,
                    combo: (*combo).to_string(),
                    project_id: format!("p{slot}"),
                };
                (slot.to_string(), entry)
            })
            .collect();
        CustomSlotsFile { slots }
    }

    #[test]
    fn los_slots_usan_la_gramatica_del_atajo_principal() {
        let (ok, failures) = parse_slots(&file_with(&[(1, "Ctrl+Alt+P"), (2, "Ctrl+Shift+Esc")]));
        assert!(failures.is_empty(), "{failures:?}");
        let p = ok.iter().find(|(_, s, _)| *s == 1).unwrap().0;
        assert_eq!(p, crate::hotkeys::parse_hotkey("ctrl + alt + p").unwrap());
        assert_eq!(ok.len(), 2);
    }

    #[test]
    fn un_slot_invalido_se_informa_con_su_causa() {
        // Caso negativo: antes un combo malo solo dejaba un eprintln! perdido.
        let (ok, failures) = parse_slots(&file_with(&[(1, "P"), (2, "Ctrl+Alt+K")]));
        assert_eq!(ok.len(), 1);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("slot 1 'P'"), "{failures:?}");
        assert!(failures[0].contains("modifier"), "{failures:?}");
    }
}
