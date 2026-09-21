//! Control Center 2.0 — Agent + Skill library (P5).
//!
//! - Instalar desde GitHub: descarga por HTTP via `maria::repos` (base64 de
//!   `/repos/<owner>/<repo>/contents/<path>`) y escritura atomica.
//! - Creacion en la aplicacion: se compone el frontmatter y se escribe.
//! - Fijado por proyecto: lista JSON en
//!   `~/.maria/cockpit/projects/<id>/pinned-agents.json` (compartida con los
//!   comandos `agents_pinned_*` de P4).
//!
//! 2026-09-22 — se retiran tres piezas que dependian de la CLI `gh`, que en
//! esta maquina no esta instalada:
//!   * `search.rs` (`gh search code`): ademas de necesitar `gh`, su
//!     equivalente REST (`GET /search/code`) es el UNICO endpoint que exige
//!     token obligatoriamente. No tenia ni un llamador vivo en la interfaz, asi
//!     que se retira en vez de reescribirse.
//!   * `cache.rs`: cache en memoria que solo usaba `search.rs`.
//!   * `gh_helpers.rs`: el `Command` de `gh`. El base64 vive ahora en
//!     `maria::repos`, junto a la descarga.
//! El descubrimiento de repositorios vive en `maria::repos` + `commands::library::repos`.

pub(crate) mod create;
pub(crate) mod helpers;
pub(crate) mod install_gh;
pub(crate) mod pinning;
pub(crate) mod types;

pub use create::{agent_create_inner, skill_create_inner};
pub use install_gh::install_from_github_inner;
pub use pinning::{pin_agent_inner, pinned_load, unpin_agent_inner};
pub use types::{AgentCreateSpec, LibraryKind, PinnedAgents, SkillCreateSpec, TargetScope};
