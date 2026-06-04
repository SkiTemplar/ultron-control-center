// ULTRON Control Center — System Tray
//
// Builds the tray icon with a quick-actions menu and wires up the
// left-click toggle. Window close-to-tray is handled here too so all
// tray behaviour lives in one place.
//
// Menu items (right-click):
//   - Open ULTRON        -> show + focus main window
//   - New Claude session -> emits "tray-action" {action:"new_claude"}
//   - New Codex session  -> emits "tray-action" {action:"new_codex"}
//   - New Gemini session -> emits "tray-action" {action:"new_gemini"}
//   - Open Plans         -> emits "tray-action" {action:"open_plans"}
//   - Open Memory        -> emits "tray-action" {action:"open_memory"}
//   - separator
//   - Quit               -> app.exit(0)
//
// The session/route items emit events instead of invoking commands
// directly because the frontend already has UI state and command
// wiring (provider pickers, default prompts, route history). Letting
// React handle the dispatch keeps a single source of truth and means
// the user sees the same UX whether they used the tray or the in-app
// button.

use serde_json::json;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

/// Show + focus + unminimize the main window. Mirrors the helper in
/// `lib.rs` (kept private there) so the tray module is self-contained.
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Toggle visibility of the main window. Hidden -> show+focus.
/// Visible -> hide (back to tray).
fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
    }
}

/// Initialise the system tray with the quick-actions menu and wire up
/// the close-to-tray behaviour on the main window.
///
/// Call from `tauri::Builder::default().setup(|app| { ... })` AFTER
/// the main window has been created (which happens during default
/// startup — by the time `setup` runs, `get_webview_window("main")`
/// resolves).
pub fn init_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Menu items. Each gets a stable id so the menu event handler can
    // route by string match. Tauri 2 uses MenuItem::with_id; ids are
    // returned by event.id().as_ref().
    let open_i = MenuItem::with_id(app, "open", "Open ULTRON", true, None::<&str>)?;
    let new_claude_i =
        MenuItem::with_id(app, "new_claude", "New Claude session", true, None::<&str>)?;
    let new_codex_i = MenuItem::with_id(app, "new_codex", "New Codex session", true, None::<&str>)?;
    let new_gemini_i =
        MenuItem::with_id(app, "new_gemini", "New Gemini session", true, None::<&str>)?;
    let plans_i = MenuItem::with_id(app, "open_plans", "Open Plans", true, None::<&str>)?;
    let memory_i = MenuItem::with_id(app, "open_memory", "Open Memory", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open_i,
            &new_claude_i,
            &new_codex_i,
            &new_gemini_i,
            &plans_i,
            &memory_i,
            &sep,
            &quit_i,
        ],
    )?;

    // Reuse the bundled window icon for the tray. `default_window_icon`
    // returns the 32x32 icon Tauri auto-picks for the platform. Using
    // it (instead of resolving a separate tray-icon.png from resources)
    // avoids needing additional resource permissions in capabilities
    // and keeps a consistent brand across taskbar and tray.
    let icon = app
        .default_window_icon()
        .ok_or("no default window icon available")?
        .clone();

    let _tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("ULTRON Control Center")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "open" => focus_main_window(app),
                "quit" => {
                    crate::pty::kill_all_inner();
                    app.exit(0);
                }
                "new_claude" | "new_codex" | "new_gemini" | "open_plans" | "open_memory" => {
                    // Surface the window first so the user sees the
                    // response, then emit. Frontend listens on
                    // "tray-action" and routes to the existing flow
                    // (spawn_session for new_*, tab switch for plans
                    // and memory).
                    focus_main_window(app);
                    let action = match id {
                        "new_claude" => "new_claude",
                        "new_codex" => "new_codex",
                        "new_gemini" => "new_gemini",
                        "open_plans" => "open_plans",
                        "open_memory" => "open_memory",
                        _ => return,
                    };
                    let _ = app.emit("tray-action", json!({ "action": action }));
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left click toggles. Right click is reserved for the menu
            // (which Tauri shows automatically because we did NOT set
            // show_menu_on_left_click(true)).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // Close-to-tray: intercept the window close request and hide
    // instead. Quit from the tray menu remains the only path to a
    // real exit. Without prevent_close() the window would actually
    // destroy itself and we would lose state.
    if let Some(main) = app.get_webview_window("main") {
        let main_clone = main.clone();
        main.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = main_clone.hide();
                api.prevent_close();
            }
        });
    }

    Ok(())
}
