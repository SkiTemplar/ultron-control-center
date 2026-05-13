// ULTRON Control Center — Tauri backend
//
// Phase 2 additions:
//   - read_alerts: parse ~/.ultron/alerts.jsonl into structured entries
//   - read_changelog: parse ~/.ultron/cockpit/changelog.ndjson into entries
//   - Tray icon: stays neutral for now (Phase 2.5 swaps icon by global status)

mod mcps;
mod memory;
mod projects;
mod sessions;
mod skills;

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_shell::ShellExt;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn ultron_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron"))
        .ok_or_else(|| "No HOME dir".to_string())
}

fn read_jsonl_tail<T>(path: PathBuf, limit: usize) -> Result<Vec<T>, String>
where
    T: serde::de::DeserializeOwned,
{
    let file = File::open(&path).map_err(|e| format!("open {:?}: {}", path, e))?;
    let reader = BufReader::new(file);
    let mut lines: Vec<String> = Vec::new();
    for line in reader.lines() {
        let l = line.map_err(|e| format!("read line: {}", e))?;
        if !l.trim().is_empty() {
            lines.push(l);
        }
    }
    // Take the last `limit` lines, newest first
    let n = lines.len();
    let start = if n > limit { n - limit } else { 0 };
    let mut out: Vec<T> = Vec::with_capacity(n - start);
    for l in lines[start..].iter().rev() {
        if let Ok(parsed) = serde_json::from_str::<T>(l) {
            out.push(parsed);
        }
        // Silently skip malformed lines — alerts.jsonl historically had
        // some broken entries; we don't want a single bad line to break
        // the whole list.
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Command types
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct CmdResult {
    success: bool,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn ultron_status(app: tauri::AppHandle) -> Result<CmdResult, String> {
    let script_path = ultron_root()?.join("scripts/cockpit/ultron.ps1");
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

#[tauri::command]
async fn qdrant_health() -> Result<serde_json::Value, String> {
    let path = ultron_root()?.join(".tmp/qdrant-health.json");
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read failed: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("parse failed: {}", e))
}

#[tauri::command]
async fn read_alerts(limit: Option<usize>) -> Result<Vec<serde_json::Value>, String> {
    let path = ultron_root()?.join("alerts.jsonl");
    let lim = limit.unwrap_or(100).max(1).min(2000);
    read_jsonl_tail::<serde_json::Value>(path, lim)
}

#[tauri::command]
async fn read_changelog(limit: Option<usize>) -> Result<Vec<serde_json::Value>, String> {
    let path = ultron_root()?.join("cockpit/changelog.ndjson");
    let lim = limit.unwrap_or(100).max(1).min(2000);
    read_jsonl_tail::<serde_json::Value>(path, lim)
}

// ---------------------------------------------------------------------------
// MCP commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_mcps() -> Result<Vec<mcps::McpInfo>, String> {
    mcps::list_mcps_inner()
}

/// Run mcp_health_check.py and return the updated list of MCPs.
/// Honors the user's CLAUDE.md rule of always invoking python via `uv run`.
// ---------------------------------------------------------------------------
// Skill commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_skills() -> Result<Vec<skills::SkillInfo>, String> {
    skills::list_skills_inner()
}

#[tauri::command]
async fn read_skill_md(name: String) -> Result<String, String> {
    skills::read_skill_md_inner(&name)
}

#[tauri::command]
async fn memory_status() -> Result<memory::MemoryStatus, String> {
    Ok(memory::memory_status_inner())
}

#[tauri::command]
async fn brain_query(
    app: tauri::AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<memory::BrainResult>, String> {
    memory::brain_query_inner(&app, query, limit).await
}

#[tauri::command]
async fn read_vault_note(path: String) -> Result<String, String> {
    memory::read_vault_note_inner(path)
}

#[tauri::command]
async fn list_projects() -> Result<Vec<projects::ProjectInfo>, String> {
    projects::list_projects_inner()
}

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn spawn_session(
    app: tauri::AppHandle,
    provider: String,
    prompt: Option<String>,
    cwd: Option<String>,
) -> Result<sessions::SpawnResult, String> {
    sessions::spawn_session_inner(&app, provider, prompt, cwd).await
}

#[tauri::command]
async fn run_inline(
    app: tauri::AppHandle,
    provider: String,
    model: Option<String>,
    prompt: String,
) -> Result<sessions::InlineResult, String> {
    sessions::run_inline_inner(&app, provider, model, prompt).await
}

#[tauri::command]
async fn run_mcp_health_check(app: tauri::AppHandle) -> Result<Vec<mcps::McpInfo>, String> {
    let script_path = ultron_root()?.join("scripts/cockpit/mcp_health_check.py");
    let script_str = script_path.to_string_lossy().to_string();

    // Use uv run python for project-managed env (per CLAUDE.md global rule).
    let output = app
        .shell()
        .command("uv")
        .args(["run", "python", &script_str, "--quiet"])
        .output()
        .await
        .map_err(|e| format!("spawn uv: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("health check failed (exit {:?}): {}", output.status.code(), stderr));
    }
    mcps::list_mcps_inner()
}

// ---------------------------------------------------------------------------
// Window management
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ultron_status,
            qdrant_health,
            read_alerts,
            read_changelog,
            list_mcps,
            run_mcp_health_check,
            list_skills,
            read_skill_md,
            memory_status,
            spawn_session,
            run_inline,
            list_projects,
            brain_query,
            read_vault_note
        ])
        .setup(|app| {
            let open_i = MenuItem::with_id(app, "open", "Open ULTRON", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("ULTRON Control Center")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
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

            // Hide window when user clicks X — keeps app in tray.
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
