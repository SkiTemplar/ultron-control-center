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
    Ok(crate::ultron_root()?.join("cockpit").join("diagnostics"))
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
    entries.sort_by_key(|b| std::cmp::Reverse(b.file_name()));
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

/// Reads and parses every stored report: on the blocking pool.
#[tauri::command]
pub async fn diagnostic_history_list(limit: Option<usize>) -> Result<Vec<HistoryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || history_list_blocking(limit))
        .await
        .map_err(|e| format!("diagnostic_history_list: la tarea de fondo falló: {e}"))?
}

fn history_list_blocking(limit: Option<usize>) -> Result<Vec<HistoryEntry>, String> {
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
pub async fn diagnostic_history_read(timestamp: String) -> Result<dn::DiagnosticReport, String> {
    let path = history_report_path(&diagnostics_dir()?, &timestamp)?;
    let txt = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&txt).map_err(|e| format!("parse: {e}"))
}

/// Ruta del informe `timestamp` dentro de `dir`. El sello llega de la UI: solo
/// se aceptan `[0-9A-Za-z_-]` (el formato es `2026-10-16T07-42-26Z`), así que
/// `..`, separadores y unidades no pueden sacar la lectura de `dir`.
fn history_report_path(dir: &Path, timestamp: &str) -> Result<PathBuf, String> {
    let valid = !timestamp.is_empty()
        && timestamp.len() <= 64
        && timestamp
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(format!("sello de informe no válido: {timestamp:?}"));
    }
    Ok(dir.join(format!("{timestamp}.json")))
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
pub async fn diagnostic_schedule_get() -> Result<ScheduleConfig, String> {
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
pub async fn diagnostic_schedule_set(
    enabled: bool,
    time_hhmm: String,
) -> Result<ScheduleConfig, String> {
    if !time_hhmm_valid(&time_hhmm) {
        return Err("formato de hora no válido; se espera HH:MM".to_string());
    }
    let cfg = ScheduleConfig {
        enabled,
        time_hhmm: time_hhmm.clone(),
    };
    // La configuración se escribe DESPUÉS de tocar la tarea: si `schtasks`
    // falla, el JSON no puede decir «activado» con la tarea inexistente (ni
    // «desactivado» con la tarea viva).
    if enabled {
        register_task(&time_hhmm)?;
    } else {
        unregister_task()?;
    }
    let p = schedule_config_path()?;
    let body = serde_json::to_vec_pretty(&cfg).map_err(|e| format!("ser: {e}"))?;
    write_atomic(&p, &body)?;
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
            "/create", "/tn", TASK_NAME, "/tr", &tr, "/sc", "daily", "/st", time_hhmm, "/f",
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
    let deleted = std::process::Command::new("schtasks.exe")
        .args(["/delete", "/tn", TASK_NAME, "/f"])
        .status()
        .map_err(|e| format!("schtasks: {e}"))?
        .success();
    if deleted {
        return Ok(());
    }
    // `/delete` falla también cuando la tarea no existe, que para «desactivar»
    // es éxito. Se distingue con `/query` (su código no depende del idioma).
    let still_exists = std::process::Command::new("schtasks.exe")
        .args(["/query", "/tn", TASK_NAME])
        .output()
        .map_err(|e| format!("schtasks: {e}"))?
        .status
        .success();
    unregister_outcome(deleted, still_exists)
}

/// Resultado de desprogramar: éxito si se borró o si la tarea ya no existe;
/// error si `/delete` falló y la tarea sigue ahí (p. ej., acceso denegado).
fn unregister_outcome(deleted: bool, still_exists: bool) -> Result<(), String> {
    if deleted || !still_exists {
        Ok(())
    } else {
        Err(format!(
            "no se pudo borrar la tarea programada {TASK_NAME}; sigue registrada"
        ))
    }
}

#[cfg(not(target_os = "windows"))]
fn register_task(_time_hhmm: &str) -> Result<(), String> {
    Err("scheduling only supported on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
fn unregister_task() -> Result<(), String> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Per-error-id diagnostic checks (FIX 3)
//
// The frontend `Diagnostics.tsx` calls `invoke("diagnostics_run", { errorId })`
// for each entry in `COMMON_ERRORS`. Previously this command did not exist,
// causing every Diagnose button to fall into the catch-block and render "fail".
// Now each known `checkId` runs a real, minimal check. Unknown IDs return
// `{ ok: false, status: "unknown", detail: "no check registered for …" }`.
// ---------------------------------------------------------------------------

/// Result returned to the frontend for a single diagnostic check.
#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticCheckResult {
    /// `"ok"`, `"fail"`, `"warn"`, or `"unknown"` (no check registered /
    /// check not applicable on this platform).
    pub status: String,
    /// Human-readable detail shown under the check title.
    pub details: String,
    /// Optional fix suggestion surfaced in the UI.
    pub suggested_fix: Option<String>,
}

/// Run the check registered for `error_id` and return the result.
///
/// Every path MUST return — never panic, never return `Err`. Returning
/// `Err` from a Tauri command causes the frontend catch-block to fire,
/// which would again paint the card red. So we always return a result and
/// embed any error in `result.details`.
///
/// The checks block (TCP connect with a 3 s cap, `git status`, a walk over
/// `~/.ultron`), so they run on the blocking pool, never on the main thread.
/// One function per check lives in `diagnostic_checks.rs`.
#[tauri::command]
pub async fn diagnostics_run(error_id: String) -> DiagnosticCheckResult {
    tauri::async_runtime::spawn_blocking(move || super::diagnostic_checks::run_check(&error_id))
        .await
        .unwrap_or_else(|e| DiagnosticCheckResult {
            status: "unknown".into(),
            details: format!("La comprobación no terminó: {e}"),
            suggested_fix: None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_sello_de_un_informe_real_es_valido() {
        let dir = Path::new("diag");
        let p = history_report_path(dir, "2026-10-16T07-42-26Z").unwrap();
        assert_eq!(p, dir.join("2026-10-16T07-42-26Z.json"));
    }

    #[test]
    fn un_sello_con_recorrido_de_ruta_se_rechaza() {
        let dir = Path::new("diag");
        for malo in [
            "",
            "..",
            "../../secreto",
            r"..\..\x",
            r"C:\Windows\win",
            "/etc/passwd",
            "a.b",
            "a b",
        ] {
            assert!(history_report_path(dir, malo).is_err(), "{malo:?} pasó");
        }
    }

    #[test]
    fn desprogramar_solo_es_exito_si_la_tarea_ya_no_esta() {
        assert!(unregister_outcome(true, true).is_ok());
        assert!(
            unregister_outcome(false, false).is_ok(),
            "no existía: éxito"
        );
        assert!(
            unregister_outcome(false, true).is_err(),
            "falló el borrado y sigue registrada"
        );
    }
}
