// commands/library — Library domain command wrappers
//
// Groups:
//   catalog_compat — Stack detection + compatibility scoring + bulk install
//   library        — GitHub search/install, curated catalog, agent/skill pin
//   plugins_info   — Plugin info, list, uninstall, update-check, changelog
//   skills         — Skill CRUD, toggle, read/write markdown

pub mod catalog_compat;
#[allow(clippy::module_inception)] // commands/library/library.rs mirrors parent — intentional grouping
pub mod library;
pub mod plugins_info;
pub mod skills;

pub use catalog_compat::*;
pub use library::*;
pub use plugins_info::*;
pub use skills::*;
