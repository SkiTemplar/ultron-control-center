// ULTRON Control Center — Hooks administration module.
//
// Source of truth: ~/.claude/settings.json under the "hooks" key.
//
// Module layout:
//   types.rs        — Public DTOs (Hook, HooksList, HookMutationResult, ...)
//   validation.rs   — Input validation: ALLOWED_EVENTS, validate_command/event/matcher
//   io.rs           — Settings I/O: read, flatten, mutate, discover plugin hooks
//   commands.rs     — Public inner functions called from Tauri command wrappers
//   naming.rs       — Auto-naming: analyze_hook_name, bulk_analyze, cache helpers
//   descriptions.rs — get_hook_descriptions_inner, curated catalog, script header parser

pub(crate) mod commands;
pub(crate) mod descriptions;
pub(crate) mod io;
pub(crate) mod naming;
pub(crate) mod types;
pub(crate) mod validation;

// ---------------------------------------------------------------------------
// Public re-exports — every symbol callers reference as `crate::hooks_admin::*`
// must appear here so external callers (lib.rs) are unchanged.
// ---------------------------------------------------------------------------

pub use commands::{
    add_hook_inner, delete_hook_inner, hooks_last_fired_inner, list_hooks_inner,
    recent_hook_fires_inner, request_hook_via_ai_inner, test_hook_inner, toggle_hook_inner,
    update_hook_inner,
};
pub use descriptions::get_hook_descriptions_inner;
pub use naming::{
    analyze_hook_name_inner, bulk_analyze_hook_names_inner, get_hook_names_cache_inner,
};
pub use types::{
    HookDescription, HookFiresReport, HookLastFired, HookMutationResult, HookNameResult,
    HookTestResult, HooksList,
};
