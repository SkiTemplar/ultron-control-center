// commands/sessions_sub — Session & terminal domain command wrappers
//
// Groups:
//   sessions        — Claude session spawn, inline run, history list
//   terminal_layout — Per-project terminal split-pane layout
//   tabs            — Workspace tabs load/save
//   timeline        — Per-project timeline aggregator
//
// (Los comandos pty_* del terminal embebido se retiraron 2026-07; el runtime
// PTY interno vive en crate::pty y lo consumen kanban/delegate directamente.)

pub mod live_session;
pub mod session_manager;
pub mod session_summary;
// Sub-módulos internos del gestor de sesiones (cat7.3 split): parseo JSONL y
// inferencia de metadatos. No exportan al frontend; solo los usa session_manager.
pub(crate) mod session_jsonl;
pub(crate) mod session_meta;
pub mod sessions;
pub mod tabs;

pub use live_session::*;
pub use session_manager::*;
pub use session_summary::summarize_session_activity;
pub use sessions::*;
pub use tabs::*;
