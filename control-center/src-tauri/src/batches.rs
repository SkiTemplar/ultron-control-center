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

    let output = output.map_err(|e| format!("spawn: {e}"))?;
    Ok(BatchRunResult {
        success: output.status.success(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}
