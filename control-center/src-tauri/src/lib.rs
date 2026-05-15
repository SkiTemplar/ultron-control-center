// ULTRON Control Center — Tauri backend
//
// Phase 2 additions:
//   - read_alerts: parse ~/.ultron/alerts.jsonl into structured entries
//   - read_changelog: parse ~/.ultron/cockpit/changelog.ndjson into entries
//   - Tray icon: stays neutral for now (Phase 2.5 swaps icon by global status)

mod auth;
mod backup_status;
mod claude_sessions;
mod logs;
mod gaming;
mod mcps;
mod memory;
mod mode;
mod news;
mod plans;
mod projects;
mod self_improve;
mod sessions;
mod settings;
mod skills;
mod system;
mod system_diagnose;
mod usage;

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
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
async fn create_skill(
    name: String,
    description: String,
    body: String,
    layer: String,
) -> Result<skills::SkillCreateResult, String> {
    skills::create_skill_inner(name, description, body, layer)
}

#[tauri::command]
async fn update_skill_md(
    name: String,
    content: String,
) -> Result<skills::SkillUpdateResult, String> {
    skills::update_skill_md_inner(name, content)
}

#[tauri::command]
async fn delete_skill(name: String, soft: bool) -> Result<skills::SkillDeleteResult, String> {
    skills::delete_skill_inner(name, soft)
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
async fn memory_action(
    app: tauri::AppHandle,
    action: String,
) -> Result<memory::ActionResult, String> {
    memory::memory_action_inner(&app, action).await
}

#[tauri::command]
async fn list_recent_vault_notes(
    limit: Option<usize>,
) -> Result<Vec<memory::RecentNote>, String> {
    memory::list_recent_vault_notes_inner(limit)
}

#[tauri::command]
async fn claude_usage() -> Result<usage::UsageReport, String> {
    usage::claude_usage_inner()
}

#[tauri::command]
async fn settings_read() -> Result<settings::SettingsSnapshot, String> {
    settings::settings_read_inner()
}

#[tauri::command]
async fn settings_save(
    content: serde_json::Value,
) -> Result<settings::SettingsSaveResult, String> {
    settings::settings_save_inner(settings::SettingsSavePayload { content })
}

#[tauri::command]
async fn list_scheduled_tasks(
    app: tauri::AppHandle,
) -> Result<Vec<system::ScheduledTaskInfo>, String> {
    system::list_tasks_inner(&app).await
}

#[tauri::command]
async fn run_scheduled_task(
    app: tauri::AppHandle,
    name: String,
) -> Result<system::RunTaskResult, String> {
    system::run_task_inner(&app, name).await
}

#[tauri::command]
async fn system_info(app: tauri::AppHandle) -> Result<system::SystemInfo, String> {
    system::system_info_inner(&app).await
}

#[tauri::command]
async fn task_detail(
    app: tauri::AppHandle,
    name: String,
) -> Result<system::TaskDetail, String> {
    system::task_detail_inner(&app, name).await
}

#[tauri::command]
async fn rich_system_info(
    app: tauri::AppHandle,
) -> Result<system::RichSystemInfo, String> {
    system::rich_system_info_inner(&app).await
}

#[tauri::command]
async fn list_killable_processes(
    app: tauri::AppHandle,
) -> Result<Vec<gaming::GameProcessInfo>, String> {
    gaming::list_killable_inner(&app).await
}

#[tauri::command]
async fn kill_processes(
    app: tauri::AppHandle,
    pids: Vec<i64>,
) -> Result<gaming::KillResult, String> {
    gaming::kill_processes_inner(&app, pids).await
}

#[tauri::command]
async fn windows_tweaks_status(
    app: tauri::AppHandle,
) -> Result<Vec<gaming::WindowsTweak>, String> {
    gaming::windows_tweaks_status_inner(&app).await
}

#[tauri::command]
async fn windows_tweak_set(
    app: tauri::AppHandle,
    key: String,
    enabled: bool,
) -> Result<Vec<gaming::WindowsTweak>, String> {
    gaming::windows_tweak_set_inner(&app, key, enabled).await
}

#[tauri::command]
async fn list_projects() -> Result<Vec<projects::ProjectInfo>, String> {
    projects::list_projects_inner()
}

#[tauri::command]
async fn open_project(
    app: tauri::AppHandle,
    id: String,
) -> Result<projects::ProjectActionResult, String> {
    projects::open_project_inner(&app, id).await
}

#[tauri::command]
async fn scan_projects(
    app: tauri::AppHandle,
) -> Result<Vec<projects::ProjectInfo>, String> {
    projects::scan_projects_inner(&app).await
}

#[tauri::command]
async fn create_project(
    name: String,
    path: String,
    ide: Option<String>,
    language: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<projects::CreateProjectResult, String> {
    projects::create_project_inner(projects::CreateProjectPayload {
        name,
        path,
        ide,
        language,
        tags,
    })
}

#[tauri::command]
async fn update_project(
    id: String,
    name: Option<String>,
    path: Option<String>,
    ide: Option<String>,
    language: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<projects::UpdateProjectResult, String> {
    projects::update_project_inner(projects::UpdateProjectPayload {
        id,
        name,
        path,
        ide,
        language,
        tags,
    })
}

#[tauri::command]
async fn delete_project(id: String) -> Result<projects::DeleteProjectResult, String> {
    projects::delete_project_inner(id)
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
    flags: Option<sessions::SpawnFlags>,
) -> Result<sessions::SpawnResult, String> {
    sessions::spawn_session_inner(&app, provider, prompt, cwd, flags).await
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
async fn add_mcp(
    name: String,
    config: serde_json::Value,
) -> Result<mcps::McpMutationResult, String> {
    mcps::add_mcp_inner(name, config)
}

#[tauri::command]
async fn update_mcp(
    name: String,
    config: serde_json::Value,
) -> Result<mcps::McpMutationResult, String> {
    mcps::update_mcp_inner(name, config)
}

#[tauri::command]
async fn delete_mcp(name: String) -> Result<mcps::McpMutationResult, String> {
    mcps::delete_mcp_inner(name)
}

#[tauri::command]
async fn generate_mcp_from_prompt(
    app: tauri::AppHandle,
    description: String,
) -> Result<mcps::McpGenerationResult, String> {
    mcps::generate_mcp_from_prompt_inner(&app, description).await
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
// Auth status / mode / news / self-improve commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn auth_status() -> Result<auth::AuthStatusReport, String> {
    Ok(auth::auth_status_inner())
}

#[tauri::command]
async fn get_ultron_mode() -> Result<mode::ModeInfo, String> {
    mode::get_mode_inner()
}

#[tauri::command]
async fn set_ultron_mode(mode: String) -> Result<mode::ModeSetResult, String> {
    mode::set_mode_inner(mode::ModeSetPayload { mode })
}

#[tauri::command]
async fn list_news() -> Result<Vec<news::NewsEntry>, String> {
    news::list_news_inner()
}

#[tauri::command]
async fn generate_news(
    app: tauri::AppHandle,
    theme: Option<String>,
    days: Option<u32>,
) -> Result<news::NewsGenerateResult, String> {
    news::generate_news_inner(&app, theme, days).await
}

#[tauri::command]
async fn delete_news(path: String) -> Result<bool, String> {
    news::delete_news_inner(path)
}

#[tauri::command]
async fn summarize_news(app: tauri::AppHandle, path: String) -> Result<String, String> {
    news::summarize_news_inner(&app, path).await
}

#[tauri::command]
async fn backup_status() -> Result<backup_status::BackupStatusReport, String> {
    backup_status::backup_status_inner()
}

#[tauri::command]
async fn list_logs() -> Result<Vec<logs::LogSource>, String> {
    logs::list_logs_inner()
}

#[tauri::command]
async fn tail_log(
    source_id: String,
    lines: Option<usize>,
) -> Result<logs::LogTail, String> {
    logs::tail_log_inner(source_id, lines)
}

#[tauri::command]
async fn list_plans() -> Result<plans::PlansReport, String> {
    plans::list_plans_inner()
}

// --- Global hotkey runtime config ------------------------------------------

fn hotkey_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/.tmp/hotkey.txt"))
}

fn parse_hotkey(spec: &str) -> Result<Shortcut, String> {
    // Accepts strings like "Ctrl+Alt+U", "Ctrl+Shift+F12", "Alt+Space".
    // We're permissive on whitespace and case to match what the user types.
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
                let code = code_from_name(other)
                    .ok_or_else(|| format!("unknown key '{}'", other))?;
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
                'a' => Some(Code::KeyA), 'b' => Some(Code::KeyB), 'c' => Some(Code::KeyC),
                'd' => Some(Code::KeyD), 'e' => Some(Code::KeyE), 'f' => Some(Code::KeyF),
                'g' => Some(Code::KeyG), 'h' => Some(Code::KeyH), 'i' => Some(Code::KeyI),
                'j' => Some(Code::KeyJ), 'k' => Some(Code::KeyK), 'l' => Some(Code::KeyL),
                'm' => Some(Code::KeyM), 'n' => Some(Code::KeyN), 'o' => Some(Code::KeyO),
                'p' => Some(Code::KeyP), 'q' => Some(Code::KeyQ), 'r' => Some(Code::KeyR),
                's' => Some(Code::KeyS), 't' => Some(Code::KeyT), 'u' => Some(Code::KeyU),
                'v' => Some(Code::KeyV), 'w' => Some(Code::KeyW), 'x' => Some(Code::KeyX),
                'y' => Some(Code::KeyY), 'z' => Some(Code::KeyZ),
                _ => None,
            };
        }
        if c.is_ascii_digit() {
            return match c {
                '0' => Some(Code::Digit0), '1' => Some(Code::Digit1), '2' => Some(Code::Digit2),
                '3' => Some(Code::Digit3), '4' => Some(Code::Digit4), '5' => Some(Code::Digit5),
                '6' => Some(Code::Digit6), '7' => Some(Code::Digit7), '8' => Some(Code::Digit8),
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
        "f1" => Some(Code::F1), "f2" => Some(Code::F2), "f3" => Some(Code::F3),
        "f4" => Some(Code::F4), "f5" => Some(Code::F5), "f6" => Some(Code::F6),
        "f7" => Some(Code::F7), "f8" => Some(Code::F8), "f9" => Some(Code::F9),
        "f10" => Some(Code::F10), "f11" => Some(Code::F11), "f12" => Some(Code::F12),
        _ => None,
    }
}

fn load_hotkey_spec() -> String {
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

fn save_hotkey_spec(spec: &str) -> Result<(), String> {
    let p = hotkey_config_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, spec).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_global_hotkey() -> Result<String, String> {
    Ok(load_hotkey_spec())
}

#[tauri::command]
async fn set_global_hotkey(app: tauri::AppHandle, spec: String) -> Result<String, String> {
    let new_shortcut = parse_hotkey(&spec)?;
    let handle = app.global_shortcut();
    // Unregister whatever is currently bound, then register the new one.
    // If the new register fails (e.g. another app owns it), we attempt to
    // restore the previous spec so the user isn't left with NO hotkey.
    let previous = load_hotkey_spec();
    if let Ok(prev_sc) = parse_hotkey(&previous) {
        let _ = handle.unregister(prev_sc);
    }
    if let Err(e) = handle.register(new_shortcut) {
        if let Ok(prev_sc) = parse_hotkey(&previous) {
            let _ = handle.register(prev_sc);
        }
        return Err(format!("register '{}' failed: {}", spec, e));
    }
    save_hotkey_spec(&spec)?;
    Ok(spec)
}

#[tauri::command]
async fn patch_plan_status(id: String, status: String) -> Result<bool, String> {
    plans::patch_plan_status_inner(id, status)
}

#[tauri::command]
async fn add_plan(
    title: String,
    priority: Option<String>,
    status: Option<String>,
    kind: Option<String>,
    description: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<plans::PlanMutateResult, String> {
    plans::add_plan_inner(plans::CreatePlanPayload {
        title,
        priority,
        status,
        kind,
        description,
        tags,
    })
}

#[tauri::command]
async fn update_plan(
    id: String,
    title: Option<String>,
    priority: Option<String>,
    kind: Option<String>,
    description: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<plans::PlanMutateResult, String> {
    plans::update_plan_inner(plans::UpdatePlanPayload {
        id,
        title,
        priority,
        kind,
        description,
        tags,
    })
}

#[tauri::command]
async fn delete_plan(id: String) -> Result<plans::PlanMutateResult, String> {
    plans::delete_plan_inner(id)
}

#[tauri::command]
async fn clean_resolved_plans() -> Result<u64, String> {
    plans::clean_resolved_plans_inner()
}

#[tauri::command]
async fn run_diagnose(
    app: tauri::AppHandle,
    hours: Option<u32>,
) -> Result<system_diagnose::DiagnoseResult, String> {
    system_diagnose::run_diagnose_inner(&app, hours).await
}

#[tauri::command]
async fn diagnose_with_ai(
    app: tauri::AppHandle,
    report_json: String,
    provider: Option<String>,
) -> Result<system_diagnose::AiDiagnoseResult, String> {
    system_diagnose::diagnose_with_ai_inner(&app, report_json, provider).await
}

#[tauri::command]
async fn list_claude_sessions(
    limit: Option<usize>,
) -> Result<Vec<claude_sessions::ClaudeSession>, String> {
    claude_sessions::list_claude_sessions_inner(limit)
}

#[tauri::command]
async fn self_improve_report() -> Result<self_improve::SelfImproveReport, String> {
    self_improve::self_improve_report_inner()
}

#[tauri::command]
async fn run_codex_adversarial_review(
    app: tauri::AppHandle,
) -> Result<self_improve::ReviewResult, String> {
    self_improve::run_codex_adversarial_review_inner(&app).await
}

#[tauri::command]
async fn run_doctor(app: tauri::AppHandle) -> Result<CmdResult, String> {
    // Invokes the enhanced doctor script (Python) and returns its full
    // stdout for the UI to render. Doctor never mutates state — it only
    // reports findings.
    let script = ultron_root()?.join("scripts/cockpit/doctor_check.py");
    let script_str = script.to_string_lossy().to_string();
    let output = app
        .shell()
        .command("uv")
        .args(["run", "python", &script_str])
        .output()
        .await
        .map_err(|e| format!("spawn uv: {}", e))?;
    Ok(CmdResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
    })
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
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--from-autostart"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    // Toggle the main window on press of any registered shortcut.
                    // We only register one (Ctrl+Alt+U) so this handler is dedicated
                    // to that — if you add more, branch on `shortcut`.
                    if event.state() == ShortcutState::Pressed {
                        let _ = shortcut; // future: differentiate shortcuts
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            ultron_status,
            qdrant_health,
            read_alerts,
            read_changelog,
            list_mcps,
            run_mcp_health_check,
            add_mcp,
            update_mcp,
            delete_mcp,
            generate_mcp_from_prompt,
            list_skills,
            read_skill_md,
            create_skill,
            update_skill_md,
            delete_skill,
            memory_status,
            spawn_session,
            run_inline,
            list_projects,
            open_project,
            scan_projects,
            create_project,
            update_project,
            delete_project,
            brain_query,
            read_vault_note,
            memory_action,
            list_recent_vault_notes,
            claude_usage,
            settings_read,
            settings_save,
            list_scheduled_tasks,
            run_scheduled_task,
            system_info,
            task_detail,
            rich_system_info,
            list_killable_processes,
            kill_processes,
            windows_tweaks_status,
            windows_tweak_set,
            auth_status,
            get_ultron_mode,
            set_ultron_mode,
            list_news,
            generate_news,
            delete_news,
            summarize_news,
            list_claude_sessions,
            run_diagnose,
            diagnose_with_ai,
            backup_status,
            list_logs,
            tail_log,
            list_plans,
            patch_plan_status,
            add_plan,
            update_plan,
            delete_plan,
            clean_resolved_plans,
            get_global_hotkey,
            set_global_hotkey,
            self_improve_report,
            run_codex_adversarial_review,
            run_doctor
        ])
        .setup(|app| {
            // Register the persisted global hotkey on startup, falling back
            // to Ctrl+Alt+U if the config file is missing or unparseable.
            // If another app owns the binding we log and carry on so the
            // rest of the app keeps working.
            let shortcut_handle = app.global_shortcut();
            let spec = load_hotkey_spec();
            let shortcut = parse_hotkey(&spec).unwrap_or_else(|e| {
                eprintln!("[ultron] persisted hotkey '{}' rejected: {} — falling back", spec, e);
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyU)
            });
            if let Err(e) = shortcut_handle.register(shortcut) {
                eprintln!("[ultron] global shortcut register failed: {}", e);
            }

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
