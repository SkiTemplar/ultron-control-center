// Agent CRUD + security findings commands.
use crate::agents;

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
