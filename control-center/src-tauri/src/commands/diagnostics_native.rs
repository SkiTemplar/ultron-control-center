//! Control Center 2.0 — Tauri command wrappers for native diagnostics.
//!
//! Wires `crate::diagnostics_native` to the frontend. Provides:
//!   - `run_diagnostic_native`         — runs all checks + persists JSON
//!   - `analyze_diagnostic_with_ai`    — `claude --print` over the report
//!   - `diagnostic_history_list/read`  — past runs
//!   - `diagnostic_schedule_get/set`   — Windows Task Scheduler integration

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri_plugin_shell::ShellExt;

use crate::diagnostics_native as dn;

const ANALYZE_PROMPT_PREFIX: &str = "You are an expert SRE. Given the following Windows desktop diagnostic JSON, identify the top 3-5 problems and propose concrete fixes (commands or settings). Use concise markdown with H3 headings per issue. Diagnostic JSON:\n\n";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn diagnostics_dir() -> Result<PathBuf, String> {
    Ok(crate::ultron_root()?
        .join("cockpit")
        .join("diagnostics"))
}

fn write_atomic(path: &Path, body: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn run_diagnostic_native() -> Result<dn::DiagnosticReport, String> {
    let report = tauri::async_runtime::spawn_blocking(dn::run_full_diagnostic_native)
        .await
        .map_err(|e| format!("join: {e}"))?;
    persist_report(&report)?;
    Ok(report)
}

fn persist_report(report: &dn::DiagnosticReport) -> Result<(), String> {
    let dir = diagnostics_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let path = dir.join(format!("{}.json", report.timestamp));
    let body = serde_json::to_vec_pretty(report).map_err(|e| format!("ser: {e}"))?;
    write_atomic(&path, &body)?;
    prune_history(&dir, 30).ok();
    Ok(())
}

fn prune_history(dir: &Path, keep: usize) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    entries.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    for stale in entries.into_iter().skip(keep) {
        let _ = std::fs::remove_file(stale.path());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Analyze with AI
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn analyze_diagnostic_with_ai(
    app: tauri::AppHandle,
    report_json: String,
) -> Result<String, String> {
    let prompt = format!("{}{}", ANALYZE_PROMPT_PREFIX, report_json);
    let shell = app.shell();
    let output = shell
        .command("claude")
        .args(["--print", "--", &prompt])
        .output()
        .await
        .map_err(|e| format!("claude spawn: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "claude exited {:?}: {}",
            output.status.code(),
            stderr
        ));
    }
    let md = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(md)
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub timestamp: String,
    pub max_severity: dn::Severity,
    pub path: String,
}

#[tauri::command]
pub fn diagnostic_history_list(limit: Option<usize>) -> Result<Vec<HistoryEntry>, String> {
    let dir = diagnostics_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<HistoryEntry> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read_dir: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .filter_map(|e| {
            let path = e.path();
            let stem = path.file_stem()?.to_string_lossy().to_string();
            let txt = std::fs::read_to_string(&path).ok()?;
            let report: dn::DiagnosticReport = serde_json::from_str(&txt).ok()?;
            Some(HistoryEntry {
                timestamp: stem,
                max_severity: report.max_severity,
                path: path.display().to_string(),
            })
        })
        .collect();
    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    if let Some(n) = limit {
        entries.truncate(n);
    }
    Ok(entries)
}

#[tauri::command]
pub fn diagnostic_history_read(timestamp: String) -> Result<dn::DiagnosticReport, String> {
    let dir = diagnostics_dir()?;
    let path = dir.join(format!("{}.json", timestamp));
    let txt = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&txt).map_err(|e| format!("parse: {e}"))
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleConfig {
    pub enabled: bool,
    pub time_hhmm: String, // "08:30"
}

const TASK_NAME: &str = "ULTRON-Daily-Diagnostic";

fn schedule_config_path() -> Result<PathBuf, String> {
    Ok(crate::ultron_root()?
        .join("cockpit")
        .join("diagnostic-schedule.json"))
}

#[tauri::command]
pub fn diagnostic_schedule_get() -> Result<ScheduleConfig, String> {
    let p = schedule_config_path()?;
    if !p.exists() {
        return Ok(ScheduleConfig {
            enabled: false,
            time_hhmm: "08:30".to_string(),
        });
    }
    let txt = std::fs::read_to_string(&p).map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&txt).map_err(|e| format!("parse: {e}"))
}

#[tauri::command]
pub fn diagnostic_schedule_set(
    enabled: bool,
    time_hhmm: String,
) -> Result<ScheduleConfig, String> {
    if !time_hhmm_valid(&time_hhmm) {
        return Err("invalid time format, expected HH:MM".to_string());
    }
    let cfg = ScheduleConfig {
        enabled,
        time_hhmm: time_hhmm.clone(),
    };
    let p = schedule_config_path()?;
    let body = serde_json::to_vec_pretty(&cfg).map_err(|e| format!("ser: {e}"))?;
    write_atomic(&p, &body)?;

    if enabled {
        register_task(&time_hhmm)?;
    } else {
        unregister_task()?;
    }
    Ok(cfg)
}

fn time_hhmm_valid(s: &str) -> bool {
    let mut parts = s.split(':');
    let (Some(h), Some(m)) = (parts.next(), parts.next()) else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    let Ok(hh) = h.parse::<u32>() else {
        return false;
    };
    let Ok(mm) = m.parse::<u32>() else {
        return false;
    };
    hh < 24 && mm < 60
}

#[cfg(target_os = "windows")]
fn register_task(time_hhmm: &str) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let tr = format!("\"{}\" --run-diagnostic", exe.display());
    let status = std::process::Command::new("schtasks.exe")
        .args([
            "/create",
            "/tn",
            TASK_NAME,
            "/tr",
            &tr,
            "/sc",
            "daily",
            "/st",
            time_hhmm,
            "/f",
        ])
        .status()
        .map_err(|e| format!("schtasks: {e}"))?;
    if !status.success() {
        return Err(format!("schtasks exited {:?}", status.code()));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn unregister_task() -> Result<(), String> {
    let _ = std::process::Command::new("schtasks.exe")
        .args(["/delete", "/tn", TASK_NAME, "/f"])
        .status();
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn register_task(_time_hhmm: &str) -> Result<(), String> {
    Err("scheduling only supported on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
fn unregister_task() -> Result<(), String> {
    Ok(())
}
