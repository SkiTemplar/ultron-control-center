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
//   - Solo se ejecuta lo revisado: la UI enseña el script (`read_batch_script_inner`)
//     y `execute_batch_inner` rechaza el contenido que no coincida con el mostrado.
//   - Tope de `BATCH_TIMEOUT` con el árbol de procesos terminado al agotarse.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

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

/// Tope de una ejecución. Al agotarse, `run_with_timeout` termina el árbol de
/// procesos: un script colgado no queda vivo marcado como fallido.
const BATCH_TIMEOUT: Duration = Duration::from_secs(300);

/// Tope del script que cruza el IPC. Un script mayor no se ejecuta desde la UI
/// porque no se podría enseñar entero antes de confirmar.
const MAX_SCRIPT_PREVIEW_BYTES: u64 = 256 * 1024;

/// Script tal como lo ve la persona que debe confirmar la ejecución.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchScriptPreview {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    /// Texto íntegro, vacío si `too_large`.
    pub content: String,
    /// El script supera el tope: no se puede revisar aquí ni ejecutar desde aquí.
    pub too_large: bool,
}

pub fn batches_dir() -> Result<PathBuf, String> {
    let h = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let d = h.join(".ultron").join("batches");
    if !d.exists() {
        fs::create_dir_all(&d).map_err(|e| format!("mkdir batches: {e}"))?;
    }
    Ok(d)
}

fn is_allowed_ext(p: &Path) -> bool {
    matches!(
        p.extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some("bat") | Some("cmd") | Some("ps1")
    )
}

fn validate_inside(p: &PathBuf, root: &PathBuf) -> Result<(), String> {
    let cp = fs::canonicalize(p).map_err(|e| format!("canonicalize: {e}"))?;
    let cr = fs::canonicalize(root).map_err(|e| format!("canonicalize root: {e}"))?;
    if !cp.starts_with(&cr) {
        return Err(format!(
            "path escape: {} not under {}",
            cp.display(),
            cr.display()
        ));
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
            name: p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string(),
            path: p.to_string_lossy().to_string(),
            size_bytes: meta.len(),
            modified_epoch,
        });
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.modified_epoch));
    Ok(out)
}

/// Resuelve un nombre de batch a su ruta validada dentro de `dir`: nombre sin
/// separadores, fichero existente, extensión permitida y sin escapar de la carpeta.
fn resolve_script(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("nombre de batch no válido: {name}"));
    }
    let cand = dir.join(name);
    if !cand.is_file() {
        return Err(format!("batch '{name}' not found"));
    }
    if !is_allowed_ext(&cand) {
        return Err(format!("extension not allowed: {}", cand.display()));
    }
    validate_inside(&cand, &dir.to_path_buf())?;
    Ok(cand)
}

/// Decodifica un script para enseñarlo. PowerShell admite UTF-16 con BOM: sin
/// atender al BOM se vería un galimatías y la revisión no serviría de nada.
fn decode_script(bytes: &[u8]) -> String {
    let utf16 = |raw: &[u8], decode: fn([u8; 2]) -> u16| {
        let (pairs, _odd_byte) = raw.as_chunks::<2>();
        let units: Vec<u16> = pairs.iter().map(|pair| decode(*pair)).collect();
        String::from_utf16_lossy(&units)
    };
    match bytes {
        [0xFF, 0xFE, rest @ ..] => utf16(rest, u16::from_le_bytes),
        [0xFE, 0xFF, rest @ ..] => utf16(rest, u16::from_be_bytes),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

fn read_script_in(dir: &Path, name: &str) -> Result<BatchScriptPreview, String> {
    let cand = resolve_script(dir, name)?;
    let size_bytes = fs::metadata(&cand)
        .map_err(|e| format!("stat '{name}': {e}"))?
        .len();
    let too_large = size_bytes > MAX_SCRIPT_PREVIEW_BYTES;
    let content = if too_large {
        String::new()
    } else {
        decode_script(&fs::read(&cand).map_err(|e| format!("read '{name}': {e}"))?)
    };
    Ok(BatchScriptPreview {
        name: name.to_string(),
        path: cand.to_string_lossy().to_string(),
        size_bytes,
        content,
        too_large,
    })
}

/// Lee un batch para enseñarlo antes de confirmar su ejecución.
pub fn read_batch_script_inner(name: &str) -> Result<BatchScriptPreview, String> {
    read_script_in(&batches_dir()?, name)
}

/// Comprueba que lo que se va a ejecutar es lo que la persona ha visto: un
/// script reescrito entre la revisión y la confirmación no se lanza.
fn ensure_reviewed(dir: &Path, name: &str, reviewed: &str) -> Result<PathBuf, String> {
    let preview = read_script_in(dir, name)?;
    if preview.too_large {
        return Err(format!(
            "'{name}' pesa {} bytes y no se puede revisar aquí: ejecútalo a mano si procede",
            preview.size_bytes
        ));
    }
    if preview.content != reviewed {
        return Err(format!(
            "'{name}' ha cambiado desde que se revisó: vuelve a abrirlo antes de ejecutarlo"
        ));
    }
    Ok(PathBuf::from(preview.path))
}

/// Lanza el script con tope. Sin consola visible ni stdin (un `Read-Host` falla
/// en vez de colgarse), como en todos los llamantes de `run_with_timeout`.
fn run_script(cand: &Path, timeout: Duration) -> std::io::Result<std::process::Output> {
    let is_ps1 = cand
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("ps1"));
    let cmd = if is_ps1 {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(cand);
        c
    } else {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(cand);
        c
    };
    crate::ai_router::exec::run_with_timeout(cmd, timeout, None)
}

/// Mensaje de un lanzamiento fallido. El agotamiento del tope se distingue
/// porque el árbol de procesos ya se ha terminado: no queda nada vivo.
fn spawn_error_message(e: &std::io::Error, timeout: Duration) -> String {
    if e.kind() == std::io::ErrorKind::TimedOut {
        format!(
            "batch execution timed out after {} s: process tree terminated",
            timeout.as_secs()
        )
    } else {
        format!("spawn: {e}")
    }
}

pub fn execute_batch_inner(name: String, reviewed: String) -> Result<BatchRunResult, String> {
    let dir = batches_dir()?;
    let cand = ensure_reviewed(&dir, &name, &reviewed)?;
    let output = run_script(&cand, BATCH_TIMEOUT);

    let path_str = cand.to_string_lossy().to_string();

    // On spawn failure the command never even started â€” leave it in the queue
    // (reason="failed") so it is never silently dropped, then surface the error.
    let output = match output {
        Ok(o) => o,
        Err(e) => {
            let msg = spawn_error_message(&e, BATCH_TIMEOUT);
            if let Err(qe) = crate::batches_queue::record_inner(
                &name,
                &path_str,
                crate::batches_queue::BatchQueueReason::Failed,
                Some(msg.clone()),
            ) {
                tracing::error!(
                    "[batches] CRITICAL: could not enqueue failed batch '{name}': {qe}"
                );
            }
            return Err(msg);
        }
    };

    let success = output.status.success();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // Non-zero exit â†’ record (reason="failed") so the user sees it in the Cola
    // and can requeue / fix. A successful run leaves the queue untouched.
    if !success {
        let last_error = if stderr.trim().is_empty() {
            format!(
                "exit {}",
                output
                    .status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "?".into())
            )
        } else {
            stderr.clone()
        };
        if let Err(qe) = crate::batches_queue::record_inner(
            &name,
            &path_str,
            crate::batches_queue::BatchQueueReason::Failed,
            Some(last_error),
        ) {
            tracing::error!("[batches] CRITICAL: could not enqueue failed batch '{name}': {qe}");
        }
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

/// Delete a single batch script by name (not full path â€” prevents path traversal).
/// Validates the resolved path is inside `~/.ultron/batches/` before removing.
pub fn delete_batch_single_inner(name: String) -> Result<(), String> {
    // Reject names that look like path traversal before we even touch the FS.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(
            "invalid batch name: must be a bare filename with no path separators".to_string(),
        );
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

/// Delete ALL batch scripts (allowed extensions) regardless of age AND purge
/// every entry from queue.jsonl â€” backs the "Clear all" button. Non-batch
/// files are left untouched and counted in `kept`. Separate path from
/// `cleanup_old_batches_inner`, whose `older_than_days = 0` deliberately
/// deletes NOTHING (the `cutoff_secs > 0` guard), so "clear all" cannot be
/// expressed by reusing it.
pub fn clear_all_batches_inner() -> Result<BatchCleanupReport, String> {
    let dir = batches_dir()?;
    if !dir.exists() {
        return Ok(BatchCleanupReport {
            deleted: Vec::new(),
            kept: 0,
        });
    }
    let mut deleted: Vec<String> = Vec::new();
    let mut kept: usize = 0;
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // Skip the queue files â€” those are managed by clear_queue_inner below.
        let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if fname == "queue.jsonl"
            || fname == "queue-pending.jsonl"
            || fname.ends_with(".draining")
            || fname.ends_with(".tmp")
        {
            continue;
        }
        if !is_allowed_ext(&path) {
            kept += 1;
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => deleted.push(fname.to_string()),
            Err(e) => {
                tracing::warn!("[batches] could not delete '{}': {e}", path.display());
                kept += 1;
            }
        }
    }
    // Purge the persistent queue so the UI "Cola" section also empties.
    if let Err(e) = crate::batches_queue::clear_queue_inner() {
        tracing::warn!("[batches] clear_queue_inner failed (non-fatal): {e}");
    }
    Ok(BatchCleanupReport { deleted, kept })
}

// Higiene 2026-08-12 (audit 08-09 numero 41): cleanup_old_batches_inner borrada
// junto a su comando — superseded por clear_all_batches_inner.

#[cfg(test)]
mod tests {
    use super::*;

    fn carpeta_con(nombre: &str, contenido: &[u8]) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        fs::write(tmp.path().join(nombre), contenido).expect("script");
        tmp
    }

    #[test]
    fn la_vista_previa_devuelve_el_texto_integro() {
        let tmp = carpeta_con("a.ps1", b"Remove-Item C:\\x\n");
        let p = read_script_in(tmp.path(), "a.ps1").expect("preview");
        assert_eq!(p.content, "Remove-Item C:\\x\n");
        assert!(!p.too_large);
    }

    #[test]
    fn la_vista_previa_decodifica_utf16_con_bom() {
        // Sin atender al BOM, el comando se vería intercalado con NUL.
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend("del *".encode_utf16().flat_map(u16::to_le_bytes));
        let tmp = carpeta_con("u.ps1", &bytes);
        let p = read_script_in(tmp.path(), "u.ps1").expect("preview");
        assert_eq!(p.content, "del *");
    }

    #[test]
    fn la_vista_previa_rechaza_rutas_y_extensiones_ajenas() {
        let tmp = carpeta_con("nota.txt", b"x");
        for nombre in [
            "../secreto.ps1",
            "..\\secreto.ps1",
            "sub/a.ps1",
            "nota.txt",
            "falta.ps1",
        ] {
            assert!(read_script_in(tmp.path(), nombre).is_err(), "{nombre}");
        }
    }

    #[test]
    fn un_script_que_no_cabe_no_se_puede_ejecutar_desde_la_ui() {
        let grande = vec![b'x'; MAX_SCRIPT_PREVIEW_BYTES as usize + 1];
        let tmp = carpeta_con("g.ps1", &grande);
        let p = read_script_in(tmp.path(), "g.ps1").expect("preview");
        assert!(p.too_large && p.content.is_empty());
        assert!(ensure_reviewed(tmp.path(), "g.ps1", "").is_err());
    }

    #[test]
    fn solo_se_acepta_el_contenido_revisado() {
        let tmp = carpeta_con("a.cmd", b"echo uno");
        assert!(ensure_reviewed(tmp.path(), "a.cmd", "echo uno").is_ok());
        // Caso negativo: confirmar sin haberlo visto, o reescrito tras verlo.
        assert!(ensure_reviewed(tmp.path(), "a.cmd", "").is_err());
        fs::write(tmp.path().join("a.cmd"), b"echo dos").expect("reescribir");
        let err = ensure_reviewed(tmp.path(), "a.cmd", "echo uno").unwrap_err();
        assert!(err.contains("ha cambiado"), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn el_tope_termina_el_script_colgado_y_lo_dice() {
        let tmp = carpeta_con("colgado.cmd", b"@ping -n 60 127.0.0.1 >nul");
        let inicio = std::time::Instant::now();
        let tope = Duration::from_secs(1);
        let err = run_script(&tmp.path().join("colgado.cmd"), tope).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(inicio.elapsed() < Duration::from_secs(20));
        assert!(spawn_error_message(&err, tope).contains("terminated"));
    }

    #[cfg(windows)]
    #[test]
    fn un_script_con_espacios_en_la_ruta_corre_y_devuelve_su_salida() {
        let tmp = carpeta_con("con espacio.cmd", b"@echo hola");
        let tope = Duration::from_secs(30);
        let out = run_script(&tmp.path().join("con espacio.cmd"), tope).expect("corre");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("hola"));
    }
}
