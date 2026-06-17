//! Control Center 2.0 — Agent + Skill library (P5).
//!
//! - GitHub search via `gh search code` (user's authenticated token).
//! - Install from GitHub via `gh api repos/<owner>/<repo>/contents/<path>`
//!   (returns base64-encoded content + `name`/`path`).
//! - In-app creation: build frontmatter from struct + write atomically.
//! - Per-project pinning: JSON list at
//!   `~/.ultron/cockpit/projects/<id>/pinned-agents.json` (shared with the
//!   P4 `agents_pinned_*` commands).

pub(crate) mod ai_install;
pub(crate) mod cache;
pub(crate) mod create;
pub(crate) mod gh_helpers;
pub(crate) mod helpers;
pub(crate) mod install_gh;
pub(crate) mod pinning;
pub(crate) mod search;
pub(crate) mod types;

pub use ai_install::install_via_ai_inner;
pub use create::{agent_create_inner, skill_create_inner};
pub use install_gh::install_from_github_inner;
pub use pinning::{pin_agent_inner, pinned_load, unpin_agent_inner};
pub use search::search_github_inner;
pub use types::{
    AgentCreateSpec, AiInstallResult, LibraryKind, PinnedAgents, RemoteItem, SkillCreateSpec,
    TargetScope,
};
