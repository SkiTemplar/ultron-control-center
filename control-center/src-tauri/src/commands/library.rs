//! P5 — Agent/Skill library Tauri command wrappers.

use crate::library;

#[tauri::command]
pub async fn library_search_github(
    query: String,
    kind: library::LibraryKind,
    limit: Option<u32>,
) -> Result<Vec<library::RemoteItem>, String> {
    let lim = limit.unwrap_or(30);
    library::search_github_inner(query, kind, lim).await
}

#[derive(serde::Deserialize)]
pub struct InstallArgs {
    pub owner: String,
    pub repo: String,
    pub path: String,
    pub kind: library::LibraryKind,
    pub target_scope: library::TargetScope,
    pub target_project_id: Option<String>,
    pub target_name: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[tauri::command]
pub async fn library_install_from_github(args: InstallArgs) -> Result<String, String> {
    let p = library::install_from_github_inner(
        args.owner,
        args.repo,
        args.path,
        args.kind,
        args.target_scope,
        args.target_project_id,
        args.target_name,
        args.overwrite,
    )
    .await?;
    Ok(p.display().to_string())
}

#[derive(serde::Deserialize)]
pub struct AgentCreateArgs {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub tools: Vec<String>,
    pub model: Option<String>,
    pub body: String,
    pub target_scope: library::TargetScope,
    pub target_project_id: Option<String>,
}

#[tauri::command]
pub fn agent_create(args: AgentCreateArgs) -> Result<String, String> {
    let spec = library::AgentCreateSpec {
        name: args.name,
        description: args.description,
        tools: args.tools,
        model: args.model,
        body: args.body,
    };
    let p = library::agent_create_inner(spec, args.target_scope, args.target_project_id)?;
    Ok(p.display().to_string())
}

#[derive(serde::Deserialize)]
pub struct SkillCreateArgs {
    pub name: String,
    pub description: String,
    pub body: String,
    pub target_scope: library::TargetScope,
    pub target_project_id: Option<String>,
}

#[tauri::command]
pub fn skill_create(args: SkillCreateArgs) -> Result<String, String> {
    let spec = library::SkillCreateSpec {
        name: args.name,
        description: args.description,
        body: args.body,
    };
    let p = library::skill_create_inner(spec, args.target_scope, args.target_project_id)?;
    Ok(p.display().to_string())
}

#[tauri::command]
pub fn library_pin_agent(
    project_id: String,
    agent_slug: String,
) -> Result<library::PinnedAgents, String> {
    library::pin_agent_inner(&project_id, &agent_slug)
}

#[tauri::command]
pub fn library_unpin_agent(
    project_id: String,
    agent_slug: String,
) -> Result<library::PinnedAgents, String> {
    library::unpin_agent_inner(&project_id, &agent_slug)
}

#[tauri::command]
pub fn library_list_pinned(project_id: String) -> Result<library::PinnedAgents, String> {
    library::pinned_load(&project_id)
}
