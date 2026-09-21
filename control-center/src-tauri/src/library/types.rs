//! Public types shared across all library sub-modules.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

// `RemoteItem` (owner/repo/path/name/html_url/preview) se retiro el 2026-09-22
// junto con `search.rs`: era el tipo de salida de `gh search code` y no queda
// ningun productor en Rust. El tipo equivalente del frontend sigue vivo porque
// es la forma que rellena el modal de instalacion a mano.

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
