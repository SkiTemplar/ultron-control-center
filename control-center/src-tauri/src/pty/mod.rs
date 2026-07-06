// pty/mod.rs — ULTRON Control Center 2.0 — Internal PTY runtime.
//
// Spawns `claude` / `codex` (or arbitrary commands) inside a PTY via
// portable-pty. The embedded terminal UI (and its pty_* Tauri commands)
// was retired 2026-07; this runtime stays because Rust-side consumers
// drive it directly: kanban RunBatch (spawn), agent delegation
// (spawn/write/capture/kill), project_agents (list/write) and the
// tray/lifecycle shutdown path (kill_all).
//
// Submodules:
//   types    — PTY data types and session struct
//   registry — Global session registry + timestamp/ID helpers
//   spawn    — cwd resolution, PATH probing, command building
//   ops      — Session lifecycle: spawn, write, kill, capture, list

pub(crate) mod ops;
pub(crate) mod registry;
pub(crate) mod spawn;
#[cfg(test)]
mod tests;
pub(crate) mod types;

pub use ops::{capture_output_inner, kill_inner, list_inner, spawn_inner, write_inner};
pub use registry::kill_all_inner;
pub use spawn::cli_on_path;
// CaptureResult / PtySessionSummary siguen siendo pub(crate) via `types`;
// solo PtyStatus se nombra fuera del modulo (invoke.rs, delegate.rs).
pub use types::PtyStatus;
