// Miscellaneous commands that don't fit into any of the other domain groups.
// Path helpers exposed to the frontend, instruction folders, usage report,
// and activity timeline.

use crate::{activity_timeline, instructions, plan_limits, usage};

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
pub async fn instruction_path(kind: String) -> Result<String, String> {
    instructions::instruction_path_inner(kind)
}

#[tauri::command]
pub async fn claude_usage() -> Result<usage::UsageReport, String> {
    usage::claude_usage_inner()
}

/// Plan quota (5h window + weekly) straight from Anthropic, so the Usage tab
/// shows what `/usage` shows without opening a terminal. Blocking HTTP, hence
/// `spawn_blocking`: the async runtime must not stall on the round-trip.
#[tauri::command]
pub async fn claude_plan_limits(force: Option<bool>) -> Result<plan_limits::PlanLimits, String> {
    tauri::async_runtime::spawn_blocking(move || {
        plan_limits::plan_limits_inner(force.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn compute_activity_timeline(
    days: u32,
) -> Result<activity_timeline::TimelineSummary, String> {
    activity_timeline::compute_activity_timeline_inner(days)
}
