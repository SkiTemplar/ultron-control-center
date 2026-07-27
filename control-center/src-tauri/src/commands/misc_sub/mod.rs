// commands/misc_sub — Miscellaneous domain command wrappers
//
// Groups:
//   misc            — Root helpers (ultron_root_str, home_dir, logs, usage,
//                     activity timeline, cost, vscode launcher)
//   alerts          — Alerts/changelog read/write
//   mcps            — MCP server management
//   hotkeys         — Global hotkey get/set/pause/resume
//   external_editor — Open in VSCode, read text file
//   slash_commands  — Slash command catalog (was commands_registry.rs)

pub mod alerts;
pub mod external_editor;
pub mod hotkeys;
pub mod mcps;
pub mod misc;
pub mod slash_commands;

pub use alerts::*;
pub use external_editor::*;
pub use hotkeys::*;
pub use mcps::*;
pub use misc::*;
pub use slash_commands::*;

/// Rejects a target containing cmd.exe metacharacters. The vscode launchers
/// wrap with `cmd.exe /C code <path>` on Windows, and `std::process::Command`
/// only quotes args containing spaces — a path like `skills&calc.md` would be
/// re-parsed by cmd.exe and the tail executed (same bug class as
/// `ai_router::exec::sanitize_for_cmd`, KIRKARDO R11.1 CVE). Unlike prompts,
/// paths can't be escaped — a neutered path no longer points at the file —
/// so we reject instead of sanitizing.
pub(super) fn reject_cmd_metachars(target: &str) -> Result<(), String> {
    const CMD_METACHARS: [char; 8] = ['&', '|', '<', '>', '^', '%', '!', '"'];
    if let Some(bad) = target.chars().find(|c| CMD_METACHARS.contains(c)) {
        return Err(format!(
            "path contains forbidden shell metacharacter {bad:?}: {target}"
        ));
    }
    Ok(())
}

/// Reads the last `limit` non-empty lines of a JSONL file, parsed as `T`,
/// in newest-first order. Malformed lines are silently skipped.
/// Used by `alerts.rs` (and potentially other misc_sub commands) via
/// `super::read_jsonl_tail`.
pub(super) fn read_jsonl_tail<T>(path: std::path::PathBuf, limit: usize) -> Result<Vec<T>, String>
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
    let start = n.saturating_sub(limit);
    let mut out: Vec<T> = Vec::with_capacity(n - start);
    for l in lines[start..].iter().rev() {
        if let Ok(parsed) = serde_json::from_str::<T>(l) {
            out.push(parsed);
        }
    }
    Ok(out)
}
