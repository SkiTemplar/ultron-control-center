// orchestrator/mod.rs — Orchestrator "Ultron" (Auto-routing #7)
//
// Maps a (possibly vague) prompt to an ORCHESTRATION CONTEXT:
//   prompt -> intent -> workflow -> delegate agents -> memories -> constraints.
//
// Intent classification is RULES-based on purpose: the master prompt says "no
// usar modelo grande para lo que resuelven reglas/triggers/metadata". The LLM
// (AI Routing #8) is reserved for the ambiguous tail later.
//
// Reuses, does NOT duplicate: agent catalog (memory::catalog), recall
// (commands::memory::recall_unified::build_trace), and the 7 built-in workflows
// (agent_orchestration::list_workflows_inner). The orchestrator NEVER writes
// persistent memory (only the Memory Agent does) and DELEGATES to the real
// agents in ~/.claude/agents (ghost agents are sanitized out).

pub(crate) mod orchestrate;
pub(crate) mod ranking;
pub(crate) mod rules;
#[cfg(test)]
mod tests;
pub(crate) mod types_model;

pub use orchestrate::orchestrate;
pub use ranking::build_prompt_plan;
pub use rules::{classify_intent, detect_cross_project};
pub use types_model::{AgentChoice, OrchestrationContext, PromptPlan, SkillChoice, WorkflowChoice};

/// Tauri command: run the orchestrator for a prompt (the "Ultron" trigger).
#[tauri::command]
pub async fn orchestrate_prompt(
    prompt: String,
    project_id: Option<String>,
) -> Result<OrchestrationContext, String> {
    // Manual on-demand invocation (UI badge): full semantic catalog (E5) + hybrid
    // recall (dense=true). The automatic per-prompt hot path (hook -> daemon/CLI)
    // uses dense=false to stay E5-free and under the <300ms budget.
    tauri::async_runtime::spawn_blocking(move || {
        Ok(orchestrate(&prompt, project_id.as_deref(), true))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}
