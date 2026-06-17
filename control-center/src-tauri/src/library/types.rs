//! Public types shared across all library sub-modules.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteItem {
    pub owner: String,
    pub repo: String,
    pub path: String,
    pub name: String,
    pub html_url: Option<String>,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LibraryKind {
    Agent,
    Skill,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TargetScope {
    Global,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PinnedAgents {
    pub pinned: Vec<String>,
}

// ---------------------------------------------------------------------------
// In-app create specs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct AgentCreateSpec {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub tools: Vec<String>,
    pub model: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SkillCreateSpec {
    pub name: String,
    pub description: String,
    pub body: String,
}

// ---------------------------------------------------------------------------
// AI-driven install types
// ---------------------------------------------------------------------------

/// One shell step returned by the AI analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallStep {
    pub cmd: String,
    /// Working directory — may use `~` which the executor expands.
    pub cwd: String,
}

/// One file copy returned by the AI analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopyFile {
    /// Path relative to the cloned temp directory.
    pub from: String,
    /// Absolute target path (may use `~` which the executor expands).
    pub to: String,
}

/// Structured report that the AI must produce (strict JSON).
/// Unknown fields are ignored (`deny_unknown_fields` is deliberately absent
/// so future AI models can add extra fields without breaking the parser).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallReport {
    pub compatible: bool,
    /// Human-readable rationale for the compatibility decision.
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub steps: Vec<InstallStep>,
    #[serde(default)]
    pub copy_files: Vec<CopyFile>,
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Detected install type: "agent", "skill", "rules", "mcp", "npm",
    /// "cargo", "python", "unknown".
    #[serde(default = "default_install_type")]
    pub install_type: String,
}

fn default_install_type() -> String {
    "unknown".to_string()
}

/// Final result returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiInstallResult {
    /// Whether the AI router was reachable and produced a report.
    pub ai_available: bool,
    /// The AI-generated report (None when ai_available=false).
    pub report: Option<InstallReport>,
    /// Whether we actually executed the install (false when dry_run=true
    /// or compatible=false).
    pub executed: bool,
    /// Paths of files that were copied during the install.
    #[serde(default)]
    pub installed_paths: Vec<String>,
    /// Combined warnings + execution errors surfaced to the UI.
    #[serde(default)]
    pub errors: Vec<String>,
}
