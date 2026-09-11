// project_agents/mod.rs — Per-project agent orchestration.
//
// `propose_roster_inner` reads the project's manifest files (CLAUDE.md,
// package.json, Cargo.toml, pyproject.toml), detects the stack, lists the
// available agents on disk, and asks the AI Router (zone "utility") to
// produce a recommended roster + gap list.  The result is NOT persisted
// automatically; the frontend shows a confirmation modal first.
//
// Roster persistence lives at:
//   ~/.ultron/cockpit/projects/<project_id>/agent-roster.json
//
// The JSON shape is `AgentRosterFile { entries: Vec<RosterEntry> }`, the same
// struct returned by `propose_roster_inner` after the user confirms so the UI
// and the persistence layer share one type.

mod agent_roster;
mod persistence;
mod stack_detect;
pub(crate) mod types;

// Public API re-exports — callers (commands/projects/agents.rs) import from here.
pub use agent_roster::propose_roster_inner;
pub use persistence::{roster_load, roster_save};
pub use types::{AgentRosterFile, AgentRosterProposal, RosterEntry};
