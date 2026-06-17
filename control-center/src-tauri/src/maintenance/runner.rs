// Execution layer: spawn a maintenance command and capture its output.
// `run_maintenance_inner` dispatches through `build_cmd`.
// `run_backup_now_inner` is a dedicated "force backup" entry point that
// re-reads the configured destination from disk on every invocation.

use std::process::Command;

use serde::Serialize;

use super::commands::{backup_script, build_cmd};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Serialize)]
pub struct MaintenanceResult {
    pub kind: String,
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u128,
}

/// v2.5: dedicated "run backup now" entry point. Re-uses the same script the
/// Task Scheduler job runs (~/.ultron/scripts/backup/weekly-backup.ps1). We
/// surface this as its own command so the Dashboard BackupCard can call it
/// without piggy-backing on the generic `weekly-backup` maintenance kind —
/// the latter goes through the audit/timeline path and isn't intended for
/// the "I just want to restart the backup" use case.
///
/// v2.7 fix: previously this just spawned the script with the inherited
/// env. The Tauri command `set_backup_root` mirrors the chosen path into
/// `std::env::set_var("ULTRON_BACKUP_ROOT", …)`, but that only sticks for
/// the lifetime of the running Control Center process. If the user
/// restarts the app and then presses "Force backup now" without
/// re-picking the destination, the script wouldn't see any override and
/// would silently fall back to `%USERPROFILE%\BACKUP`, leaving the
/// configured drive empty and the "last backup" badge stuck on the old C:
/// mirror.
///
/// The script itself now reads `~/.ultron/.tmp/backup-root.txt` (matching
/// `backup_status.rs::backup_root()`), and we additionally inject both
/// `ULTRON_BACKUP_ROOT` + `ULTRON_BACKUP_SOURCES` here so the child
/// PowerShell never has to depend on inherited in-process state.
pub fn run_backup_now_inner() -> Result<MaintenanceResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let script = backup_script(&home);
    if !script.is_file() {
        return Err(format!("backup script missing: {}", script.display()));
    }
    let start = std::time::Instant::now();
    #[cfg(target_os = "windows")]
    let (cmd, args): (String, Vec<String>) = (
        "powershell.exe".into(),
        vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            script.to_string_lossy().into_owned(),
        ],
    );
    #[cfg(not(target_os = "windows"))]
    let (cmd, args): (String, Vec<String>) =
        ("bash".into(), vec![script.to_string_lossy().into_owned()]);
    let mut command = Command::new(&cmd);
    command.args(&args).current_dir(home.join(".ultron"));

    // v2.7: explicitly inject the configured destination + sources into
    // the child process. We re-read from disk every invocation so a fresh
    // Control Center process (where `std::env::set_var` from a previous
    // session is gone) still sees the user's preferences.
    let root_cfg = home.join(".ultron").join(".tmp").join("backup-root.txt");
    if let Ok(raw) = std::fs::read_to_string(&root_cfg) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            command.env("ULTRON_BACKUP_ROOT", trimmed);
        }
    }
    let sources_cfg = home
        .join(".ultron")
        .join("cockpit")
        .join("backup-config.json");
    if let Ok(raw) = std::fs::read_to_string(&sources_cfg) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(arr) = val.get("sources").and_then(|v| v.as_array()) {
                let joined: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();
                if !joined.is_empty() {
                    command.env("ULTRON_BACKUP_SOURCES", joined.join(","));
                }
            }
        }
    }

    #[cfg(windows)]
    {
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = command
        .output()
        .map_err(|e| format!("spawn {}: {}", cmd, e))?;
    Ok(MaintenanceResult {
        kind: "run-backup-now".into(),
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        elapsed_ms: start.elapsed().as_millis(),
    })
}

pub fn run_maintenance_inner(kind: String) -> Result<MaintenanceResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let (cmd, args) = build_cmd(&kind, &home)?;
    let start = std::time::Instant::now();
    let mut command = Command::new(&cmd);
    command.args(&args).current_dir(home.join(".ultron"));
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = command
        .output()
        .map_err(|e| format!("spawn {}: {}", cmd, e))?;
    Ok(MaintenanceResult {
        kind,
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        elapsed_ms: start.elapsed().as_millis(),
    })
}
