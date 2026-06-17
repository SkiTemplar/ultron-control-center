// recall_unified/session_budget.rs — per-session token budget tracking.
//
// SESSION BUDGET (Pilar 1 · Kirkardo gap):
//   `TOKEN_BUDGET` is the PER-SESSION total, not a per-call constant.  A
//   global `SESSION_BUDGET_STORE` (Mutex<HashMap>) tracks tokens already
//   injected for each session_id within the process lifetime.  Each call to
//   `build_trace` / `recall_pack` deducts the tokens consumed from the
//   remaining budget, so that a session making multiple recalls cannot exceed
//   TOKEN_BUDGET in aggregate.
//
//   Session-id source (priority order):
//     1. Caller-supplied `session_id` (e.g. from the Claude session hook).
//     2. `ULTRON_SESSION_ID` environment variable (set by the CLI launcher).
//     3. `CLAUDE_SESSION_ID` environment variable (set by the Claude Code CLI
//        host).  Honoured so the budget is tracked per logical Claude session,
//        not per OS process, when Claude spawns multiple short-lived
//        sub-processes within a single session (Kirkardo gap #6).
//     4. Synthetic `"proc-<pid>"` — stable within a process lifetime, which
//        maps to a single Control-Center window session.
//
//   The budget resets only when the process restarts (i.e. new CC window).
//   Entries are never evicted from the store; the HashMap stays small because
//   one process = one window = typically one or two active session ids.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use super::types_model::TOKEN_BUDGET;

/// Global in-process store: session_id → tokens already consumed this session.
///
/// `OnceLock` + `Mutex<HashMap>` — no extra dependencies, zero unsafe code.
static SESSION_BUDGET_STORE: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();

fn session_budget_store() -> &'static Mutex<HashMap<String, i64>> {
    SESSION_BUDGET_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve the canonical session id for a call.
///
/// Priority order (Kirkardo gap #6):
///   1. Caller-supplied `session_id` — explicit override, highest priority.
///   2. `ULTRON_SESSION_ID` — set by the ULTRON CLI launcher for every
///      Control-Center window session.
///   3. `CLAUDE_SESSION_ID` — set by the Claude Code CLI host when it
///      launches a session.  Prioritising the real Claude session id over the
///      synthetic proc-<pid> fallback ensures that the per-session token
///      budget is tracked per *logical* Claude session, not per OS process,
///      which is especially important when the Claude CLI spawns multiple
///      short-lived sub-processes within a single session.
///   4. `"proc-<pid>"` — stable within a process lifetime.  Maps to one
///      Control-Center window session.  Used only when neither of the real
///      session ids is available.
///
/// The budget resets only when `session_budget_reset` is explicitly called
/// (e.g. by the `SessionStart` hook) or when the process restarts.
/// Entries are never evicted from the store; the `HashMap` stays small
/// because one process = one window = typically one or two active session ids.
pub fn resolve_session_id(supplied: Option<&str>) -> String {
    if let Some(s) = supplied {
        if !s.is_empty() {
            return s.to_string();
        }
    }
    if let Ok(env_id) = std::env::var("ULTRON_SESSION_ID") {
        if !env_id.is_empty() {
            return env_id;
        }
    }
    if let Ok(env_id) = std::env::var("CLAUDE_SESSION_ID") {
        if !env_id.is_empty() {
            return env_id;
        }
    }
    format!("proc-{}", std::process::id())
}

/// Returns how many tokens remain in the budget for `session_id`.
///
/// Returns 0 when the budget is already exhausted.
pub fn session_budget_remaining(session_id: &str) -> i64 {
    let store = session_budget_store()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let used = store.get(session_id).copied().unwrap_or(0);
    (TOKEN_BUDGET - used).max(0)
}

/// Deduct `tokens` from the session budget.  Clamps to zero (never goes
/// negative).  Returns the remaining budget after deduction.
pub(super) fn session_budget_deduct(session_id: &str, tokens: i64) -> i64 {
    let mut store = session_budget_store()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let entry = store.entry(session_id.to_string()).or_insert(0);
    *entry += tokens;
    (TOKEN_BUDGET - *entry).max(0)
}

/// Reset the budget for `session_id` to zero (full budget available again).
///
/// Intended for `SessionStart` hooks and tests.
pub fn session_budget_reset(session_id: &str) {
    let mut store = session_budget_store()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    store.remove(session_id);
}
