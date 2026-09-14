// Agent CRUD + security findings commands.
use crate::agent_orchestration;
use crate::agents;
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
