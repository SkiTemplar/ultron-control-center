// batches_queue/types.rs — domain types for the persistent batches queue

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/// Why a batch entry is sitting in the queue instead of having run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchQueueReason {
    /// A sandbox / permission prompt denied the command (human said no, or
    /// the deny-list blocked it). The script is preserved for a manual run.
    Rejected,
    /// The AI session itself could not execute the command (no tool, sandbox
    /// limitation, interactive prompt the agent cannot answer, etc.).
    AiCannotExecute,
    /// The script ran but exited non-zero (or the spawn itself errored).
    Failed,
}

impl BatchQueueReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            BatchQueueReason::Rejected => "rejected",
            BatchQueueReason::AiCannotExecute => "ai_cannot_execute",
            BatchQueueReason::Failed => "failed",
        }
    }

    /// Parse a free-form reason string (from the UI / hook). Unknown values
    /// fall back to `Failed` rather than erroring — the queue must never reject
    /// a legitimate "this didn't run" signal on a typo.
    pub fn parse_lenient(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "rejected" | "denied" | "permission-denied" | "permission_denied" => {
                BatchQueueReason::Rejected
            }
            "ai_cannot_execute" | "ai-cannot-execute" | "ai_cannot" | "cannot_execute" => {
                BatchQueueReason::AiCannotExecute
            }
            _ => BatchQueueReason::Failed,
        }
    }
}

/// Whether a queue entry is automatically runnable by clicking "Run" or
/// requires a human to perform an out-of-band action first.
///
/// `"auto"` — standard script that the user can execute with one click.
/// `"manual"` — the AI left this as a reminder of an action it CANNOT perform
///              (e.g. rebuild, token rotation, GUI login). The Run Batch UI
///              renders these with a distinct badge and no "Run" button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BatchKind {
    #[default]
    Auto,
    Manual,
}

impl BatchKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            BatchKind::Auto => "auto",
            BatchKind::Manual => "manual",
        }
    }

    pub fn parse_lenient(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "manual" | "human" | "requires_human" | "requires-human" => BatchKind::Manual,
            _ => BatchKind::Auto,
        }
    }
}

/// One queued batch. Serialised one-per-line into `queue.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchQueueEntry {
    /// `bq-<microtime>-<counter>` — stable identity for requeue/dismiss.
    pub id: String,
    /// Bare filename of the script in `~/.ultron/batches/` (no path separators).
    /// For `kind = manual` entries this may be empty — there is no script to run.
    pub name: String,
    /// Absolute path to the script on disk (best-effort; may not exist yet).
    pub path: String,
    pub reason: BatchQueueReason,
    /// Whether this entry can be executed with the Run button (`auto`) or
    /// requires a human out-of-band action (`manual`).
    #[serde(default)]
    pub kind: BatchKind,
    /// Human-readable description of the action needed. Especially useful for
    /// `manual` entries where there is no script body to inspect.
    #[serde(default)]
    pub description: Option<String>,
    /// "epoch:<secs>" — when this entry was first enqueued.
    pub created_at: String,
    /// Last error / stderr captured for this entry (truncated). `None` when the
    /// reason carries no error text (e.g. a plain rejection).
    #[serde(default)]
    pub last_error: Option<String>,
    /// How many times a run of this entry has failed / been re-queued.
    #[serde(default)]
    pub attempts: u32,
}
