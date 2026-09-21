// commands/library — Library domain command wrappers
//
// Groups:
//   catalog_compat — Stack detection + compatibility scoring + bulk install
//   library        — Install from GitHub, agent/skill create + pin
//   plugins_info   — Plugin info, list, uninstall, update-check, changelog
//   skills         — Skill CRUD, toggle, read/write markdown

pub mod catalog_compat;
#[allow(clippy::module_inception)]
// commands/library/library.rs mirrors parent — intentional grouping
pub mod library;
pub mod plugins_info;
// Post-install integration: auto sync-registry + memory candidate after install.
pub mod post_install;
// repos          — Destacados: descubrir por HTTP, clasificar y aplicar (2026-09-22)
pub mod repos;
pub mod skills;

pub use catalog_compat::*;
pub use library::*;
pub use plugins_info::*;
pub use post_install::*;
pub use repos::*;
pub use skills::*;
