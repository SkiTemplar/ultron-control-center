// project_agents/mod.rs — Per-project agent orchestration.
//
// Two operations:
//
//   1. `propose_roster_inner` — reads the project's manifest files (CLAUDE.md,
//      package.json, Cargo.toml, pyproject.toml), detects the stack, lists the
//      available agents on disk, and asks the AI Router (zone "utility") to
//      produce a recommended roster + gap list.  The result is NOT persisted
//      automatically; the frontend shows a confirmation modal first.
//
//   2. `invoke_from_session_inner` — finds the most recent running PTY for the
//      given project_id, then writes a sub-agent delegation line into it.
//      Claude Code (running inside that PTY) picks up the text, spawns the
//      named sub-agent, and streams the output back through the same terminal.
//
// Roster persistence lives at:
//   ~/.ultron/cockpit/projects/<project_id>/agent-roster.json
//
// The JSON shape is `AgentRosterFile { entries: Vec<RosterEntry> }`, the same
// struct returned by `propose_roster_inner` after the user confirms so the UI
// and the persistence layer share one type.

mod agent_roster;
mod invoke;
mod persistence;
mod skill_roster;
mod stack_detect;
pub(crate) mod types;

// Public API re-exports — callers (commands/projects/agents.rs) import from here.
pub use agent_roster::propose_roster_inner;
pub use invoke::invoke_from_session_inner;
pub use persistence::{roster_load, roster_save};
pub use skill_roster::propose_skill_roster_inner;
pub use types::{
    AgentRosterFile, AgentRosterProposal, InvokeResult, RosterEntry, SkillRosterProposal,
};
