// ULTRON Control Center — atajo global principal (mostrar/ocultar la ventana).
//
// Parseo de la cadena tipo `Ctrl+Alt+U` a `Shortcut` y carga/guardado de la
// preferencia en disco. El registro con el plugin global-shortcut lo hacen
// `lib.rs` (arranque) y `commands/misc_sub/hotkeys.rs` (cambio en caliente).

use std::path::PathBuf;
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
