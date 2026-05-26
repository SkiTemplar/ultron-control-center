// ULTRON Control Center 2.x — Memory tab live status surfaces
//
// Aggregates the state of the four memory systems USER runs:
//
//   1. mem0  (cloud)              — last sync log entry + count via REST
//   2. ECC memory                 — JSONL graph at ~/.claude/memory.jsonl
//                                   and/or @modelcontextprotocol/server-memory
//   3. Graphify                   — CLI tool (graphify --version + list)
//   4. File-based MEMORY.md       — count + total bytes under
//                                   ~/.claude/projects/*/memory/*.md
//
// All probes are best-effort: a missing binary, an unreadable file or a
// network failure surfaces as `available=false` plus an `error` string —
// never a hard failure. The frontend renders the surface as 4 status cards.
//
// Companion module to `crate::workdays::pending_links` (T2 of the same
// patch): the pending-link drainer runs at startup, this module exposes the
// runtime probes to the UI.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

use crate::mem0::{self, Mem0LogEntry};

// On Windows, every `Command::new(...)` flashes a console window for the
// lifetime of the child process. USER flagged it as "se lanza una
// terminal que no se quita" — annoying when the Memory tab probes graphify
// / node every 30s. Same trick as `library::gh_command`: set CREATE_NO_WINDOW
// (0x0800_0000) so the spawn stays invisible.
fn quiet_command(program: &str) -> Command {
    let cmd = Command::new(program);
    #[cfg(windows)]
    {
        let mut cmd = cmd;
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
        return cmd;
    }
    #[cfg(not(windows))]
    cmd
}

// ---------------------------------------------------------------------------
// mem0 status card
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mem0CardStatus {
    /// `true` when last log entry was `ok=true` AND the API key reads as
    /// non-placeholder. `false` otherwise so the UI can flip the pill red.
    pub healthy: bool,
    pub api_key_present: bool,
    pub api_key_masked: Option<String>,
    /// Approximate memory count for `user_id="global"` — `None` when the
    /// list call fails or the key is missing.
    pub memory_count: Option<usize>,
    /// ISO-8601 timestamp of the most recent successful `add` / `list` /
    /// `status` call.
    pub last_write_ts: Option<String>,
    pub last_op: Option<String>,
    pub log_path: String,
    pub error: Option<String>,
}

/// Pure healthy-flag calc for the Mem0 status card.
///
/// Fix v2.7.2: the previous implementation pinned `healthy=false` forever
/// once the log accumulated any error (`diag.last_error.is_none()` is
/// only true on a brand-new install). The corrected signal is:
///   - we have an API key, AND
///   - the most recent `list_all` call succeeded, AND
///   - the most recent successful log entry is newer than the most
///     recent error log entry (RFC-3339 sorts lexicographically).
///
/// Extracted into a free function so it can be unit-tested without
/// hitting the file system or the network.
fn compute_mem0_healthy(
    api_key_present: bool,
    list_call_ok: bool,
    last_success_ts: Option<&str>,
    last_error_ts: Option<&str>,
) -> bool {
    if !api_key_present || !list_call_ok {
        return false;
    }
    match (last_success_ts, last_error_ts) {
        (Some(s), Some(e)) => s > e,
        (Some(_), None) => true,
        // No history yet — trust the current call's success.
        (None, None) => true,
        (None, Some(_)) => false,
    }
}

pub async fn mem0_card_inner() -> Result<Mem0CardStatus, String> {
    // We piggy-back on the existing diagnostics layer so we don't duplicate
    // the file-parsing logic.
    let diag = mem0::diagnostics_inner().map_err(|e| format!("diagnostics: {e}"))?;
    let api_key_present = diag.api_key_present;

    let (memory_count, count_err) = if api_key_present {
        match mem0::list_all_inner(None, Some(100)).await {
            Ok(list) => (Some(list.len()), None),
            Err(e) => (None, Some(e)),
        }
    } else {
        (None, diag.api_key_error.clone())
    };

    let last_success: Option<Mem0LogEntry> = diag.last_success.clone();
    let last_write_ts = last_success.as_ref().map(|e| e.timestamp.clone());
    let last_op = last_success.as_ref().map(|e| e.op.clone());

    let last_success_ts = diag.last_success.as_ref().map(|e| e.timestamp.as_str());
    let last_error_ts = diag.last_error.as_ref().map(|e| e.timestamp.as_str());
    let healthy = compute_mem0_healthy(
        api_key_present,
        count_err.is_none(),
        last_success_ts,
        last_error_ts,
    );

    Ok(Mem0CardStatus {
        healthy,
        api_key_present,
        api_key_masked: diag.api_key_masked,
        memory_count,
        last_write_ts,
        last_op,
        log_path: diag.log_path,
        error: count_err.or(diag.api_key_error),
    })
}

// ---------------------------------------------------------------------------
// ECC memory status card
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EccCardStatus {
    pub healthy: bool,
    pub source_path: Option<String>,
    pub entity_count: usize,
    pub relation_count: usize,
    pub bytes: u64,
    pub error: Option<String>,
}

pub fn ecc_card_inner() -> Result<EccCardStatus, String> {
    // Re-use the ECC reader so the UI sees the same source-of-truth.
    let snapshot = crate::ecc_memory::ecc_memory_read().map_err(|e| format!("ecc read: {e}"))?;
    let bytes = snapshot
        .source_path
        .as_ref()
        .and_then(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    let healthy = snapshot.source_path.is_some();
    Ok(EccCardStatus {
        healthy,
        source_path: snapshot.source_path,
        entity_count: snapshot.entities.len(),
        relation_count: snapshot.relations.len(),
        bytes,
        error: None,
    })
}

// ---------------------------------------------------------------------------
// Graphify status card
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GraphifyCardStatus {
    /// `true` when `graphify --version` exits 0.
    pub healthy: bool,
    pub installed: bool,
    pub version: Option<String>,
    /// Number of projects indexed — `None` when `graphify list` is not
    /// available or returns an unparseable shape.
    pub project_count: Option<usize>,
    pub projects: Vec<String>,
    pub error: Option<String>,
}

fn run_graphify(args: &[&str]) -> Result<(i32, String, String), String> {
    let mut cmd = quiet_command("graphify");
    cmd.args(args);
    // On Windows, .cmd shims for npm/global packages must be invoked through
    // cmd.exe — Command::new("graphify") alone fails with "program not
    // found" for `graphify.cmd`. Try the bare invocation first, then fall
    // back to cmd.exe /C.
    let out = cmd.output();
    let out = match out {
        Ok(o) => o,
        Err(_) if cfg!(windows) => quiet_command("cmd")
            .arg("/C")
            .arg("graphify")
            .args(args)
            .output()
            .map_err(|e| format!("graphify spawn: {e}"))?,
        Err(e) => return Err(format!("graphify spawn: {e}")),
    };
    Ok((
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

pub fn graphify_card_inner() -> Result<GraphifyCardStatus, String> {
    // --version probe
    let version_probe = run_graphify(&["--version"]);
    let (installed, version, version_err) = match version_probe {
        Ok((0, stdout, _)) => {
            let v = stdout.trim().to_string();
            (true, if v.is_empty() { None } else { Some(v) }, None)
        }
        Ok((code, _, stderr)) => (
            false,
            None,
            Some(format!("graphify --version exit {code}: {}", stderr.trim())),
        ),
        Err(e) => (false, None, Some(e)),
    };

    let (project_count, projects, list_err) = if installed {
        match run_graphify(&["list"]) {
            Ok((0, stdout, _)) => {
                let names: Vec<String> = stdout
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty() && !l.starts_with('#'))
                    .collect();
                let count = names.len();
                (Some(count), names, None)
            }
            Ok((_code, _, _)) => (None, Vec::new(), None),
            Err(e) => (None, Vec::new(), Some(e)),
        }
    } else {
        (None, Vec::new(), None)
    };

    Ok(GraphifyCardStatus {
        healthy: installed,
        installed,
        version,
        project_count,
        projects,
        error: version_err.or(list_err),
    })
}

// ---------------------------------------------------------------------------
// File-based MEMORY.md card
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemoryFilesCardStatus {
    pub healthy: bool,
    pub file_count: usize,
    pub total_bytes: u64,
    pub root: String,
    pub error: Option<String>,
}

fn memory_files_root() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("no home dir")?
        .join(".claude")
        .join("projects"))
}

pub fn memory_files_card_inner() -> Result<MemoryFilesCardStatus, String> {
    let root = memory_files_root()?;
    let root_display = root.display().to_string();
    if !root.exists() {
        return Ok(MemoryFilesCardStatus {
            healthy: false,
            file_count: 0,
            total_bytes: 0,
            root: root_display,
            error: Some("projects dir not found".into()),
        });
    }
    let mut file_count: usize = 0;
    let mut total_bytes: u64 = 0;
    let entries = fs::read_dir(&root).map_err(|e| format!("read root: {e}"))?;
    for entry in entries.flatten() {
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let memory_dir = project_dir.join("memory");
        if !memory_dir.is_dir() {
            continue;
        }
        let md_entries = match fs::read_dir(&memory_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for md in md_entries.flatten() {
            let p = md.path();
            if p.extension().and_then(|x| x.to_str()) == Some("md") {
                if let Ok(meta) = fs::metadata(&p) {
                    file_count += 1;
                    total_bytes += meta.len();
                }
            }
        }
    }
    Ok(MemoryFilesCardStatus {
        healthy: file_count > 0,
        file_count,
        total_bytes,
        root: root_display,
        error: None,
    })
}

// ---------------------------------------------------------------------------
// Manual mem0 sync — invokes the user-level mem0-sync.js hook
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

pub fn sync_mem0_manual_inner() -> Result<SyncResult, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let script = home
        .join(".claude")
        .join("scripts")
        .join("mem0-sync.js");
    if !script.exists() {
        return Err(format!("mem0-sync.js not found at {}", script.display()));
    }
    let started = Instant::now();
    let out = quiet_command("node")
        .arg(&script)
        .env("ULTRON_MANUAL_SYNC", "1")
        .output()
        .map_err(|e| format!("spawn node: {e}"))?;
    let duration_ms = started.elapsed().as_millis() as u64;
    Ok(SyncResult {
        ok: out.status.success(),
        exit_code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        duration_ms,
    })
}

// ---------------------------------------------------------------------------
// Graphify index helper
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

pub fn graphify_index_inner(path: String) -> Result<IndexResult, String> {
    if path.trim().is_empty() {
        return Err("path is empty".into());
    }
    let target = PathBuf::from(path.trim());
    if !target.exists() {
        return Err(format!("path {} does not exist", target.display()));
    }
    let started = Instant::now();
    // Same Windows .cmd workaround as run_graphify(); we keep this explicit
    // here because we need to set cwd to the project directory.
    let direct = quiet_command("graphify")
        .arg(".")
        .current_dir(&target)
        .output();
    let out = match direct {
        Ok(o) => o,
        Err(_) if cfg!(windows) => quiet_command("cmd")
            .arg("/C")
            .arg("graphify")
            .arg(".")
            .current_dir(&target)
            .output()
            .map_err(|e| format!("spawn graphify: {e}"))?,
        Err(e) => return Err(format!("spawn graphify: {e}")),
    };
    let duration_ms = started.elapsed().as_millis() as u64;
    Ok(IndexResult {
        ok: out.status.success(),
        exit_code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_false_when_no_api_key() {
        let h = compute_mem0_healthy(false, true, Some("2026-05-25T10:00:00Z"), None);
        assert!(!h);
    }

    #[test]
    fn healthy_false_when_list_call_failed() {
        let h = compute_mem0_healthy(true, false, Some("2026-05-25T10:00:00Z"), None);
        assert!(!h);
    }

    #[test]
    fn healthy_true_when_success_newer_than_error() {
        let h = compute_mem0_healthy(
            true,
            true,
            Some("2026-05-25T11:00:00Z"),
            Some("2026-05-25T10:00:00Z"),
        );
        assert!(
            h,
            "should be healthy when last success timestamp > last error timestamp"
        );
    }

    #[test]
    fn healthy_false_when_error_newer_than_success() {
        // This is the bug-fix regression test: the OLD code would have
        // returned `false` here (last_error.is_some()), and that was
        // wrong — we expect false ONLY when error > success.
        let h = compute_mem0_healthy(
            true,
            true,
            Some("2026-05-25T10:00:00Z"),
            Some("2026-05-25T11:00:00Z"),
        );
        assert!(!h);
    }

    #[test]
    fn healthy_true_when_only_successes_recorded() {
        let h = compute_mem0_healthy(true, true, Some("2026-05-25T10:00:00Z"), None);
        assert!(h);
    }

    #[test]
    fn healthy_true_when_no_history_but_call_just_worked() {
        // This is the "fresh install" case — list call works but the
        // log file is empty.
        let h = compute_mem0_healthy(true, true, None, None);
        assert!(h);
    }

    #[test]
    fn healthy_false_when_only_errors_recorded() {
        let h = compute_mem0_healthy(true, true, None, Some("2026-05-25T10:00:00Z"));
        assert!(!h);
    }
}
