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
    /// Phase 8: whether Settings.StartWhenAvailable is on, i.e. the task
    /// will run on next boot if its scheduled trigger was missed (PC off).
    #[serde(default)]
    pub catch_up: bool,
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
    /// Phase 8: see ScheduledTaskInfo.catch_up.
    #[serde(default)]
    pub catch_up: bool,
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

#[derive(Debug, Serialize, Clone)]
pub struct EditTaskResult {
    pub success: bool,
    pub name: String,
    pub trigger_type: String,
    pub trigger_at: String,
    pub error: String,
    /// Phase 8: whether StartWhenAvailable is now on after the edit.
    pub catch_up: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct DeleteTaskResult {
    pub success: bool,
    pub name: String,
    pub error: String,
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
    // v15.5.18 review: scheduled-task module wraps `system_tasks.ps1` which
    // shells out to Windows Task Scheduler (`schtasks.exe`). Linux uses a
    // different scheduler (systemd timers / cron) with no equivalent
    // wrapper today. Return a clean Err on non-Windows so the UI can
    // surface "scheduled tasks are Windows-only" instead of crashing the
    // spawn with "program not found".
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, args);
        return Err(
            "Scheduled tasks are a Windows-only feature today. \
             Linux equivalent (systemd timers / cron) is on the v15.5.x backlog."
                .to_string(),
        );
    }
    #[cfg(target_os = "windows")]
    {
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
    } // end #[cfg(target_os = "windows")]
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

fn validate_task_name(name: &str) -> Result<(), String> {
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!("invalid task name '{}'", name));
    }
    if !name.starts_with("ULTRON") && !name.starts_with("Ultron") {
        return Err("only ULTRON-* tasks allowed".to_string());
    }
    if name.is_empty() || name.len() > 80 {
        return Err("task name length out of range".to_string());
    }
    Ok(())
}

fn validate_trigger_type(t: &str) -> Result<(), String> {
    match t {
        "Daily" | "Weekly" | "AtLogon" => Ok(()),
        _ => Err(format!("invalid trigger type '{}'", t)),
    }
}

fn validate_trigger_at(at: &str) -> Result<(), String> {
    // HH:MM with HH in 00-23, MM in 00-59
    let bytes = at.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return Err(format!("invalid trigger time '{}' (expected HH:MM)", at));
    }
    let h: u32 = at[0..2].parse().map_err(|_| format!("invalid hour in '{}'", at))?;
    let m: u32 = at[3..5].parse().map_err(|_| format!("invalid minute in '{}'", at))?;
    if h > 23 || m > 59 {
        return Err(format!("invalid trigger time '{}'", at));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct EditPsResult {
    ok: bool,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    trigger_type: Option<String>,
    #[serde(default)]
    trigger_at: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    catch_up: bool,
}

#[derive(Debug, Deserialize)]
struct DeletePsResult {
    ok: bool,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

pub async fn edit_task_inner(
    app: &tauri::AppHandle,
    name: String,
    new_trigger_type: String,
    new_trigger_at: Option<String>,
    catch_up: Option<bool>,
) -> Result<EditTaskResult, String> {
    validate_task_name(&name)?;
    validate_trigger_type(&new_trigger_type)?;

    let at_value = new_trigger_at.unwrap_or_default();
    // For Daily/Weekly the HH:MM is required; AtLogon does not need it.
    if new_trigger_type != "AtLogon" {
        validate_trigger_at(&at_value)?;
    }

    // Phase 8: route catch-up window through the PS script. None → leave
    // existing Settings untouched; Some(true|false) → rebuild Settings.
    let catch_up_str: &str = match catch_up {
        Some(true) => "true",
        Some(false) => "false",
        None => "",
    };

    let mut args: Vec<&str> = vec![
        "-Action",
        "edit",
        "-Name",
        &name,
        "-NewTriggerType",
        &new_trigger_type,
    ];
    if !at_value.is_empty() {
        args.push("-NewTriggerAt");
        args.push(&at_value);
    }
    if !catch_up_str.is_empty() {
        args.push("-CatchUp");
        args.push(catch_up_str);
    }
    let (stdout, stderr, code, ok) = run_ps(app, &args).await?;
    if !ok {
        return Err(format!(
            "system_tasks.ps1 edit failed (exit {:?}): {}",
            code, stderr
        ));
    }
    let parsed: EditPsResult = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("parse edit json: {} (output: {})", e, stdout.trim()))?;
    Ok(EditTaskResult {
        success: parsed.ok,
        name: parsed.name.unwrap_or(name),
        trigger_type: parsed.trigger_type.unwrap_or(new_trigger_type),
        trigger_at: parsed.trigger_at.unwrap_or(at_value),
        error: parsed.error.unwrap_or_default(),
        catch_up: parsed.catch_up,
    })
}

pub async fn delete_task_inner(
    app: &tauri::AppHandle,
    name: String,
) -> Result<DeleteTaskResult, String> {
    validate_task_name(&name)?;
    let (stdout, stderr, code, ok) =
        run_ps(app, &["-Action", "delete", "-Name", &name]).await?;
    if !ok {
        return Err(format!(
            "system_tasks.ps1 delete failed (exit {:?}): {}",
            code, stderr
        ));
    }
    let parsed: DeletePsResult = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("parse delete json: {} (output: {})", e, stdout.trim()))?;
    Ok(DeleteTaskResult {
        success: parsed.ok,
        name: parsed.name.unwrap_or(name),
        error: parsed.error.unwrap_or_default(),
    })
}
