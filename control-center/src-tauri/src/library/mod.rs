//! Control Center 2.0 — Agent + Skill library (P5).
//!
//! - In-app creation: build frontmatter from struct + write atomically.
//!
//! La instalación desde GitHub (`install_gh` + `gh_helpers`) se retiró el
//! 2026-10-17: no tenía entrada en la UI.

pub(crate) mod create;
pub(crate) mod helpers;
pub(crate) mod types;

// ai_install (AI-driven install via ai_router) se elimino entero 2026-09-23:
// su unico comando Tauri, library_install_via_ai, nunca tuvo llamador en la
// UI. pick_analysis_zone() era el unico llamante real de las zonas
// code-edit/code-review del AI Router; las zonas se podaron del seed y del
// zones.json el 2026-10-23 (ai_router::store::zone_migrations).

pub use create::{agent_create_inner, skill_create_inner};
pub use types::{AgentCreateSpec, SkillCreateSpec, TargetScope};
