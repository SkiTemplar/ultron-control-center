// agent_orchestration/mod.rs — Agent orchestration module.
//
// Surface introduced by the Agents tab redesign ("plantilla de empleados"):
//
//   - `list_delegations` reads the delegation log written by the kanban
//     dispatcher (`kanban_dispatch_card`).
//   - `list_workflows` returns the preconfigured workflow sequences from
//     `~/.claude/skills/ultron/references/skill-alignments.md`. We hard-code
//     the canonical seven so the UI works even when the user has the skill
//     vaulted or modified.
//
// The module is intentionally split by concern — the heavy lifting (spawn,
// hooks listing) lives in `sessions` and `hooks_admin`. We just provide the
// agent-centric framing the new UI needs.
//
// Sub-modules:
//   types            — shared data structures
//   delegation_log   — append-only JSONL delegation log (read side)
//   workflows        — built-in workflow definitions
//
// `delegate` and `provider_router` (fire-and-forget task delegation + multi-IA
// PTY dispatch) were retired here (2026-09-14, kanban "comandos huérfanos"):
// their only caller, the `delegate_task_launch` Tauri command, had zero
// `invoke()` consumers in the frontend. Recoverable from git history if the
// feature gets wired to a UI later.

pub(crate) mod delegation_log;
pub(crate) mod types;
pub(crate) mod usage;
pub(crate) mod workflows;

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Public re-exports — preserve the original flat API of agent_orchestration
// ---------------------------------------------------------------------------

pub use delegation_log::list_delegations_inner;
pub use types::{DelegationLogEntry, WorkflowDefinition, WorkflowStep};
pub use workflows::list_workflows_inner;
