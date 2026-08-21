// Agent CRUD + security findings commands.
use crate::agent_orchestration;
use crate::agents;
use crate::hooks_admin;
use crate::project_agents;
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
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("read pinned: {e}"))?;
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
// Three commands were written for that surface:
//   * `delegate_task_to_agent` — spawn a Claude session pre-bound to a
//     subagent slug and wait for completion.
//   * `list_agent_workflows`   — return the canonical seven alignments.
//   * `list_active_hooks`      — proxy over hooks_admin so the Automations
//     sub-tab can render the global + plugin hook surface.
//
// NOTE (2026-08-18): none of the three is registered in `generate_handler` —
// they have no frontend consumer today. The live delegation surface is the
// A2 roster section, which uses `delegate_task_launch` + `list_delegations`.
// Register these here AND in handlers.rs if a UI ever adopts them.

/// Delegate a task to an agent and **wait for completion** (synchronous hand-off).
///
/// Spawns a PTY session, polls the output buffer every 2 s for the
/// `[AGENT TASK COMPLETE]` sentinel, and returns `DelegateTaskResult`
/// with the full captured output when the sentinel is found.
///
/// On timeout (default 300 s, configurable via `request.timeout_secs`)
/// the PTY is killed and an `Err("timeout — partial output: …")` is
/// returned so the orchestrator can escalate to `debugger`.
#[tauri::command]
pub async fn delegate_task_to_agent(
    app: tauri::AppHandle,
    request: agent_orchestration::DelegateRequest,
) -> Result<agent_orchestration::DelegateTaskResult, String> {
    agent_orchestration::delegate_task_inner(&app, request).await
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

#[tauri::command]
pub async fn list_agent_workflows() -> Result<Vec<agent_orchestration::WorkflowDefinition>, String>
{
    Ok(agent_orchestration::list_workflows_inner())
}

#[tauri::command]
pub async fn list_active_hooks() -> Result<hooks_admin::HooksList, String> {
    hooks_admin::list_hooks_inner()
}

// ---------------------------------------------------------------------------
// P0 — AI-assisted roster proposal + invoke-from-session
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

/// Ask the AI Router to propose relevant skills for the project.
///
/// Reads manifest files to detect the stack, loads active skills from the
/// registry (name + description), and calls `ai_router::route("utility", ...)`
/// with a catalogue prompt.  Returns a `SkillRosterProposal` with `recommended`
/// entries; the frontend shows a confirmation modal before activating anything.
///
/// Falls back to deterministic keyword matching when the AI Router is
/// unavailable.
#[tauri::command]
pub async fn project_propose_skill_roster(
    project_path: String,
) -> Result<project_agents::SkillRosterProposal, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_agents::propose_skill_roster_inner(&project_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a sub-agent delegation line into the most-recent running PTY for
/// `project_id`.  Returns `InvokeResult { pty_id, sent }`.
///
/// Session selection: picks the `Running` PTY with the latest `started_at`.
/// If no running session exists, returns an error the UI displays with a
/// "Open Terminal" CTA.
#[tauri::command]
pub async fn project_invoke_agent_from_session(
    project_id: String,
    agent_name: String,
    task_prompt: String,
) -> Result<project_agents::InvokeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_agents::invoke_from_session_inner(&project_id, &agent_name, &task_prompt)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agents_pinned_save(project_id: String, pinned: PinnedAgents) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = pinned_path(&project_id)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
        }
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(&pinned).map_err(|e| format!("serialize: {e}"))?;
        std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}
