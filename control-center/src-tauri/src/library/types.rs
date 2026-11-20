//! Public types shared across all library sub-modules.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TargetScope {
    Global,
    Project,
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
    /// Tope de turnos del subagente. Se escribe siempre en el frontmatter; si
    /// falta, `DEFAULT_AGENT_MAX_TURNS`. Es un entero con signo para que un
    /// valor negativo llegue a la validación y dé un error explícito.
    #[serde(default, rename = "maxTurns")]
    pub max_turns: Option<i64>,
}

/// `maxTurns` cuando el llamante no lo manda: el tope de un implementador.
pub const DEFAULT_AGENT_MAX_TURNS: i64 = 200;
/// Rango admitido para `maxTurns`.
pub const AGENT_MAX_TURNS_RANGE: std::ops::RangeInclusive<i64> = 1..=500;
/// Modelos admitidos en el frontmatter de un agente: solo IDs exactos de la
/// familia 5.5 (un alias puede resolver a una versión anterior).
pub const AGENT_MODEL_IDS: [&str; 3] = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

#[derive(Debug, Clone, Deserialize)]
pub struct SkillCreateSpec {
    pub name: String,
    pub description: String,
    pub body: String,
}
