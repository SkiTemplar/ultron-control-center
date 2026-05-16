// ULTRON Control Center — Tauri backend
//
// Phase 2 additions:
//   - read_alerts: parse ~/.ultron/alerts.jsonl into structured entries
//   - read_changelog: parse ~/.ultron/cockpit/changelog.ndjson into entries
//   - Tray icon: stays neutral for now (Phase 2.5 swaps icon by global status)

mod activity_timeline;
mod ai_router;
mod alerts_admin;
mod auth;
mod backup_status;
mod button_prompts;
mod claude_sessions;
mod codex_fallback;
mod cost_watchdog;
mod features;
mod full_diagnostic;
mod hooks_admin;
mod hotkeys;
mod in_app_shortcuts;
mod inbox;
mod installed_apps;
mod instructions;
mod logs;
mod gaming;
mod mcps;
mod memory;
mod memory_graph;
mod agents;
mod maintenance;
mod memory_highlights;
mod mode;
mod news;
mod personal;
mod plans;
mod project_hotkeys;
mod projects;
mod self_improve;
mod sessions;
mod settings;
mod skills;
mod system;
mod system_diagnose;
mod toast_emit;
mod tray;
mod usage;

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use tauri::{Emitter, Manager};
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

/// Frontend-facing helper: returns the absolute path to the ULTRON root
/// (`~/.ultron`) as a UTF-8 string. The TS helper `getUltronRoot()` in
/// `src/lib/paths.ts` invokes this so the frontend never has to hardcode
/// `C:\Users\<name>\.ultron` to compute child paths.
#[tauri::command]
fn ultron_root_str() -> Result<String, String> {
    Ok(ultron_root()?.to_string_lossy().to_string())
}

/// Frontend-facing helper: returns the absolute path to the user's home
/// directory as a UTF-8 string. Used by the TS helper `getHomeDir()` to
/// compute paths like `~/.claude/skills/<name>` without hardcoding the
/// Windows user folder.
#[tauri::command]
fn home_dir_str() -> Result<String, String> {
    dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .ok_or_else(|| "No HOME dir".to_string())
}

#[tauri::command]
async fn compute_activity_timeline(
    days: u32,
) -> Result<activity_timeline::TimelineSummary, String> {
    activity_timeline::compute_activity_timeline_inner(days)
}

#[tauri::command]
async fn compute_cost(window_hours: Option<u32>) -> Result<cost_watchdog::CostSnapshot, String> {
    cost_watchdog::compute_cost_inner(window_hours.unwrap_or(6))
}

#[tauri::command]
async fn append_inbox(text: String) -> Result<(), String> {
    inbox::append_inbox_inner(&text)
}

#[tauri::command]
async fn list_inbox(limit: Option<usize>) -> Result<Vec<inbox::InboxEntry>, String> {
    inbox::list_inbox_inner(limit.unwrap_or(100))
}

#[tauri::command]
async fn add_launcher_item(
    project_id: String,
    item: projects::LauncherItem,
) -> Result<projects::UpdateProjectResult, String> {
    projects::add_launcher_item_inner(projects::AddLauncherItemPayload { project_id, item })
}

#[tauri::command]
async fn remove_launcher_item(
    project_id: String,
    index: usize,
) -> Result<projects::UpdateProjectResult, String> {
    projects::remove_launcher_item_inner(project_id, index)
}

#[tauri::command]
async fn reorder_launcher_items(
    project_id: String,
    from: usize,
    to: usize,
) -> Result<projects::UpdateProjectResult, String> {
    projects::reorder_launcher_items_inner(project_id, from, to)
}

#[tauri::command]
async fn launch_item(
    app: tauri::AppHandle,
    project_id: String,
    index: usize,
) -> Result<(), String> {
    projects::launch_item_inner(app, project_id, index).await
}

#[tauri::command]
async fn launch_all_items(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<usize, String> {
    projects::launch_all_items_inner(app, project_id).await
}

#[tauri::command]
async fn list_hooks() -> Result<hooks_admin::HooksList, String> {
    hooks_admin::list_hooks_inner()
}

#[tauri::command]
async fn add_hook(
    event: String,
    matcher: Option<String>,
    command: String,
) -> Result<hooks_admin::HookMutationResult, String> {
    hooks_admin::add_hook_inner(event, matcher, command)
}

#[tauri::command]
async fn update_hook(
    id: String,
    command: Option<String>,
    enabled: Option<bool>,
    matcher: Option<String>,
) -> Result<hooks_admin::HookMutationResult, String> {
    hooks_admin::update_hook_inner(id, command, enabled, matcher)
}

#[tauri::command]
async fn toggle_hook(id: String) -> Result<hooks_admin::HookMutationResult, String> {
    hooks_admin::toggle_hook_inner(id)
}

#[tauri::command]
async fn delete_hook(id: String) -> Result<hooks_admin::HookMutationResult, String> {
    hooks_admin::delete_hook_inner(id)
}

#[tauri::command]
async fn test_hook(
    id: String,
    mock_payload: Option<String>,
) -> Result<hooks_admin::HookTestResult, String> {
    hooks_admin::test_hook_inner(id, mock_payload)
}

#[tauri::command]
async fn recent_hook_fires(
    limit: Option<usize>,
) -> Result<hooks_admin::HookFiresReport, String> {
    hooks_admin::recent_hook_fires_inner(limit)
}

#[tauri::command]
async fn request_hook_via_ai(
    app: tauri::AppHandle,
    description: String,
) -> Result<String, String> {
    hooks_admin::request_hook_via_ai_inner(&app, description).await
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
    let raw = read_jsonl_tail::<serde_json::Value>(path, lim)?;
    // Drop ack-only tombstones: rows that carry no source/message/severity
    // and only exist to flag a prior alert as acknowledged. They are pure
    // markers, never UI items. Without this filter they render as
    // "info" with empty text in the Notifications tab.
    let filtered: Vec<serde_json::Value> = raw
        .into_iter()
        .filter(|v| {
            let has_message = v.get("message").and_then(|m| m.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
            let has_source = v.get("source").and_then(|s| s.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
            let has_severity = v.get("severity").and_then(|s| s.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
            has_message || has_source || has_severity
        })
        .collect();
    Ok(filtered)
}

#[tauri::command]
async fn delete_alert_entries(fingerprints: Vec<String>) -> Result<usize, String> {
    alerts_admin::delete_alerts_by_fingerprints(fingerprints)
}

// F6: Dashboard rework — parallel system diagnostic + auto-fix scripts.
#[tauri::command]
async fn run_full_diagnostic() -> Result<full_diagnostic::FullDiagnostic, String> {
    full_diagnostic::run_full_diagnostic_inner()
}

#[tauri::command]
async fn apply_auto_fix(
    app: tauri::AppHandle,
    name: String,
) -> Result<full_diagnostic::AutoFixResult, String> {
    full_diagnostic::apply_auto_fix_inner(&app, name).await
}

// F2: gaming.detected probe — emits alert + toast when a new game process is detected.
#[tauri::command]
async fn detect_running_games(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    gaming::detect_running_games_inner(&app).await
}

// F7: Settings refactor — reset mode to autodetect + backup root config.
#[tauri::command]
async fn reset_mode_to_autodetect() -> Result<mode::ModeSetResult, String> {
    mode::reset_mode_to_autodetect_inner()
}

#[tauri::command]
async fn get_backup_root() -> Result<backup_status::BackupRootInfo, String> {
    backup_status::get_backup_root_inner()
}

#[tauri::command]
async fn set_backup_root(path: String) -> Result<backup_status::BackupRootInfo, String> {
    backup_status::set_backup_root_inner(backup_status::SetBackupRootPayload { path })
}

#[tauri::command]
async fn purge_legacy_autostart() -> Result<settings::AutostartPurgeResult, String> {
    settings::purge_legacy_autostart_inner()
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
async fn get_skill_findings(name: String) -> Result<skills::SkillSecurityReport, String> {
    skills::get_skill_findings_inner(name)
}

#[tauri::command]
async fn list_maintenance_commands() -> Result<Vec<maintenance::MaintenanceCommand>, String> {
    Ok(maintenance::list_maintenance_commands_inner())
}

#[tauri::command]
async fn run_maintenance_command(kind: String) -> Result<maintenance::MaintenanceResult, String> {
    maintenance::run_maintenance_inner(kind)
}

#[tauri::command]
async fn run_detect_gaps() -> Result<maintenance::GapsReport, String> {
    maintenance::run_detect_gaps_inner()
}

#[tauri::command]
async fn run_app_lifecycle(kind: String) -> Result<(), String> {
    maintenance::run_app_lifecycle_inner(kind)
}

/// Open a project path in the user's IDE.
/// Order: VS Code (`code <path>`) -> Cursor (`cursor <path>`) -> file explorer.
/// Path is canonicalised to reject relative / traversal payloads.
#[tauri::command]
async fn list_agents() -> Result<Vec<agents::AgentInfo>, String> {
    agents::list_agents_inner()
}

#[tauri::command]
async fn read_agent_md(name: String) -> Result<String, String> {
    agents::read_agent_md_inner(&name)
}

#[tauri::command]
async fn create_agent(
    name: String,
    description: String,
    body: String,
    model: Option<String>,
    tools: Vec<String>,
) -> Result<agents::AgentMutationResult, String> {
    agents::create_agent_inner(name, description, body, model, tools)
}

#[tauri::command]
async fn update_agent_md(
    name: String,
    content: String,
) -> Result<agents::AgentMutationResult, String> {
    agents::update_agent_md_inner(name, content)
}

#[tauri::command]
async fn delete_agent(name: String) -> Result<agents::AgentMutationResult, String> {
    agents::delete_agent_inner(name)
}

#[tauri::command]
async fn get_agent_findings(name: String) -> Result<agents::AgentSecurityReport, String> {
    agents::get_agent_findings_inner(name)
}

#[tauri::command]
async fn allow_agent_manually(
    name: String,
    rules: Vec<String>,
    reason: String,
) -> Result<agents::AllowAgentResult, String> {
    agents::allow_agent_manually_inner(name, rules, reason)
}

#[tauri::command]
async fn open_project_in_ide(
    path: String,
    preferred_ide: Option<String>,
) -> Result<String, String> {
    use std::path::PathBuf;
    let p = PathBuf::from(&path);
    if !p.is_dir() && !p.is_file() {
        return Err(format!("path not found: {}", path));
    }
    let canonical = p.canonicalize().map_err(|e| format!("canonicalize: {}", e))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    // Strip the Windows extended path prefix \\?\ which `code` doesn't like.
    let cleaned = canonical_str
        .strip_prefix(r"\\?\")
        .unwrap_or(&canonical_str)
        .to_string();

    // Map the per-project IDE slug ("vscode" / "cursor" / "code-insiders")
    // to the CLI binary name that ships with that editor. `vscode` is the
    // canonical slug we expose to the UI; the CLI itself is called `code`.
    let slug_to_cli = |s: &str| match s.to_ascii_lowercase().as_str() {
        "vscode" | "vs code" | "code" => Some("code"),
        "cursor" => Some("cursor"),
        "code-insiders" | "code insiders" | "vscode-insiders" | "insiders" => {
            Some("code-insiders")
        }
        _ => None,
    };

    // Build the ordered try list. When the caller supplies a preference we
    // put it first; the remaining CLIs fall in behind it as fallbacks so
    // a project tagged "cursor" still opens *something* when Cursor is
    // missing on this machine (instead of dropping to explorer.exe).
    let mut candidates: Vec<&str> = Vec::new();
    let pref_cli = preferred_ide
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(slug_to_cli);
    if let Some(p) = pref_cli {
        candidates.push(p);
    }
    for c in ["code", "cursor", "code-insiders"] {
        if !candidates.contains(&c) {
            candidates.push(c);
        }
    }

    for cli in &candidates {
        if std::process::Command::new("where").arg(cli).output()
            .map(|o| o.status.success()).unwrap_or(false)
        {
            // Use cmd /C to invoke the .cmd shim winget installs.
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/C", cli, &cleaned]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            cmd.spawn().map_err(|e| format!("spawn {}: {}", cli, e))?;
            return Ok(format!("opened in {}", cli));
        }
    }

    // Fallback: file explorer.
    let mut explorer = std::process::Command::new("explorer.exe");
    explorer.arg(&cleaned);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        explorer.creation_flags(0x08000000);
    }
    explorer.spawn().map_err(|e| format!("spawn explorer: {}", e))?;
    Ok("opened in file explorer (no IDE on PATH)".to_string())
}

#[tauri::command]
async fn allow_skill_manually(
    name: String,
    rules: Vec<String>,
    reason: String,
) -> Result<skills::AllowSkillResult, String> {
    skills::allow_skill_manually_inner(name, rules, reason)
}

#[tauri::command]
async fn memory_status(app: tauri::AppHandle) -> Result<memory::MemoryStatus, String> {
    // F2: route through *_with_emit so qdrant.health alerts fire on probe failure
    Ok(memory::memory_status_with_emit(&app))
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
async fn edit_scheduled_task(
    app: tauri::AppHandle,
    name: String,
    new_trigger_type: String,
    new_trigger_at: Option<String>,
    catch_up: Option<bool>,
) -> Result<system::EditTaskResult, String> {
    system::edit_task_inner(&app, name, new_trigger_type, new_trigger_at, catch_up).await
}

#[tauri::command]
async fn delete_scheduled_task(
    app: tauri::AppHandle,
    name: String,
) -> Result<system::DeleteTaskResult, String> {
    system::delete_task_inner(&app, name).await
}

// ---------------------------------------------------------------------------
// Installed apps commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_installed_apps(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<installed_apps::InstalledAppsReport, String> {
    installed_apps::list_installed_apps_inner(&app, force.unwrap_or(false)).await
}

#[tauri::command]
async fn open_app_folder(install_location: String) -> Result<String, String> {
    installed_apps::open_app_folder_inner(install_location)
}

#[tauri::command]
async fn uninstall_app(
    app: tauri::AppHandle,
    name: String,
    provider: String,
    package_id: Option<String>,
) -> Result<installed_apps::UninstallResult, String> {
    installed_apps::uninstall_app_inner(&app, name, provider, package_id).await
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
    app: tauri::AppHandle,
    name: String,
    path: String,
    ide: Option<String>,
    language: Option<String>,
    tags: Option<Vec<String>>,
    default_provider: Option<String>,
) -> Result<projects::CreateProjectResult, String> {
    // F2: route through *_with_emit so project.created notifications fire
    projects::create_project_inner_with_emit(&app, projects::CreateProjectPayload {
        name,
        path,
        ide,
        language,
        tags,
        default_provider,
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
    default_provider: Option<String>,
) -> Result<projects::UpdateProjectResult, String> {
    projects::update_project_inner(projects::UpdateProjectPayload {
        id,
        name,
        path,
        ide,
        language,
        tags,
        default_provider,
    })
}

/// Surgical patch for `Project.default_provider`. The Projects tab's inline
/// radio invokes this on every selection change without needing to assemble
/// a full update payload; keeps the on-disk write to a single field.
#[tauri::command]
async fn set_default_provider(
    project_id: String,
    provider: String,
) -> Result<projects::UpdateProjectResult, String> {
    projects::set_default_provider_inner(project_id, provider)
}

#[tauri::command]
async fn delete_project(app: tauri::AppHandle, id: String) -> Result<projects::DeleteProjectResult, String> {
    // F2: route through *_with_emit so project.deleted notifications fire
    projects::delete_project_inner_with_emit(&app, id)
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
async fn read_ai_router() -> Result<ai_router::AiRouterConfig, String> {
    ai_router::read_ai_router_inner()
}

#[tauri::command]
async fn save_ai_router(
    config: ai_router::AiRouterConfig,
) -> Result<ai_router::AiRouterConfig, String> {
    ai_router::save_ai_router_inner(config)
}

/// v15.2.40 — resolve a zone for a specific prompt. Honours `auto_mode`
/// by shelling out to `embed_agents.py query` and picking the best
/// subagent. Falls back to the manual config on any failure so the
/// caller never has to handle errors specially.
#[tauri::command]
async fn resolve_zone_for_prompt(
    zone_key: String,
    prompt: String,
) -> Result<ai_router::ResolvedRoute, String> {
    ai_router::resolve_zone_inner(zone_key, prompt)
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
async fn generate_news_session(
    app: tauri::AppHandle,
    theme: Option<String>,
    days: Option<u32>,
) -> Result<news::NewsGenerateResult, String> {
    news::generate_news_session_inner(&app, theme, days).await
}

#[tauri::command]
async fn delete_news(path: String) -> Result<bool, String> {
    news::delete_news_inner(path)
}

#[tauri::command]
async fn read_news_html(path: String) -> Result<String, String> {
    news::read_news_html_inner(path)
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
async fn list_instruction_folders() -> Result<Vec<instructions::InstructionEntry>, String> {
    instructions::list_instruction_folders_inner()
}

#[tauri::command]
async fn instruction_path(kind: String) -> Result<String, String> {
    instructions::instruction_path_inner(kind)
}

#[tauri::command]
async fn read_personal_profile() -> Result<personal::PersonalProfile, String> {
    personal::read_personal_profile_inner()
}

#[tauri::command]
async fn save_personal_profile(
    content: String,
) -> Result<personal::PersonalProfile, String> {
    personal::save_personal_profile_inner(content)
}

#[tauri::command]
async fn read_personal_known() -> Result<personal::PersonalKnown, String> {
    personal::read_personal_known_inner()
}

#[tauri::command]
async fn request_personal_analysis(app: tauri::AppHandle) -> Result<String, String> {
    personal::request_personal_analysis_inner(&app).await
}

#[tauri::command]
async fn read_personal_sample() -> Result<personal::PersonalSample, String> {
    personal::read_personal_sample_inner()
}

#[tauri::command]
async fn train_personal_style(
    app: tauri::AppHandle,
    sample_text: String,
) -> Result<String, String> {
    personal::train_personal_style_inner(&app, sample_text).await
}

#[tauri::command]
async fn generate_style_sample(app: tauri::AppHandle) -> Result<String, String> {
    personal::generate_style_sample_inner(&app).await
}

/// Append a UI-side alert to alerts.jsonl so Notifications picks it up.
/// Used by the frontend's window.onerror / onunhandledrejection so failures
/// in the webview don't get swallowed silently — they show up alongside
/// the backend alerts the user already monitors.
#[tauri::command]
async fn record_ui_alert(
    severity: String,
    source: String,
    message: String,
) -> Result<(), String> {
    // Hard caps so the UI can't flood the file. Also strip CR/LF so the
    // JSONL stays one record per line.
    let sev = match severity.as_str() {
        "info" | "warn" | "critical" | "blocking" => severity,
        _ => "warn".to_string(),
    };
    let mut src = source;
    src.truncate(80);
    let mut msg = message.replace('\r', " ").replace('\n', " ");
    if msg.len() > 600 {
        msg.truncate(600);
        msg.push_str("…");
    }
    if msg.trim().is_empty() {
        return Ok(());
    }
    let path = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/alerts.jsonl");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let iso = {
        let mut days = (now / 86_400) as i64;
        let secs_in_day = (now % 86_400) as u32;
        let h = secs_in_day / 3600;
        let m = (secs_in_day % 3600) / 60;
        let s = secs_in_day % 60;
        let mut year = 1970i32;
        loop {
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
            let yd: i64 = if leap { 366 } else { 365 };
            if days < yd { break; }
            days -= yd;
            year += 1;
        }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let mdays: [i64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let mut month = 0usize;
        while month < 12 && days >= mdays[month] { days -= mdays[month]; month += 1; }
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month + 1, days + 1, h, m, s)
    };
    let entry = serde_json::json!({
        "timestamp": iso,
        "source": src,
        "severity": sev,
        "status": "ui",
        "message": msg,
    });
    let line = entry.to_string() + "\n";
    use std::io::Write;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open alerts: {}", e))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("append alert: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Button prompts catalog — see button_prompts.rs for the rationale. Every AI
// button in the Control Center reads its prompt from this catalog so the user
// can refine the prompts from the Settings → "Button prompts" sub-tab without
// touching the source.
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_button_prompts() -> Result<button_prompts::ButtonPromptsCatalog, String> {
    button_prompts::list_button_prompts_inner()
}

#[tauri::command]
async fn update_button_prompt(
    key: String,
    prompt: String,
) -> Result<button_prompts::ButtonPrompt, String> {
    button_prompts::update_button_prompt_inner(key, prompt)
}

#[tauri::command]
async fn reset_button_prompt(key: String) -> Result<button_prompts::ButtonPrompt, String> {
    button_prompts::reset_button_prompt_inner(key)
}

#[tauri::command]
async fn get_button_prompt(
    key: String,
    vars: Option<std::collections::BTreeMap<String, String>>,
) -> Result<String, String> {
    button_prompts::get_button_prompt_inner(key, vars.unwrap_or_default())
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
async fn pause_global_hotkeys(app: tauri::AppHandle) -> Result<(), String> {
    hotkeys::pause_global_hotkeys_inner(&app)
}

#[tauri::command]
async fn resume_global_hotkeys(app: tauri::AppHandle) -> Result<(), String> {
    // Re-register inbox shortcut + restore the current main toggle binding.
    hotkeys::resume_global_hotkeys_inner(&app)?;
    let spec = load_hotkey_spec();
    if let Ok(sc) = parse_hotkey(&spec) {
        let _ = app.global_shortcut().register(sc);
    }
    Ok(())
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
async fn patch_plan_status(app: tauri::AppHandle, id: String, status: String) -> Result<bool, String> {
    // F2: route through *_with_emit so plan.resolved notifications fire
    plans::patch_plan_status_inner_with_emit(&app, id, status)
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

// LIB_RS_WIRING: new command for Phase 3 Plans auto-archive.
#[tauri::command]
async fn auto_archive_resolved_plans(days: Option<u32>) -> Result<usize, String> {
    plans::auto_archive_resolved(days.unwrap_or(30))
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
        // v15.3 auto-updater: the plugin reads `plugins.updater.endpoints`
        // and `plugins.updater.pubkey` from tauri.conf.json and exposes the
        // JS-side `check()` / `downloadAndInstall()` API used by Settings
        // -> App lifecycle -> "Check for updates". The companion process
        // plugin exposes `relaunch()` for the post-install restart prompt.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--from-autostart"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if hotkeys::is_inbox_shortcut(shortcut) {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.emit("open-inbox", ());
                            }
                            return;
                        }
                        if project_hotkeys::handle_shortcut(app, shortcut, event.state()) {
                            return;
                        }
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            ultron_status,
            qdrant_health,
            read_alerts,
            delete_alert_entries,
            purge_legacy_autostart,
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
            get_skill_findings,
            allow_skill_manually,
            list_maintenance_commands,
            run_maintenance_command,
            run_detect_gaps,
            run_app_lifecycle,
            open_project_in_ide,
            list_agents,
            read_agent_md,
            create_agent,
            update_agent_md,
            delete_agent,
            get_agent_findings,
            allow_agent_manually,
            memory_status,
            spawn_session,
            run_inline,
            list_projects,
            open_project,
            scan_projects,
            create_project,
            update_project,
            delete_project,
            set_default_provider,
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
            edit_scheduled_task,
            delete_scheduled_task,
            list_installed_apps,
            open_app_folder,
            uninstall_app,
            list_killable_processes,
            kill_processes,
            windows_tweaks_status,
            windows_tweak_set,
            auth_status,
            get_ultron_mode,
            set_ultron_mode,
            read_ai_router,
            save_ai_router,
            resolve_zone_for_prompt,
            list_news,
            generate_news,
            generate_news_session,
            delete_news,
            read_news_html,
            summarize_news,
            list_claude_sessions,
            run_diagnose,
            diagnose_with_ai,
            backup_status,
            list_logs,
            tail_log,
            list_instruction_folders,
            instruction_path,
            read_personal_profile,
            save_personal_profile,
            read_personal_known,
            request_personal_analysis,
            read_personal_sample,
            train_personal_style,
            generate_style_sample,
            record_ui_alert,
            list_plans,
            patch_plan_status,
            add_plan,
            update_plan,
            delete_plan,
            clean_resolved_plans,
            auto_archive_resolved_plans,
            run_full_diagnostic,
            apply_auto_fix,
            detect_running_games,
            reset_mode_to_autodetect,
            get_backup_root,
            set_backup_root,
            toast_emit::get_toast_enabled,
            toast_emit::set_toast_enabled,
            get_global_hotkey,
            set_global_hotkey,
            pause_global_hotkeys,
            resume_global_hotkeys,
            self_improve_report,
            run_codex_adversarial_review,
            run_doctor,
            ultron_root_str,
            home_dir_str,
            memory_graph::compute_memory_graph,
            compute_activity_timeline,
            compute_cost,
            append_inbox,
            list_inbox,
            codex_fallback::build_fallback_context,
            codex_fallback::build_fallback_prompt,
            codex_fallback::launch_codex_fallback,
            project_hotkeys::project_at_slot,
            project_hotkeys::get_project_hotkeys,
            project_hotkeys::set_project_at_slot,
            project_hotkeys::clear_project_at_slot,
            in_app_shortcuts::get_in_app_shortcuts,
            in_app_shortcuts::set_in_app_shortcuts,
            add_launcher_item,
            remove_launcher_item,
            reorder_launcher_items,
            launch_item,
            launch_all_items,
            features::read_features,
            features::save_features,
            memory_highlights::compute_memory_highlights,
            memory_highlights::compute_memory_link_graph,
            memory_highlights::mark_orphan_for_review,
            list_hooks,
            add_hook,
            update_hook,
            toggle_hook,
            delete_hook,
            test_hook,
            recent_hook_fires,
            request_hook_via_ai,
            list_button_prompts,
            update_button_prompt,
            reset_button_prompt,
            get_button_prompt
        ])
        .setup(|app| {
            // Persisted main toggle hotkey (Ctrl+Alt+U by default).
            let shortcut_handle = app.global_shortcut();
            let spec = load_hotkey_spec();
            let shortcut = parse_hotkey(&spec).unwrap_or_else(|e| {
                eprintln!("[ultron] persisted hotkey '{}' rejected: {} — falling back", spec, e);
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyU)
            });
            if let Err(e) = shortcut_handle.register(shortcut) {
                eprintln!("[ultron] global shortcut register failed: {}", e);
            }

            // Inbox quick-capture hotkey (Ctrl+Alt+I).
            if let Err(e) = hotkeys::register_inbox_shortcut(app.handle()) {
                eprintln!("[ultron] inbox hotkey register failed: {}", e);
            }

            // Project slot hotkeys (Ctrl+Alt+1..9).
            if let Err(e) = project_hotkeys::register_project_hotkeys(app.handle()) {
                eprintln!("[ultron] project hotkeys init failed: {}", e);
            }

            // Custom per-project hotkeys defined in Settings →
            // Project hotkeys, persisted at
            // ~/.ultron/cockpit/project-hotkeys.json.
            if let Err(e) = project_hotkeys::register_custom_hotkeys(app.handle()) {
                eprintln!("[ultron] custom project hotkeys init failed: {}", e);
            }

            // Tray + close-to-tray.
            if let Err(e) = tray::init_tray(app.handle()) {
                eprintln!("[ultron] tray init failed: {}", e);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
