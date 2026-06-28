// agent_orchestration/mod.rs — Agent orchestration module.
//
// New surface introduced by the Agents tab redesign ("plantilla de empleados"):
//
//   - `delegate_task_to_agent` spawns a new Claude session with the given
//     agent slug as the subagent directive. Optionally requests a cheaper
//     model when the caller flags the work as low-cost.
//   - `list_workflows` returns the preconfigured workflow sequences from
//     `~/.claude/skills/ultron/references/skill-alignments.md`. We hard-code
//     the canonical seven so the UI works even when the user has the skill
//     vaulted or modified.
//   - `list_active_hooks` is a thin proxy over `hooks_admin::list_hooks_inner`
//     so the Agents > Automations sub-tab can render hooks alongside the
//     workflow + delegate panes without reaching into the Settings tab API.
//
// The module is intentionally split by concern — the heavy lifting (spawn,
// hooks listing) lives in `sessions` and `hooks_admin`. We just provide the
// agent-centric framing the new UI needs.
//
// Sub-modules:
//   provider_router  — multi-IA PTY dispatch (O(1), no network)
//   types            — shared data structures
//   delegation_log   — append-only JSONL delegation log
//   workflows        — built-in workflow definitions
//   delegate         — core delegation logic (sync + fire-and-forget)

pub mod provider_router;

pub(crate) mod delegate;
pub(crate) mod delegation_log;
pub(crate) mod types;
pub(crate) mod usage;
pub(crate) mod workflows;

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Public re-exports — preserve the original flat API of agent_orchestration
// ---------------------------------------------------------------------------

pub use delegate::delegate_task_inner;
pub use delegation_log::list_delegations_inner;
pub use types::{
    DelegateRequest, DelegateTaskResult, DelegationLogEntry, WorkflowDefinition, WorkflowStep,
};
pub use workflows::list_workflows_inner;
