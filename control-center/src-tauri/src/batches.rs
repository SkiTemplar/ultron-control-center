// ULTRON Control Center - Batches
//
// Ejecuta scripts pre-aprobados desde ~/.ultron/batches/ (whitelist).
// Caso de uso: aplicar cambios que GateGuard u otros sandboxes bloquearon
// durante una sesion Claude Code automatica. El .bat se escribe en disco,
// y el usuario lo ejecuta con un click desde la UI cuando convenga.
//
// Seguridad:
//   - Path canonicalizado, debe estar dentro de ~/.ultron/batches/.
//   - Extension whitelist: .bat / .cmd / .ps1.
//   - Captura stdout/stderr y exit code, sin streaming.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchEntry {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified_epoch: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchRunResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub fn batches_dir() -> Result<PathBuf, String> {
    let h = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let d = h.join(".ultron").join("batches");
    if !d.exists() {
        fs::create_dir_all(&d).map_err(|e| format!("mkdir batches: {e}"))?;
    }
    Ok(d)
}

fn is_allowed_ext(p: &PathBuf) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(),
        Some("bat") | Some("cmd") | Some("ps1")
    )
}

fn validate_inside(p: &PathBuf, root: &PathBuf) -> Result<(), String> {
    let cp = fs::canonicalize(p).map_err(|e| format!("canonicalize: {e}"))?;
    let cr = fs::canonicalize(root).map_err(|e| format!("canonicalize root: {e}"))?;
    if !cp.starts_with(&cr) {
        return Err(format!("path escape: {} not under {}", cp.display(), cr.display()));
    }
    Ok(())
}

pub fn list_batches_inner() -> Result<Vec<BatchEntry>, String> {
    let dir = batches_dir()?;
    let mut out: Vec<BatchEntry> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("read batches dir: {e}"))?;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() || !is_allowed_ext(&p) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_epoch = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(BatchEntry {
            name: p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
            path: p.to_string_lossy().to_string(),
            size_bytes: meta.len(),
            modified_epoch,
        });
    }
    out.sort_by(|a, b| b.modified_epoch.cmp(&a.modified_epoch));
    Ok(out)
}

pub fn execute_batch_inner(name: String) -> Result<BatchRunResult, String> {
    let dir = batches_dir()?;
    let cand = dir.join(&name);
    if !cand.is_file() {
        return Err(format!("batch '{name}' not found"));
    }
    if !is_allowed_ext(&cand) {
        return Err(format!("extension not allowed: {}", cand.display()));
    }
    validate_inside(&cand, &dir)?;

    let ext = cand
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    let output = if ext == "ps1" {
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &cand.to_string_lossy(),
            ])
            .output()
    } else {
        Command::new("cmd").args(["/C", &cand.to_string_lossy()]).output()
    };

    let path_str = cand.to_string_lossy().to_string();

    // On spawn failure the command never even started — leave it in the queue
    // (reason="failed") so it is never silently dropped, then surface the error.
    let output = match output {
        Ok(o) => o,
        Err(e) => {
            let msg = format!("spawn: {e}");
            let _ = crate::batches_queue::record_inner(
                &name,
                &path_str,
                crate::batches_queue::BatchQueueReason::Failed,
                Some(msg.clone()),
            );
            return Err(msg);
        }
    };

    let success = output.status.success();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // Non-zero exit → record (reason="failed") so the user sees it in the Cola
    // and can requeue / fix. A successful run leaves the queue untouched.
    if !success {
        let last_error = if stderr.trim().is_empty() {
            format!("exit {}", output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into()))
        } else {
            stderr.clone()
        };
        let _ = crate::batches_queue::record_inner(
            &name,
            &path_str,
            crate::batches_queue::BatchQueueReason::Failed,
            Some(last_error),
        );
    }

    Ok(BatchRunResult {
        success,
        exit_code: output.status.code(),
        stdout,
        stderr,
    })
}

#[derive(serde::Serialize)]
pub struct BatchCleanupReport {
    pub deleted: Vec<String>,
    pub kept: usize,
}

/// Delete a single batch script by name (not full path — prevents path traversal).
/// Validates the resolved path is inside `~/.ultron/batches/` before removing.
pub fn delete_batch_single_inner(name: String) -> Result<(), String> {
    // Reject names that look like path traversal before we even touch the FS.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid batch name: must be a bare filename with no path separators".to_string());
    }
    let dir = batches_dir()?;
    let cand = dir.join(&name);
    if !cand.exists() {
        return Err(format!("batch '{name}' not found"));
    }
    if !cand.is_file() {
        return Err(format!("'{name}' is not a file"));
    }
    if !is_allowed_ext(&cand) {
        return Err(format!("extension not allowed for '{name}'"));
    }
    validate_inside(&cand, &dir)?;
    std::fs::remove_file(&cand).map_err(|e| format!("delete '{name}': {e}"))
}

/// Delete ALL batch scripts (allowed extensions) regardless of age — backs the
/// "Clear all" button (card-bug-runbatch-clear). Non-batch files are left
/// untouched and counted in `kept`. Separate path from
/// `cleanup_old_batches_inner`, whose `older_than_days = 0` deliberately
/// deletes NOTHING (the `cutoff_secs > 0` guard), so "clear all" cannot be
/// expressed by reusing it.
pub fn clear_all_batches_inner() -> Result<BatchCleanupReport, String> {
    let dir = batches_dir()?;
    if !dir.exists() {
        return Ok(BatchCleanupReport { deleted: Vec::new(), kept: 0 });
    }
    let mut deleted: Vec<String> = Vec::new();
    let mut kept: usize = 0;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !is_allowed_ext(&path) {
            kept += 1;
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if std::fs::remove_file(&path).is_ok() {
            deleted.push(name);
        } else {
            kept += 1;
        }
    }
    Ok(BatchCleanupReport { deleted, kept })
}

/// Delete batch scripts older than `older_than_days` (mtime). Returns the
/// list of file names removed plus how many remain. Lets the user keep the
/// batches folder from growing without bound (USER: "Run Batch con
/// eliminacion de .bats para que no se queden ilimitados").
pub fn cleanup_old_batches_inner(older_than_days: u32) -> Result<BatchCleanupReport, String> {
    let dir = batches_dir()?;
    if !dir.exists() {
        return Ok(BatchCleanupReport { deleted: Vec::new(), kept: 0 });
    }
    let now = std::time::SystemTime::now();
    let cutoff_secs = (older_than_days as u64).saturating_mul(86_400);
    let mut deleted: Vec<String> = Vec::new();
    let mut kept: usize = 0;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !is_allowed_ext(&path) {
            kept += 1;
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok();
        let age = mtime
            .and_then(|t| now.duration_since(t).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if age >= cutoff_secs && cutoff_secs > 0 {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if std::fs::remove_file(&path).is_ok() {
                deleted.push(name);
            } else {
                kept += 1;
            }
        } else {
            kept += 1;
        }
    }
    Ok(BatchCleanupReport { deleted, kept })
}
