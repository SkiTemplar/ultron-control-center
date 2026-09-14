// agent_orchestration/types.rs — shared data structures.

use serde::{Deserialize, Serialize};

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

// ---------------------------------------------------------------------------
// Delegation log entry — append-only JSONL record
// Powers the Agents > Runs view (status badges + recent delegations list).
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DelegationLogEntry {
    pub id: String,
    pub agent: String,
    pub task_preview: String,
    pub cwd: Option<String>,
    /// Whether the caller requested a cheap model. Note: this field reflects
    /// the *request*, not the applied provider — in the polling path
    /// (delegate_task_inner) there is no cheap-model channel after Gemini
    /// was retired (2026-06-19).
    #[serde(default, alias = "used_cheap_model")]
    pub cheap_model_requested: bool,
    pub started_at: String,
    /// Lifecycle status. Real values today: "running" (pre-entry appended by
    /// the launch path), "done" and "timeout" (sync path final states),
    /// "failed" (launch error path), and "stale" (read-time resolution in
    /// `list_delegations_inner` for "running" rows orphaned by an app shutdown
    /// — never written to the JSONL). "launched" is legacy from the removed
    /// wt.exe fire-and-forget path and only survives in historical JSONL.
    pub status: String,
    pub session_id: Option<String>,
    /// Mensaje de error cuando `status == "failed"`. Ausente en el JSONL
    /// histórico: `default` mantiene la deserialización compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
