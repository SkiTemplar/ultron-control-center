// project_agents/types.rs — Public types serialised to/from the frontend via Tauri IPC.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Agent roster types
// ---------------------------------------------------------------------------

/// One agent the AI recommends for the project roster.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosterEntry {
    pub name: String,
    pub reason: String,
    /// Suggested role label (pre-populated in the role badge).
    pub suggested_role: String,
}

/// An agent that does not exist yet but the AI thinks would be valuable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GapEntry {
    pub suggested_name: String,
    pub reason: String,
}

/// Full AI proposal returned to the frontend confirmation modal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRosterProposal {
    pub recommended: Vec<RosterEntry>,
    pub gaps: Vec<GapEntry>,
    /// Stack tokens detected from the manifest files (displayed in the modal).
    pub detected_stack: Vec<String>,
}

/// Persisted roster file at
/// `~/.ultron/cockpit/projects/<id>/agent-roster.json`.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct AgentRosterFile {
    pub entries: Vec<RosterEntry>,
}
