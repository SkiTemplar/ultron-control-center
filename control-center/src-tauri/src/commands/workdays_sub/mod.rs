// commands/workdays_sub — Workdays domain command wrappers
//
// Groups:
//   workdays      — Workday CRUD, sessions, goals, templates, auto-surface
//   cross_project — KIRKARDO 13: aggregate In Progress + Blocked across all projects

pub mod cross_project;
pub mod workdays;

pub use cross_project::*;
pub use workdays::*;
