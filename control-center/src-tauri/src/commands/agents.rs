// Agent CRUD + security findings commands.
use crate::agents;

#[tauri::command]
pub async fn list_agents() -> Result<Vec<agents::AgentInfo>, String> {
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
pub async fn get_agent_findings(name: String) -> Result<agents::AgentSecurityReport, String> {
    agents::get_agent_findings_inner(name)
}

#[tauri::command]
pub async fn allow_agent_manually(
    name: String,
    rules: Vec<String>,
    reason: String,
) -> Result<agents::AllowAgentResult, String> {
    agents::allow_agent_manually_inner(name, rules, reason)
}
