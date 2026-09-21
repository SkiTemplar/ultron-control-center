// pty/mod.rs — ULTRON Control Center 2.0 — Internal PTY runtime.
//
// Spawns `claude` / `codex` (or arbitrary commands) inside a PTY via
// portable-pty. The embedded terminal UI (and its pty_* Tauri commands)
// was retired 2026-07; this runtime stays because Rust-side consumers
// drive it directly: kanban RunBatch (spawn) and the tray/lifecycle
// shutdown path (kill_all).
//
// `write_inner` / `kill_inner` / `capture_output_inner` / `cli_on_path`
// (write/poll/kill-by-id + PATH probe) were retired 2026-09-14 alongside
// `agent_orchestration::delegate`, their only caller (kanban "comandos
// huérfanos" — `delegate_task_launch` had zero frontend callers).
// Recoverable from git history if the feature gets wired to a UI later.
//
// Submodules:
//   types    — PTY data types and session struct
//   registry — Global session registry + timestamp/ID helpers
//   spawn    — cwd resolution, PATH probing, command building
//   ops      — Session lifecycle: spawn

pub(crate) mod ops;
pub(crate) mod registry;
pub(crate) mod spawn;
#[cfg(test)]
mod tests;
pub(crate) mod types;

pub use ops::{kill_inner, list_inner, resize_inner, spawn_inner, subscribe_inner, write_inner};
pub use registry::kill_all_inner;
