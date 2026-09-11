// Agent CRUD + security findings commands.
use crate::agent_orchestration;
use crate::agents;
use crate::project_agents;
// Origin-aware listing for the Control Center 2.0 Agents viewer.
// Walks global, project, and plugin trees and tags each entry with its
// origin.
#[tauri::command]
pub async fn list_agents(project_path: Option<String>) -> Result<Vec<agents::AgentEntry>, String> {
    agents::list_agents_with_origin_inner(project_path)
}

#[tauri::command]
pub async fn update_agent_md(
    name: String,
    content: String,
) -> Result<agents::AgentMutationResult, String> {
    agents::update_agent_md_inner(name, content)
}

#[tauri::command]
pub async fn agent_toggle(name: String, enabled: bool) -> Result<agents::AgentEntry, String> {
    agents::agent_toggle_inner(name, enabled)
}

/// Bulk enable/disable many global agents in one call. `disabled = true`
/// disables each named agent; `false` re-enables. Loops the same per-item
/// toggle the single `agent_toggle` command uses.
#[tauri::command]
pub async fn agents_bulk_toggle(
    names: Vec<String>,
    disabled: bool,
) -> Result<agents::BulkToggleResult, String> {
    agents::agents_bulk_toggle_inner(names, disabled)
}

/// `cwd`: optional exact-match filter applied server-side BEFORE the limit
/// cap, so one project's rows can't be starved by other projects' activity.
#[tauri::command]
pub async fn list_delegations(
    limit: Option<usize>,
    cwd: Option<String>,
) -> Result<Vec<agent_orchestration::DelegationLogEntry>, String> {
    agent_orchestration::list_delegations_inner(limit.unwrap_or(50), cwd.as_deref())
}

/// Delegación fire-and-forget: devuelve el id de log inmediatamente; el
/// estado (running → done/timeout/failed) se sigue vía `list_delegations`.
#[tauri::command]
pub async fn delegate_task_launch(
    app: tauri::AppHandle,
    request: agent_orchestration::DelegateRequest,
) -> Result<String, String> {
    agent_orchestration::delegate_task_launch_inner(&app, request).await
}

// ---------------------------------------------------------------------------
// P0 — AI-assisted roster proposal
// ---------------------------------------------------------------------------

/// Ask the AI Router to propose an optimal agent roster for the project.
///
/// Reads manifest files (CLAUDE.md, package.json, Cargo.toml, …) to detect the
/// stack, lists available agents from ~/.claude/agents/, and calls
/// `ai_router::route("utility", ...)` with a structured prompt.  Returns a
/// `AgentRosterProposal` with `recommended` + `gaps`; the frontend shows a
/// confirmation modal before persisting via `project_roster_save`.
#[tauri::command]
pub async fn project_propose_agent_roster(
    project_id: String,
    project_path: String,
) -> Result<project_agents::AgentRosterProposal, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_agents::propose_roster_inner(&project_id, &project_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Persist a confirmed roster to
/// `~/.ultron/cockpit/projects/<id>/agent-roster.json`.
#[tauri::command]
pub async fn project_roster_save(
    project_id: String,
    entries: Vec<project_agents::RosterEntry>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = project_agents::AgentRosterFile { entries };
        project_agents::roster_save(&project_id, &file)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Load the persisted roster for a project.
#[tauri::command]
pub async fn project_roster_load(
    project_id: String,
) -> Result<project_agents::AgentRosterFile, String> {
    tauri::async_runtime::spawn_blocking(move || project_agents::roster_load(&project_id))
        .await
        .map_err(|e| e.to_string())?
}
