// Execution layer: spawn a maintenance command and capture its output.
// `run_maintenance_inner` dispatches through `build_cmd`.
// `run_backup_now_inner` is a dedicated "force backup" entry point that
// re-reads the configured destination from disk on every invocation.

use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::commands::{backup_script, build_cmd, opens_window};
use crate::ai_router::exec::run_with_timeout;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Tope de una acción de mantenimiento. Al agotarse se termina su árbol.
const MAINTENANCE_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Tope del backup: un espejo entero a un disco lento tarda horas, no días.
const BACKUP_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

/// Un backup a la vez dentro de la app. El estado `running` de la tarjeta se pierde
/// al cambiar de pestaña y un segundo `/MIR` escribiría sobre el mismo destino.
/// No cubre la tarea programada: eso exige un mutex en `weekly-backup.ps1`.
static BACKUP_RUNNING: AtomicBool = AtomicBool::new(false);

struct BackupGuard;

impl BackupGuard {
    fn acquire() -> Result<Self, String> {
        if BACKUP_RUNNING.swap(true, Ordering::SeqCst) {
            return Err("ya hay un backup en marcha: espera a que termine".to_string());
        }
        Ok(Self)
    }
}

impl Drop for BackupGuard {
    fn drop(&mut self) {
        BACKUP_RUNNING.store(false, Ordering::SeqCst);
    }
}

fn run_error_message(cmd: &str, e: &std::io::Error, timeout: Duration) -> String {
    if e.kind() == std::io::ErrorKind::TimedOut {
        format!(
            "{cmd} superó el tope de {} min y se terminó su árbol de procesos",
            timeout.as_secs() / 60
        )
    } else {
        format!("spawn {cmd}: {e}")
    }
}

/// Corre `command` con tope y traduce la salida al resultado de la UI.
fn run_bounded(
    kind: String,
    cmd: &str,
    command: Command,
    timeout: Duration,
    start: Instant,
) -> Result<MaintenanceResult, String> {
    let output = run_with_timeout(command, timeout, None)
        .map_err(|e| run_error_message(cmd, &e, timeout))?;
    Ok(MaintenanceResult {
        kind,
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        elapsed_ms: start.elapsed().as_millis(),
    })
}

/// Abre una ventana sin esperarla ni heredarle tuberías: un fallo al lanzarla es
/// un error, y de lo que pase luego dentro de la ventana no se afirma nada.
fn launch_window(
    kind: String,
    cmd: &str,
    mut command: Command,
    start: Instant,
) -> Result<MaintenanceResult, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command.spawn().map_err(|e| format!("spawn {cmd}: {e}"))?;
    Ok(MaintenanceResult {
        kind,
        success: true,
        stdout: "Ventana abierta: la acción continúa allí.".to_string(),
        stderr: String::new(),
        exit_code: None,
        elapsed_ms: start.elapsed().as_millis(),
    })
}

/// Parte de la comprobación de MCP. El sondeo real ya ha escrito `mcp-health.json`.
fn mcp_health_summary(statuses: &[&str]) -> String {
    if statuses.is_empty() {
        return "No hay ningún servidor MCP que comprobar.".to_string();
    }
    let count = |status: &str| statuses.iter().filter(|s| **s == status).count();
    let ok = count("ok");
    let degraded = count("degraded");
    let missing = count("missing");
    let other = statuses.len() - ok - degraded - missing;
    let mut summary = format!(
        "{} servidores MCP: {ok} ok, {degraded} degradados, {missing} sin respuesta",
        statuses.len()
    );
    if other > 0 {
        summary.push_str(&format!(", {other} sin comprobar"));
    }
    summary.push('.');
    summary
}

/// H15: usa el mismo sondeo que la pestaña MCPs. El script antiguo solo miraba
/// `settings.json`, sin servidores, y pisaba la foto buena con un resultado vacío.
fn run_mcp_health(kind: String, start: Instant) -> Result<MaintenanceResult, String> {
    let servers = crate::mcps::ping::mcp_health_check_all_inner()?;
    let statuses: Vec<&str> = servers.iter().map(|s| s.status.as_str()).collect();
    Ok(MaintenanceResult {
        kind,
        success: true,
        stdout: mcp_health_summary(&statuses),
        stderr: String::new(),
        exit_code: Some(0),
        elapsed_ms: start.elapsed().as_millis(),
    })
}

#[derive(Debug, Serialize)]
pub struct MaintenanceResult {
    pub kind: String,
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u128,
}

/// v2.5: dedicated "run backup now" entry point. Re-uses the same script the
/// Task Scheduler job runs (~/.ultron/scripts/backup/weekly-backup.ps1). We
/// surface this as its own command so the Dashboard BackupCard can call it
/// without piggy-backing on the generic `weekly-backup` maintenance kind —
/// the latter goes through the audit/timeline path and isn't intended for
/// the "I just want to restart the backup" use case.
///
/// v2.7 fix: previously this just spawned the script with the inherited
/// env. The Tauri command `set_backup_root` mirrors the chosen path into
/// `std::env::set_var("ULTRON_BACKUP_ROOT", …)`, but that only sticks for
/// the lifetime of the running Control Center process. If the user
/// restarts the app and then presses "Force backup now" without
/// re-picking the destination, the script wouldn't see any override and
/// would silently fall back to `%USERPROFILE%\BACKUP`, leaving the
/// configured drive empty and the "last backup" badge stuck on the old C:
/// mirror.
///
/// The script itself now reads `~/.ultron/.tmp/backup-root.txt` (matching
/// `backup_status.rs::backup_root()`), and we additionally inject both
/// `ULTRON_BACKUP_ROOT` + `ULTRON_BACKUP_SOURCES` here so the child
/// PowerShell never has to depend on inherited in-process state.
pub fn run_backup_now_inner() -> Result<MaintenanceResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let script = backup_script(&home);
    if !script.is_file() {
        return Err(format!("backup script missing: {}", script.display()));
    }
    let _running = BackupGuard::acquire()?;
    let start = Instant::now();
    #[cfg(target_os = "windows")]
    let (cmd, args): (String, Vec<String>) = (
        "powershell.exe".into(),
        vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            script.to_string_lossy().into_owned(),
        ],
    );
    #[cfg(not(target_os = "windows"))]
    let (cmd, args): (String, Vec<String>) =
        ("bash".into(), vec![script.to_string_lossy().into_owned()]);
    let mut command = Command::new(&cmd);
    command.args(&args).current_dir(home.join(".ultron"));

    // v2.7: explicitly inject the configured destination + sources into
    // the child process. We re-read from disk every invocation so a fresh
    // Control Center process (where `std::env::set_var` from a previous
    // session is gone) still sees the user's preferences.
    let root_cfg = home.join(".ultron").join(".tmp").join("backup-root.txt");
    if let Ok(raw) = std::fs::read_to_string(&root_cfg) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            command.env("ULTRON_BACKUP_ROOT", trimmed);
        }
    }
    let sources_cfg = home
        .join(".ultron")
        .join("cockpit")
        .join("backup-config.json");
    if let Ok(raw) = std::fs::read_to_string(&sources_cfg) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(arr) = val.get("sources").and_then(|v| v.as_array()) {
                let joined: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();
                if !joined.is_empty() {
                    command.env("ULTRON_BACKUP_SOURCES", joined.join(","));
                }
            }
        }
    }

    run_bounded(
        "run-backup-now".into(),
        &cmd,
        command,
        BACKUP_TIMEOUT,
        start,
    )
}

pub fn run_maintenance_inner(kind: String) -> Result<MaintenanceResult, String> {
    let start = Instant::now();
    if kind == "mcp-health" {
        return run_mcp_health(kind, start);
    }
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let (cmd, args) = build_cmd(&kind, &home)?;
    let mut command = Command::new(&cmd);
    command.args(&args).current_dir(home.join(".ultron"));
    if opens_window(&cmd, &args) {
        return launch_window(kind, &cmd, command, start);
    }
    let is_backup = kind == "weekly-backup";
    let _running = is_backup.then(BackupGuard::acquire).transpose()?;
    let timeout = if is_backup {
        BACKUP_TIMEOUT
    } else {
        MAINTENANCE_TIMEOUT
    };
    run_bounded(kind, &cmd, command, timeout, start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_parte_de_mcp_no_dice_hecho_sin_mas() {
        assert!(mcp_health_summary(&[]).contains("ningún servidor"));
        let parte = mcp_health_summary(&["ok", "ok", "degraded", "missing", "unknown"]);
        assert!(parte.starts_with("5 servidores"), "{parte}");
        assert!(parte.contains("2 ok"), "{parte}");
        assert!(parte.contains("1 degradados"), "{parte}");
        assert!(parte.contains("1 sin respuesta"), "{parte}");
        assert!(parte.contains("1 sin comprobar"), "{parte}");
    }

    #[test]
    fn no_hay_dos_backups_a_la_vez_y_el_cerrojo_se_suelta() {
        let primero = BackupGuard::acquire().expect("libre");
        let err = BackupGuard::acquire().err().expect("ocupado");
        assert!(err.contains("en marcha"), "{err}");
        assert!(
            run_backup_now_inner().is_err(),
            "el comando respeta el cerrojo"
        );
        drop(primero);
        drop(BackupGuard::acquire().expect("libre otra vez"));
    }

    #[test]
    fn el_error_de_tope_explica_que_se_termino_el_arbol() {
        let e = std::io::Error::new(std::io::ErrorKind::TimedOut, "x");
        let msg = run_error_message("powershell.exe", &e, Duration::from_secs(120));
        assert!(msg.contains("2 min") && msg.contains("árbol"), "{msg}");
        let e = std::io::Error::new(std::io::ErrorKind::NotFound, "no está");
        assert!(run_error_message("uv", &e, Duration::from_secs(1)).starts_with("spawn uv"));
    }

    #[cfg(windows)]
    #[test]
    fn una_ventana_se_lanza_sin_esperarla_y_un_fallo_de_lanzamiento_es_error() {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/c", "ping -n 30 127.0.0.1 >nul"]);
        let inicio = Instant::now();
        let r = launch_window("k".into(), "cmd.exe", cmd, inicio).expect("lanzada");
        assert!(r.success && r.exit_code.is_none());
        assert!(
            inicio.elapsed() < Duration::from_secs(5),
            "no espera al proceso"
        );
        let falta = Command::new("no-existe-este-ejecutable.exe");
        assert!(launch_window("k".into(), "x", falta, Instant::now()).is_err());
    }
}
