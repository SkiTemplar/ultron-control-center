// agent_orchestration/types.rs — shared data structures.

use serde::Serialize;

// `DelegateTaskResult` and `DelegateRequest` (fire-and-forget task delegation
// payloads) were retired alongside `agent_orchestration::delegate` (2026-09-14,
// kanban "comandos huérfanos" — zero frontend callers). Recoverable from git
// history if the feature gets wired to a UI later.

#[derive(Debug, Serialize)]
pub struct WorkflowStep {
    pub agent: String,
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WorkflowDefinition {
    pub id: String,
    pub label: String,
    pub description: String,
    pub steps: Vec<WorkflowStep>,
}
