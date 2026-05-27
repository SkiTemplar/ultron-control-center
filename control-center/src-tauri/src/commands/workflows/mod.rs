// commands/workflows — Workflow automation domain command wrappers
//
// Groups:
//   hooks          — Hook lifecycle CRUD, test, fire history, AI name analysis
//   plans          — Plans CRUD + auto-archive
//   rules          — Rules list/read/write
//   maintenance    — Maintenance commands, backup, app lifecycle
//   workflow_runs  — YAML composability + SQLite run history (KIRKARDO 23 P2)

pub mod hooks;
pub mod maintenance;
pub mod plans;
pub mod rules;
pub mod workflow_runs;

pub use hooks::*;
pub use maintenance::*;
pub use plans::*;
pub use rules::*;
pub use workflow_runs::*;
