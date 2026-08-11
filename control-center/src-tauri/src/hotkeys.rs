// ULTRON Control Center — Inbox Quick-Capture Hotkey
//
// LIB_RS_WIRING:
// 1. Add `mod hotkeys;` to the module list at the top of lib.rs.
// 2. Inside the `tauri_plugin_global_shortcut::Builder::new().with_handler(...)`
//    closure, BEFORE the existing `toggle_window(app)` call, add a branch
//    that checks if the pressed shortcut matches the inbox shortcut and
//    emits "open-inbox" instead of toggling the window. The cleanest
//    way is to compare against the parsed `INBOX_SHORTCUT` constant via
//    `hotkeys::is_inbox_shortcut(shortcut)`.
//
//    Drop-in replacement for the existing handler closure:
//
//        .with_handler(|app, shortcut, event| {
//            if event.state() == ShortcutState::Pressed {
//                if hotkeys::is_inbox_shortcut(shortcut) {
//                    if let Some(w) = app.get_webview_window("main") {
//                        let _ = w.emit("open-inbox", ());
//                    }
//                    return;
//                }
//                toggle_window(app);
//            }
//        })
//
//    (Add `use tauri::Emitter;` near the other tauri imports so `.emit` resolves.)
//
// 3. Inside the `.setup(|app| { ... })` closure, after the existing
//    `shortcut_handle.register(shortcut)` call for the main hotkey, add:
//
//        if let Err(e) = hotkeys::register_inbox_shortcut(app) {
//            eprintln!("[ultron] inbox hotkey register failed: {}", e);
//        }
//
// 4. Add the new commands to `tauri::generate_handler![...]`:
//
//        compute_cost,
//        append_inbox,
//        list_inbox,
//
// 5. Add the command wrappers anywhere in lib.rs (next to the others):
//
//        #[tauri::command]
//        async fn compute_cost(window_hours: Option<u32>) -> Result<cost_watchdog::CostSnapshot, String> {
//            cost_watchdog::compute_cost_inner(window_hours.unwrap_or(6))
//        }
//
//        #[tauri::command]
//        async fn append_inbox(text: String) -> Result<(), String> {
//            inbox::append_inbox_inner(&text)
//        }
//
//        #[tauri::command]
//        async fn list_inbox(limit: Option<usize>) -> Result<Vec<inbox::InboxEntry>, String> {
//            inbox::list_inbox_inner(limit.unwrap_or(100))
//        }
//
// 6. Add the new modules to the top of lib.rs:
//        mod cost_watchdog;
//        mod hotkeys;
//        mod inbox;

use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

// ---------------------------------------------------------------------------
// Main toggle hotkey: parsing + persistence
//
// Persisted at ~/.ultron/.tmp/hotkey.txt as a plain `Ctrl+Alt+U`-style string
// so the user can hand-edit the file without booting the app. Both lib.rs
// setup() and the `commands::hotkeys` group share these helpers — single
// source of truth for parser + storage.
// ---------------------------------------------------------------------------

pub fn hotkey_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/.tmp/hotkey.txt"))
}

pub fn parse_hotkey(spec: &str) -> Result<Shortcut, String> {
    // Accepts strings like "Ctrl+Alt+U", "Ctrl+Shift+F12", "Alt+Space".
    // Permissive on whitespace and case to match what the user types.
    let parts: Vec<String> = spec
        .split('+')
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return Err("hotkey spec is empty".into());
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
                    return Err(format!("multiple non-modifier keys: '{}'", other));
                }
                let code =
                    code_from_name(other).ok_or_else(|| format!("unknown key '{}'", other))?;
                key = Some(code);
            }
        }
    }
    let code = key.ok_or_else(|| "spec has no key, only modifiers".to_string())?;
    if mods.is_empty() {
        return Err("hotkey needs at least one modifier (Ctrl / Alt / Shift)".into());
    }
    Ok(Shortcut::new(Some(mods), code))
}

fn code_from_name(name: &str) -> Option<Code> {
    let n = name.to_ascii_lowercase();
    // Letters
    if n.len() == 1 {
        let c = n.chars().next().unwrap();
        if c.is_ascii_alphabetic() {
            return match c {
                'a' => Some(Code::KeyA),
                'b' => Some(Code::KeyB),
                'c' => Some(Code::KeyC),
                'd' => Some(Code::KeyD),
                'e' => Some(Code::KeyE),
                'f' => Some(Code::KeyF),
                'g' => Some(Code::KeyG),
                'h' => Some(Code::KeyH),
                'i' => Some(Code::KeyI),
                'j' => Some(Code::KeyJ),
                'k' => Some(Code::KeyK),
                'l' => Some(Code::KeyL),
                'm' => Some(Code::KeyM),
                'n' => Some(Code::KeyN),
                'o' => Some(Code::KeyO),
                'p' => Some(Code::KeyP),
                'q' => Some(Code::KeyQ),
                'r' => Some(Code::KeyR),
                's' => Some(Code::KeyS),
                't' => Some(Code::KeyT),
                'u' => Some(Code::KeyU),
                'v' => Some(Code::KeyV),
                'w' => Some(Code::KeyW),
                'x' => Some(Code::KeyX),
                'y' => Some(Code::KeyY),
                'z' => Some(Code::KeyZ),
                _ => None,
            };
        }
        if c.is_ascii_digit() {
            return match c {
                '0' => Some(Code::Digit0),
                '1' => Some(Code::Digit1),
                '2' => Some(Code::Digit2),
                '3' => Some(Code::Digit3),
                '4' => Some(Code::Digit4),
                '5' => Some(Code::Digit5),
                '6' => Some(Code::Digit6),
                '7' => Some(Code::Digit7),
                '8' => Some(Code::Digit8),
                '9' => Some(Code::Digit9),
                _ => None,
            };
        }
    }
    match n.as_str() {
        "space" => Some(Code::Space),
        "enter" | "return" => Some(Code::Enter),
        "tab" => Some(Code::Tab),
        "escape" | "esc" => Some(Code::Escape),
        "backspace" => Some(Code::Backspace),
        "f1" => Some(Code::F1),
        "f2" => Some(Code::F2),
        "f3" => Some(Code::F3),
        "f4" => Some(Code::F4),
        "f5" => Some(Code::F5),
        "f6" => Some(Code::F6),
        "f7" => Some(Code::F7),
        "f8" => Some(Code::F8),
        "f9" => Some(Code::F9),
        "f10" => Some(Code::F10),
        "f11" => Some(Code::F11),
        "f12" => Some(Code::F12),
        _ => None,
    }
}

pub fn load_hotkey_spec() -> String {
    if let Some(p) = hotkey_config_path() {
        if let Ok(s) = std::fs::read_to_string(&p) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    "Ctrl+Alt+U".to_string()
}

pub fn save_hotkey_spec(spec: &str) -> Result<(), String> {
    let p = hotkey_config_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, spec).map_err(|e| e.to_string())
}

// Higiene 2026-08-12 (audit 08-09 #46, decidido por el usuario): fuera la
// cadena inbox_shortcut / register_inbox_shortcut / pause_global_hotkeys_inner
// / resume_global_hotkeys_inner — el atajo de inbox quick-capture (Ctrl+Alt+I)
// nunca llego a registrarse en runtime (las llamadas de setup() quedaron
// comentadas) y pause/resume solo existia para servirlo. Git lo conserva.

/// Convenience helper that lib.rs's handler can call directly to emit
/// the open-inbox event. Not used yet (lib.rs inlines the same logic)
/// but kept here so the wiring layer has a single function to call if
/// the team prefers that shape.
#[allow(dead_code)]
pub fn emit_open_inbox(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit("open-inbox", ());
    }
}
