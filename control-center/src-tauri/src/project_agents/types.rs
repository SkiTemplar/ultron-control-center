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

/// Result of writing a sub-agent invocation into an active PTY.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvokeResult {
    /// PTY session id the command was written to.
    pub pty_id: String,
    /// true if the write succeeded.
    pub sent: bool,
}

// ---------------------------------------------------------------------------
// Skill roster types (mirror of agent roster)
// ---------------------------------------------------------------------------

/// One skill the AI recommends activating for the project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRosterEntry {
    pub name: String,
    pub reason: String,
    /// Tags surfaced from the skill's frontmatter (informational for the UI).
    pub tags: Vec<String>,
}

/// Full AI proposal for the project's skill set, returned to the frontend
/// confirmation modal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRosterProposal {
    pub recommended: Vec<SkillRosterEntry>,
    /// Stack tokens used to produce the recommendation.
    pub detected_stack: Vec<String>,
}
