// ULTRON Control Center — System module.
//
// Surfaces Windows scheduled tasks (ULTRON-*), system info (OS, uptime,
// disk C:\), and exposes run-now for tasks. All Windows API access is
// delegated to scripts/cockpit/system_tasks.ps1 which already does the
// CIM parsing and ConvertTo-Json with a stable shape.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScheduledTaskInfo {
    pub name: String,
    pub state: String,
    pub last_run: String,
    pub next_run: String,
    pub last_result: i64,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SystemInfo {
    pub hostname: String,
    pub user: String,
    pub os_name: String,
    pub os_version: String,
    pub uptime_seconds: i64,
    pub disk_c_total_gb: f64,
    pub disk_c_free_gb: f64,
    pub disk_c_pct_used: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct RunTaskResult {
    pub success: bool,
    pub name: String,
    pub stderr: String,
}

fn script_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron/scripts/cockpit/system_tasks.ps1"))
        .ok_or_else(|| "no HOME".to_string())
}

async fn run_ps(
    app: &tauri::AppHandle,
    args: &[&str],
) -> Result<(String, String, Option<i32>, bool), String> {
    let script = script_path()?;
    let script_str = script.to_string_lossy().to_string();
    let mut full_args: Vec<String> = vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        script_str,
    ];
    for a in args {
        full_args.push((*a).to_string());
    }
    let str_args: Vec<&str> = full_args.iter().map(String::as_str).collect();

    let output = app
        .shell()
        .command("powershell.exe")
        .args(str_args)
        .output()
        .await
        .map_err(|e| format!("spawn ps: {}", e))?;
    Ok((
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code(),
        output.status.success(),
    ))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

pub async fn list_tasks_inner(
    app: &tauri::AppHandle,
) -> Result<Vec<ScheduledTaskInfo>, String> {
    let (stdout, stderr, code, ok) = run_ps(app, &["-Action", "list"]).await?;
    if !ok {
        return Err(format!(
            "system_tasks.ps1 list failed (exit {:?}): {}",
            code, stderr
        ));
    }
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<ScheduledTaskInfo>>(trimmed)
        .map_err(|e| format!("parse tasks json: {} (output: {})", e, trimmed))
}

pub async fn run_task_inner(
    app: &tauri::AppHandle,
    name: String,
) -> Result<RunTaskResult, String> {
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!("invalid task name '{}'", name));
    }
    if !name.starts_with("ULTRON") && !name.starts_with("Ultron") {
        return Err("only ULTRON-* tasks allowed".to_string());
    }
    let (_, stderr, _code, ok) = run_ps(app, &["-Action", "run", "-Name", &name]).await?;
    Ok(RunTaskResult {
        success: ok,
        name,
        stderr: stderr.trim().to_string(),
    })
}

pub async fn system_info_inner(app: &tauri::AppHandle) -> Result<SystemInfo, String> {
    let (stdout, stderr, code, ok) = run_ps(app, &["-Action", "info"]).await?;
    if !ok {
        return Err(format!(
            "system_tasks.ps1 info failed (exit {:?}): {}",
            code, stderr
        ));
    }
    serde_json::from_str::<SystemInfo>(stdout.trim())
        .map_err(|e| format!("parse system info: {}", e))
}
