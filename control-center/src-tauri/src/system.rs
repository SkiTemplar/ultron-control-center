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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskTrigger {
    pub kind: String,
    pub start: String,
    pub enabled: bool,
    pub extra: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskAction {
    pub execute: String,
    pub arguments: String,
    pub working: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskEvent {
    pub time: String,
    pub event_id: i32,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskDetail {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    pub state: String,
    pub last_run: String,
    pub next_run: String,
    pub last_result: i64,
    pub missed_runs: i64,
    pub principal_user: String,
    pub principal_logon: String,
    pub run_level: String,
    pub triggers: Vec<TaskTrigger>,
    pub actions: Vec<TaskAction>,
    pub history: Vec<TaskEvent>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GpuInfo {
    pub name: String,
    pub util_pct: Option<i32>,
    pub mem_used_mb: Option<i64>,
    pub mem_total_mb: Option<i64>,
    pub temp_c: Option<i32>,
    pub vendor: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BatteryInfo {
    pub percent: i32,
    pub status: i32,
    pub plugged_in: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NetworkInfo {
    pub interface: String,
    pub ipv4: String,
    pub gateway: String,
    pub dns: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProcInfo {
    pub name: String,
    pub pid: i64,
    pub ram_mb: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RichSystemInfo {
    pub hostname: String,
    pub user: String,
    pub os_name: String,
    pub os_version: String,
    pub uptime_seconds: i64,
    pub cpu_name: String,
    pub cpu_cores: i32,
    pub cpu_threads: i32,
    #[serde(default)]
    pub cpu_load_pct: Option<i32>,
    pub ram_total_gb: f64,
    pub ram_free_gb: f64,
    pub ram_used_gb: f64,
    pub ram_pct_used: f64,
    pub disk_c_total_gb: f64,
    pub disk_c_free_gb: f64,
    pub disk_c_pct_used: f64,
    #[serde(default)]
    pub gpus: Vec<GpuInfo>,
    #[serde(default)]
    pub battery: Option<BatteryInfo>,
    #[serde(default)]
    pub network: Option<NetworkInfo>,
    #[serde(default)]
    pub top_procs: Vec<ProcInfo>,
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
    // Tolerant parse: ConvertTo-Json in PS 5.1 collapses single-element
    // arrays to objects unless you wrap in @(). If we ever land in that
    // shape we re-wrap before deserialising so the UI still gets a list.
    let parsed: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|e| format!("parse tasks json: {} (output: {})", e, trimmed))?;
    let arr_value = if parsed.is_array() {
        parsed
    } else {
        serde_json::Value::Array(vec![parsed])
    };
    serde_json::from_value::<Vec<ScheduledTaskInfo>>(arr_value)
        .map_err(|e| format!("parse tasks json (normalised): {}", e))
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

pub async fn task_detail_inner(
    app: &tauri::AppHandle,
    name: String,
) -> Result<TaskDetail, String> {
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!("invalid task name '{}'", name));
    }
    if !name.starts_with("ULTRON") && !name.starts_with("Ultron") {
        return Err("only ULTRON-* tasks allowed".to_string());
    }
    let (stdout, stderr, code, ok) =
        run_ps(app, &["-Action", "detail", "-Name", &name]).await?;
    if !ok {
        return Err(format!(
            "system_tasks.ps1 detail failed (exit {:?}): {}",
            code, stderr
        ));
    }
    serde_json::from_str::<TaskDetail>(stdout.trim())
        .map_err(|e| format!("parse task detail: {} (output: {})", e, stdout.trim()))
}

pub async fn rich_system_info_inner(
    app: &tauri::AppHandle,
) -> Result<RichSystemInfo, String> {
    let (stdout, stderr, code, ok) = run_ps(app, &["-Action", "richinfo"]).await?;
    if !ok {
        return Err(format!(
            "system_tasks.ps1 richinfo failed (exit {:?}): {}",
            code, stderr
        ));
    }
    serde_json::from_str::<RichSystemInfo>(stdout.trim())
        .map_err(|e| format!("parse rich info: {} (output: {})", e, stdout.trim()))
}
