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
