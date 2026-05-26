// Agent CRUD + security findings commands.
use crate::agent_orchestration;
use crate::agents;
use crate::hooks_admin;
use crate::sessions::SpawnResult;

// Origin-aware listing for the Control Center 2.0 Agents viewer.
// Walks global, project, and plugin trees and tags each entry with its
// origin. The legacy `AgentInfo` registry-style path is preserved as
// `list_agents_legacy` for components still using that richer shape.
#[tauri::command]
pub async fn list_agents(project_path: Option<String>) -> Result<Vec<agents::AgentEntry>, String> {
    agents::list_agents_with_origin_inner(project_path)
}

#[tauri::command]
pub async fn list_agents_legacy() -> Result<Vec<agents::AgentInfo>, String> {
    agents::list_agents_inner()
}

#[tauri::command]
pub async fn read_agent_md(name: String) -> Result<String, String> {
    agents::read_agent_md_inner(&name)
}

#[tauri::command]
pub async fn create_agent(
    name: String,
    description: String,
    body: String,
    model: Option<String>,
    tools: Vec<String>,
) -> Result<agents::AgentMutationResult, String> {
    agents::create_agent_inner(name, description, body, model, tools)
}

#[tauri::command]
pub async fn update_agent_md(
    name: String,
    content: String,
) -> Result<agents::AgentMutationResult, String> {
    agents::update_agent_md_inner(name, content)
}

#[tauri::command]
pub async fn delete_agent(name: String) -> Result<agents::AgentMutationResult, String> {
    agents::delete_agent_inner(name)
}

#[tauri::command]
pub async fn agent_toggle(
    name: String,
    enabled: bool,
) -> Result<agents::AgentEntry, String> {
    agents::agent_toggle_inner(name, enabled)
}

#[tauri::command]
pub async fn list_delegations(
    limit: Option<usize>,
) -> Result<Vec<agent_orchestration::DelegationLogEntry>, String> {
    agent_orchestration::list_delegations_inner(limit.unwrap_or(50))
}

// ---- P4: per-project agent pinning ----
//
// v2.6 (card-v26-fb-023): `roles` map persists a user-supplied label for each
// pinned agent (e.g. "Backend reviewer", "QA"). The field is optional and
// defaults to empty so existing `pinned-agents.json` files without a roles
// section continue to deserialize cleanly.

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct PinnedAgents {
    pub pinned: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub roles: std::collections::HashMap<String, String>,
}

fn pinned_path(project_id: &str) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home
        .join(".ultron")
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("pinned-agents.json"))
}

#[tauri::command]
pub async fn agents_pinned_load(project_id: String) -> Result<PinnedAgents, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = pinned_path(&project_id)?;
        if !path.exists() {
            return Ok(PinnedAgents::default());
        }
        let raw =
            std::fs::read_to_string(&path).map_err(|e| format!("read pinned: {e}"))?;
        let p: PinnedAgents =
            serde_json::from_str(&raw).map_err(|e| format!("parse pinned: {e}"))?;
        Ok::<PinnedAgents, String>(p)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Agents tab redesign — "plantilla de empleados" surface.
// ---------------------------------------------------------------------------
//
// Three commands feed the new UI:
//   * `delegate_task_to_agent` — spawn a Claude session pre-bound to a
//     subagent slug. The frontend "Asignar tarea" modal posts here.
//   * `list_agent_workflows`   — return the canonical seven alignments.
//   * `list_active_hooks`      — proxy over hooks_admin so the Automations
//     sub-tab can render the global + plugin hook surface.

#[tauri::command]
pub async fn delegate_task_to_agent(
    app: tauri::AppHandle,
    request: agent_orchestration::DelegateRequest,
) -> Result<SpawnResult, String> {
    agent_orchestration::delegate_task_inner(&app, request).await
}

#[tauri::command]
pub async fn list_agent_workflows() -> Result<Vec<agent_orchestration::WorkflowDefinition>, String>
{
    Ok(agent_orchestration::list_workflows_inner())
}

#[tauri::command]
pub async fn list_active_hooks() -> Result<hooks_admin::HooksList, String> {
    hooks_admin::list_hooks_inner()
}

#[tauri::command]
pub async fn agents_pinned_save(
    project_id: String,
    pinned: PinnedAgents,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = pinned_path(&project_id)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
        }
        let tmp = path.with_extension("json.tmp");
        let json =
            serde_json::to_string_pretty(&pinned).map_err(|e| format!("serialize: {e}"))?;
        std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}
