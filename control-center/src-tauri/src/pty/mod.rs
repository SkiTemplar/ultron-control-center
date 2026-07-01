// pty/mod.rs — ULTRON Control Center 2.0 — Embedded PTY runtime.
//
// Spawns `claude` / `codex` (or arbitrary commands) inside a PTY
// via portable-pty. Each session emits `pty:data:<id>` events with base64
// chunks; on exit emits `pty:exit:<id>` with the exit code.
//
// Submodules:
//   types    — PTY data types and session struct
//   registry — Global session registry + timestamp/ID helpers
//   spawn    — cwd resolution, PATH probing, command building
//   ops      — Session lifecycle: spawn, write, resize, kill, replay, capture, list

pub(crate) mod ops;
pub(crate) mod registry;
pub(crate) mod spawn;
#[cfg(test)]
mod tests;
pub(crate) mod types;

pub use ops::{
    capture_output_inner, kill_inner, list_inner, list_one_inner, replay_inner, resize_inner,
    spawn_inner, write_inner,
};
pub use registry::kill_all_inner;
pub use spawn::cli_on_path;
pub use types::{CaptureResult, PtySessionSummary, PtyStatus};
