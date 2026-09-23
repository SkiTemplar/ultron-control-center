// commands/library — Library domain command wrappers
//
// Groups:
//   library        — GitHub search/install, curated catalog, agent/skill pin
//   plugins_info   — Plugin info, list, uninstall, update-check, changelog
//   skills         — Skill CRUD, toggle, read/write markdown
//
// catalog_compat (stack detection + compatibility scoring) se elimino
// entero el 2026-09-23: su unico comando, analyze_catalog_compat, nunca tuvo
// llamador en la UI.

#[allow(clippy::module_inception)]
// commands/library/library.rs mirrors parent — intentional grouping
pub mod library;
pub mod plugins_info;
// Post-install integration: auto sync-registry + memory candidate after install.
pub mod post_install;
pub mod skills;

pub use library::*;
pub use plugins_info::*;
pub use post_install::*;
pub use skills::*;
