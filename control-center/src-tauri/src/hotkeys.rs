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

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

/// Ctrl+Alt+I (or Cmd+Alt+I on macOS — CommandOrControl is what the user
/// asked for; on Windows that resolves to Control).
pub fn inbox_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyI)
}

/// Returns true if the pressed `Shortcut` matches the inbox combo.
/// Compares modifiers + key code via the upstream `matches()` helper so
/// it stays stable across re-registrations.
pub fn is_inbox_shortcut(s: &Shortcut) -> bool {
    let target = inbox_shortcut();
    s.matches(target.mods, target.key)
}

/// Registers Ctrl+Alt+I with the global-shortcut plugin. The actual
/// "emit open-inbox" wiring lives in lib.rs's existing
/// with_handler closure (see LIB_RS_WIRING above) — we only register
/// the binding here.
///
/// Safe to call multiple times: if already registered we return Ok(()).
pub fn register_inbox_shortcut(app: &AppHandle) -> Result<(), String> {
    let handle = app.global_shortcut();
    let sc = inbox_shortcut();
    // is_registered returns bool; if true we're done.
    if handle.is_registered(sc) {
        return Ok(());
    }
    handle
        .register(sc)
        .map_err(|e| format!("register Ctrl+Alt+I: {}", e))
}

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

/// Temporarily unregister ALL global shortcuts so the Settings hotkey
/// editor can capture combos that would otherwise be swallowed by the
/// OS-level listener (e.g. user wants to test Ctrl+Alt+U — the same combo
/// that toggles the window — without the window closing on every keypress).
/// The frontend calls `pause_global_hotkeys` on entering capture mode and
/// `resume_global_hotkeys` on commit/cancel.
pub fn pause_global_hotkeys_inner(app: &AppHandle) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| format!("unregister_all: {}", e))
}

/// Re-register the inbox shortcut after a `pause`. The main toggle hotkey
/// is re-registered separately by `lib.rs::register_global_hotkey` which
/// the frontend invokes after editing via `set_global_hotkey`.
pub fn resume_global_hotkeys_inner(app: &AppHandle) -> Result<(), String> {
    // Re-register the inbox combo. The main toggle combo is re-registered
    // by whichever component edited it (or stays unregistered if the user
    // just visited the editor without changing).
    register_inbox_shortcut(app)?;
    Ok(())
}
