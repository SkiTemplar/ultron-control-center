// hooks_admin/types.rs — Public DTOs for the hooks administration module.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
pub struct Hook {
    pub id: String,
    pub event: String,
    pub matcher: Option<String>,
    pub command: String,
    pub enabled: bool,
    /// Always "user" right now. v15.1.6 only edits the global
    /// `~/.claude/settings.json`; project-level overrides under
    /// `~/.claude/settings.local.json` are out of scope.
    pub source: String,
    /// Human-readable description from the settings.json group entry
    /// (the `description` field on the outer `{ matcher, hooks, description, id }` object).
    /// Used by the UI as the initial display name before AI auto-naming.
    pub description: Option<String>,
    /// Optional flags from the raw entry that we don't otherwise model —
    /// e.g. `asyncRewake`. Surfaced as a JSON blob so the UI can render
    /// them read-only without us having to track every Claude Code flag.
    pub extra: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
pub struct HooksList {
    pub hooks: Vec<Hook>,
    pub settings_path: String,
    pub settings_exists: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct HookMutationResult {
    pub success: bool,
    pub hook: Option<Hook>,
    pub backup_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct HookTestResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub elapsed_ms: u128,
    pub timed_out: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct HookFire {
    pub timestamp: Option<String>,
    pub event: Option<String>,
    pub hook_id: Option<String>,
    pub matcher: Option<String>,
    pub exit_code: Option<i64>,
    pub raw: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
pub struct HookFiresReport {
    pub fires: Vec<HookFire>,
    pub log_path: String,
    pub instrumented: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookLastFired {
    pub id: String,
    pub timestamp: Option<String>,
    pub project: Option<String>,
    pub exit_code: Option<i32>,
}

/// Result type for `analyze_hook_name_inner`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookNameResult {
    pub id: String,
    /// Human-readable kebab-case name (2-4 words), e.g. "format-on-save".
    pub name: String,
    /// How the name was obtained: "ai", "heuristic", or "fallback".
    pub strategy: String,
    /// `true` if this result was served from the on-disk cache.
    pub cached: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HookDescription {
    pub id: String,
    /// Short readable name shown as the card title (e.g. "Sincronizar sesion a Mem0").
    pub title: String,
    /// One-line description of what the hook does. May be empty.
    pub summary: String,
    /// "curated", "header", or "filename" — provenance, for debugging/UI hints.
    pub source: String,
}
