// Miscellaneous commands that don't fit into any of the other domain groups.
// Path helpers exposed to the frontend, logs tailing, instruction folders,
// usage report, activity timeline, and the cost watchdog.

use crate::{activity_timeline, cost_watchdog, instructions, logs, usage};

/// Frontend-facing helper: returns the absolute path to the ULTRON root
/// (`~/.ultron`) as a UTF-8 string. The TS helper `getUltronRoot()` in
/// `src/lib/paths.ts` invokes this so the frontend never has to hardcode
/// `C:\Users\<name>\.ultron` to compute child paths.
#[tauri::command]
pub fn ultron_root_str() -> Result<String, String> {
    Ok(crate::ultron_root()?.to_string_lossy().to_string())
}

/// Frontend-facing helper: returns the absolute path to the user's home
/// directory as a UTF-8 string. Used by the TS helper `getHomeDir()` to
/// compute paths like `~/.claude/skills/<name>` without hardcoding the
/// Windows user folder.
#[tauri::command]
pub fn home_dir_str() -> Result<String, String> {
    dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .ok_or_else(|| "No HOME dir".to_string())
}

#[tauri::command]
pub async fn list_logs() -> Result<Vec<logs::LogSource>, String> {
    logs::list_logs_inner()
}

#[tauri::command]
pub async fn tail_log(source_id: String, lines: Option<usize>) -> Result<logs::LogTail, String> {
    logs::tail_log_inner(source_id, lines)
}

#[tauri::command]
pub async fn list_instruction_folders() -> Result<Vec<instructions::InstructionEntry>, String> {
    instructions::list_instruction_folders_inner()
}

#[tauri::command]
pub async fn instruction_path(kind: String) -> Result<String, String> {
    instructions::instruction_path_inner(kind)
}

#[tauri::command]
pub async fn claude_usage() -> Result<usage::UsageReport, String> {
    usage::claude_usage_inner()
}

#[tauri::command]
pub async fn compute_activity_timeline(
    days: u32,
) -> Result<activity_timeline::TimelineSummary, String> {
    activity_timeline::compute_activity_timeline_inner(days)
}

#[tauri::command]
pub async fn compute_cost(
    window_hours: Option<u32>,
) -> Result<cost_watchdog::CostSnapshot, String> {
    cost_watchdog::compute_cost_inner(window_hours.unwrap_or(6))
}

/// Open a folder in Visual Studio Code. The frontend Library uses this
/// instead of `openPath(file.md)` so the user lands on the whole skill /
/// agent / rule folder and can navigate sibling README, examples, etc.
///
/// Windows-specific: `code` ships as `code.cmd` shim — bare
/// `Command::new("code")` does not walk PATHEXT, so we wrap with
/// `cmd.exe /C code <folder>` (same trick as `pty::build_command`). The
/// `CREATE_NO_WINDOW` flag (0x0800_0000) keeps cmd.exe from flashing a
/// console window for the half-second the subprocess lives.
#[tauri::command]
pub async fn open_folder_in_vscode(target: String) -> Result<(), String> {
    // Despite the historical name, accepts either a folder or a file path.
    // VS Code handles both shapes — the frontend Library picks the right
    // one (skill folder so siblings are visible, vs. a standalone agent or
    // rule .md when no folder exists).
    let path = std::path::Path::new(&target);
    if !path.exists() {
        return Err(format!("path not found: {target}"));
    }

    let arg = target.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let mut cmd = std::process::Command::new("cmd.exe");
            cmd.arg("/C").arg("code").arg(&arg);
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            cmd.status()
        }
        #[cfg(not(windows))]
        {
            std::process::Command::new("code").arg(&arg).status()
        }
    })
    .await
    .map_err(|e| format!("spawn join: {e}"))?
    .map_err(|e| format!("spawn code: {e}"))?;

    if !status.success() {
        return Err(format!("code exited with status {status}"));
    }
    Ok(())
}
