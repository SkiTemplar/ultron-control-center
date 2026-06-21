// commands/sessions_sub — Session & terminal domain command wrappers
//
// Groups:
//   sessions        — Claude session spawn, inline run, history list
//   terminal_layout — Per-project terminal split-pane layout
//   pty             — Embedded PTY spawn/write/resize/kill/list/replay
//   tabs            — Workspace tabs load/save
//   timeline        — Per-project timeline aggregator

pub mod live_session;
pub mod pty;
pub mod session_manager;
// Sub-módulos internos del gestor de sesiones (cat7.3 split): parseo JSONL y
// inferencia de metadatos. No exportan al frontend; solo los usa session_manager.
pub(crate) mod session_jsonl;
pub(crate) mod session_meta;
pub mod sessions;
pub mod tabs;

pub use live_session::*;
pub use pty::*;
pub use session_manager::*;
pub use sessions::*;
pub use tabs::*;
