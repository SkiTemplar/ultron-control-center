// commands/library — Library domain command wrappers
//
// Groups:
//   library      — GitHub search/install, curated catalog, agent/skill pin
//   plugins_info — Plugin info, list, uninstall, update-check, changelog
//   skills       — Skill CRUD, toggle, read/write markdown

pub mod library;
pub mod plugins_info;
pub mod skills;

pub use library::*;
pub use plugins_info::*;
pub use skills::*;
