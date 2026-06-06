// commands/projects — Projects domain command wrappers
//
// Groups all project-management Tauri commands:
//   projects — Project CRUD, launcher, open-in-IDE, CLAUDE.md editor, context
//   agents   — Agent CRUD, delegations, per-project AI roster, session invocation

pub mod agents;
#[allow(clippy::module_inception)]
// commands/projects/projects.rs mirrors parent — intentional grouping
pub mod projects;

pub use agents::*;
pub use projects::*;
