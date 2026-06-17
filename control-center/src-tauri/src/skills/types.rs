// skills/types.rs — Public and internal types for the skills domain.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Registry-driven types (used by list_skills_inner + preview/CRUD)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct SkillInfo {
    pub name: String,
    pub state: String,
    pub source: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub path: Option<String>,
    pub usage_count: u64,
    /// Routing priority for conflict resolution when multiple skills match the
    /// same trigger. Range 1–10; higher value wins. Skills without an explicit
    /// `priority:` frontmatter field default to 5.
    pub priority: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub security: Option<SecurityInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SecurityInfo {
    pub decision: String,
    #[serde(default)]
    pub findings_count: u64,
    #[serde(default)]
    pub high_severity_rules: Vec<String>,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub scanned_at: Option<String>,
}

// registry.json shape (v2): "skills" is a *map* keyed by composite ids like
// "active::academic-deep-research" / "plugin::commit" / "vaulted::xyz". The
// values carry the canonical "name" and "state" fields so we discard the
// map key when flattening to a Vec.
#[derive(Debug, Deserialize)]
pub(crate) struct RegistryRoot {
    #[serde(default)]
    pub skills: BTreeMap<String, RegistrySkill>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RegistrySkill {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub usage_count: u64,
    /// Optional priority field written by skill_vault.py registry or parsed
    /// directly from SKILL.md frontmatter. `None` serialises as absent JSON
    /// key; the consumer treats it as 5 (mid-range default).
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub security: Option<SecurityInfo>,
}

// ---------------------------------------------------------------------------
// CRUD result types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct SkillCreateResult {
    pub success: bool,
    pub name: String,
    pub path: String,
    pub layer: String,
}

#[derive(Debug, Serialize)]
pub struct SkillUpdateResult {
    pub success: bool,
    pub name: String,
    pub path: String,
    pub backup_path: String,
}

#[derive(Debug, Serialize)]
pub struct SkillDeleteResult {
    pub success: bool,
    pub name: String,
    pub from_path: String,
    pub to_path: String,
    pub soft: bool,
}

// ---------------------------------------------------------------------------
// Origin-aware types (Control Center 2.0 / P2)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub enum SkillOrigin {
    #[serde(rename = "global")]
    Global,
    #[serde(rename = "project")]
    Project,
    #[serde(rename = "plugin")]
    Plugin,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SkillEntry {
    pub name: String,
    pub path: String,
    pub description: String,
    pub origin: SkillOrigin,
    pub enabled: bool,
}

// ---------------------------------------------------------------------------
// Bulk toggle types
// ---------------------------------------------------------------------------

/// Per-item outcome of a bulk toggle. `error` is `None` on success.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BulkToggleOutcome {
    pub name: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Aggregate result of `skills_bulk_toggle`. Reports how many slugs flipped
/// successfully plus a per-item breakdown so the UI can surface partial
/// failures (e.g. a skill that was already in the requested state).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BulkToggleResult {
    pub requested: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub outcomes: Vec<BulkToggleOutcome>,
}
