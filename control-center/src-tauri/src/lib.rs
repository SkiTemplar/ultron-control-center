// ULTRON Control Center - Tauri backend
//
// Responsibilities:
//   - System tray icon with menu (Open / Quit)
//   - Window show/hide toggle on tray click
//   - Sidecar invocation of ~/.ultron/scripts/cockpit/ultron.ps1
//   - Exposes #[tauri::command] handlers callable from React frontend
//
// Phase 1 (foundation): minimal subset to prove the IPC path works.
// Later phases add more commands as we port the 90 CLI subcommands.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_shell::ShellExt;

// ---------------------------------------------------------------------------
// Commands callable from frontend via invoke()
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct CmdResult {
    success: bool,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
}

/// Invoke `ultron.ps1 status` via PowerShell.
/// Returns combined stdout/stderr/exit_code for the frontend to render.
#[tauri::command]
async fn ultron_status(app: tauri::AppHandle) -> Result<CmdResult, String> {
    let script_path = dirs::home_dir()
        .ok_or_else(|| "No HOME dir".to_string())?
        .join(".ultron")
        .join("scripts")
        .join("cockpit")
        .join("ultron.ps1");

    let script_str = script_path.to_string_lossy().to_string();

    let output = app
        .shell()
        .command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_str,
            "status",
        ])
        .output()
        .await
        .map_err(|e| format!("spawn failed: {}", e))?;

    Ok(CmdResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
    })
}

/// Read qdrant-health.json to get current Qdrant status.
#[tauri::command]
async fn qdrant_health() -> Result<serde_json::Value, String> {
    let path = dirs::home_dir()
        .ok_or_else(|| "No HOME dir".to_string())?
        .join(".ultron")
        .join(".tmp")
        .join("qdrant-health.json");

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read failed: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("parse failed: {}", e))
}

// ---------------------------------------------------------------------------
// Tray icon + window management
// ---------------------------------------------------------------------------

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![ultron_status, qdrant_health])
        .setup(|app| {
            // Build tray menu: Open / Quit
            let open_i = MenuItem::with_id(app, "open", "Open ULTRON", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("ULTRON Control Center")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false) // left click toggles window
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => toggle_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Hide window when the user closes it (X button) — keep app in tray.
            let main = app.get_webview_window("main").unwrap();
            let main_clone = main.clone();
            main.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let _ = main_clone.hide();
                    api.prevent_close();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
