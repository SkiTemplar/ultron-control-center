//! Control Center 2.0 — Agent + Skill library (P5).
//!
//! - GitHub search via `gh search code` (user's authenticated token).
//! - Install from GitHub via `gh api repos/<owner>/<repo>/contents/<path>`
//!   (returns base64-encoded content + `name`/`path`).
//! - In-app creation: build frontmatter from struct + write atomically.
//! - Per-project pinning: JSON list at
//!   `~/.ultron/cockpit/projects/<id>/pinned-agents.json` (shared with the
//!   P4 `agents_pinned_*` commands).

pub(crate) mod cache;
pub(crate) mod create;
pub(crate) mod gh_helpers;
pub(crate) mod helpers;
pub(crate) mod install_gh;
pub(crate) mod pinning;
pub(crate) mod search;
pub(crate) mod types;

// ai_install (AI-driven install via ai_router) se elimino entero 2026-09-23:
// su unico comando Tauri, library_install_via_ai, nunca tuvo llamador en la
// UI. pick_analysis_zone() era el unico llamante real de las zonas
// code-edit/code-review del AI Router; las zonas se dejan tal cual (no es
// alcance de esta poda).

pub use create::{agent_create_inner, skill_create_inner};
pub use install_gh::install_from_github_inner;
pub use pinning::{pin_agent_inner, pinned_load, unpin_agent_inner};
pub use search::search_github_inner;
pub use types::{
    AgentCreateSpec, LibraryKind, PinnedAgents, RemoteItem, SkillCreateSpec, TargetScope,
};
