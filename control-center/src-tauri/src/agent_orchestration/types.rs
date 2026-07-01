// agent_orchestration/types.rs — shared data structures.

use serde::{Deserialize, Serialize};

/// Outcome of a fully-resolved `delegate_task_inner` call.
///
/// Unlike `SpawnResult` (which only confirms the process launched), this
/// struct carries the captured PTY output so the orchestrator can use it
/// as input for the next pipeline step.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DelegateTaskResult {
    /// Plain-text output produced by the agent.  ANSI escape codes are
    /// stripped; the string is valid UTF-8 (lossy conversion applied).
    pub output: String,
    /// Exit code reported by the PTY child, or `None` when the session was
    /// killed (timeout / explicit kill).
    pub exit_code: Option<i32>,
    /// Wall-clock duration of the delegation in milliseconds.
    pub duration_ms: u64,
    /// `true` when the agent emitted `[AGENT TASK COMPLETE]` before the
    /// timeout elapsed.  `false` on timeout or forced kill.
    pub completed_normally: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DelegateRequest {
    pub agent: String,
    pub task: String,
    #[serde(default)]
    pub use_cheap_model: bool,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Override the default 300-second poll timeout. `None` or `0` use
    /// `DEFAULT_DELEGATE_TIMEOUT_SECS`. Maximum clamped to 3600 s (1 hour).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Project id forwarded to `pty::spawn_inner` for session registry
    /// grouping. Falls back to `"orchestrator"` when absent.
    #[serde(default)]
    pub project_id: Option<String>,
}

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
    /// "launched" when spawn succeeded, "failed" otherwise. Future: track
    /// "running" / "done" via session_id polling.
    pub status: String,
    pub session_id: Option<String>,
}
