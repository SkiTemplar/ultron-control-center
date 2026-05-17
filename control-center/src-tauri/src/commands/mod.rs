// ULTRON Control Center — Tauri commands
//
// v15.4 architectural split: `lib.rs` used to host every `#[tauri::command]`
// wrapper inline (1668 LOC). Each command was a thin delegation to a
// `domain::*_inner` function living in the sibling modules. The wrappers are
// now grouped by domain in this directory; `lib.rs` only owns the runtime
// plumbing (plugins, hotkey registration, tray setup) plus the
// `generate_handler!` invocation. Domain modules under `crate::*` remain
// unchanged — their `*_inner` API is the contract this layer consumes.
//
// Adding a new command:
//   1. Add the `#[tauri::command]` wrapper to the matching `commands/<group>.rs`
//      (create a new group only if no existing one fits).
//   2. Re-export it via `pub use` below.
//   3. Reference it from `generate_handler!` in `lib.rs` using the short name.
//
// TODO(v15.5): wire `tauri-specta` here to auto-generate
// `frontend/src/lib/bindings.ts` from these signatures.

pub mod agents;
pub mod ai_router;
pub mod alerts;
pub mod apps;
pub mod button_prompts;
pub mod diagnostics;
pub mod gaming;
pub mod hooks;
pub mod hotkeys;
pub mod inbox;
pub mod lifecycle;
pub mod maintenance;
pub mod mcps;
pub mod memory;
pub mod misc;
pub mod news;
pub mod personal;
pub mod plans;
pub mod projects;
pub mod sessions;
pub mod settings;
pub mod skills;
pub mod system;

// ---------------------------------------------------------------------------
// Shared command-level types and helpers
// ---------------------------------------------------------------------------

/// Generic command result envelope. A handful of commands shell out to
/// PowerShell / Python and need to surface stdout/stderr/exit verbatim
/// instead of the structured result types each domain module exposes.
#[derive(serde::Serialize)]
pub struct CmdResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// Reads the last `limit` non-empty lines of a JSONL file, parsed as `T`, in
/// newest-first order. Malformed lines are silently skipped — `alerts.jsonl`
/// historically had broken entries and a single bad line shouldn't poison
/// the whole list.
pub(crate) fn read_jsonl_tail<T>(path: std::path::PathBuf, limit: usize) -> Result<Vec<T>, String>
where
    T: serde::de::DeserializeOwned,
{
    use std::fs::File;
    use std::io::{BufRead, BufReader};

    let file = File::open(&path).map_err(|e| format!("open {:?}: {}", path, e))?;
    let reader = BufReader::new(file);
    let mut lines: Vec<String> = Vec::new();
    for line in reader.lines() {
        let l = line.map_err(|e| format!("read line: {}", e))?;
        if !l.trim().is_empty() {
            lines.push(l);
        }
    }
    let n = lines.len();
    let start = if n > limit { n - limit } else { 0 };
    let mut out: Vec<T> = Vec::with_capacity(n - start);
    for l in lines[start..].iter().rev() {
        if let Ok(parsed) = serde_json::from_str::<T>(l) {
            out.push(parsed);
        }
    }
    Ok(out)
}
