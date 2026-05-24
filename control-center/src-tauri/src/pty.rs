// ULTRON Control Center 2.0 — Embedded PTY runtime
//
// Spawns `claude` / `codex` / `gemini` (or arbitrary commands) inside a PTY
// via portable-pty. Each session emits `pty:data:<id>` events with base64
// chunks; on exit emits `pty:exit:<id>` with the exit code.

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(tag = "kind", content = "value")]
pub enum PtyStatus {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "exited")]
    Exited(i32),
    #[serde(rename = "killed")]
    Killed,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PtySessionSummary {
    pub id: String,
    pub project_id: String,
    pub card_id: Option<String>,
    pub provider: String,
    pub started_at: String,
    pub status: PtyStatus,
}

pub struct PtySession {
    pub id: String,
    pub project_id: String,
    pub card_id: Option<String>,
    pub provider: String,
    pub started_at: String,
    pub status: PtyStatus,
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl PtySession {
    pub fn summary(&self) -> PtySessionSummary {
        PtySessionSummary {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            card_id: self.card_id.clone(),
            provider: self.provider.clone(),
            started_at: self.started_at.clone(),
            status: self.status.clone(),
        }
    }
}

static SESSIONS: OnceLock<Mutex<HashMap<String, PtySession>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, PtySession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{}", secs)
}

fn new_ulid() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    format!("pty-{t}-{n}")
}

/// Resolve a provider slug to the CommandBuilder that actually spawns it.
///
/// Windows-specific bug fix (2026-05-23): the Claude/Codex/Gemini CLIs are
/// installed as `.cmd` shim scripts (e.g. `claude.cmd` under the npm prefix
/// or `~/.local/bin`). portable-pty's `CommandBuilder::new("claude")` ends up
/// in CreateProcessW with a bare argv0 of `claude`, which does NOT walk
/// PATHEXT — so the shim is never found and the spawn fails silently (PTY
/// shows nothing, child exits immediately). The fix mirrors the trick used in
/// `sessions::spawn_session_inner`: shell out via `cmd.exe /C <provider>` so
/// the cmd interpreter resolves `<provider>.cmd` through PATHEXT.
///
/// Other providers we add (`powershell`, `powershell-admin`) get their own
/// branches here — `powershell` runs Windows PowerShell 5.1 inside the PTY,
/// and `powershell-admin` re-launches PowerShell elevated through UAC
/// (Start-Process -Verb RunAs) without keeping the elevated session attached
/// to our PTY (UAC always opens a fresh console window).
fn build_command(provider: &str, agent: Option<&str>) -> Result<CommandBuilder, String> {
    let trimmed = provider.trim();
    if trimmed.is_empty() {
        return Err("provider is empty".to_string());
    }
    match trimmed {
        "claude" | "codex" | "gemini" => {
            // v2.6 bug fix: pre-validate the binary exists on PATH. Without
            // this, codex/gemini just opens a PTY that immediately dies
            // because cmd.exe ran but the shim wasn't found — the user
            // sees a blank terminal instead of a clear error. Run `where`
            // on Windows (POSIX `which` on others) and surface the result.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let mut probe = std::process::Command::new("where");
                probe.arg(trimmed);
                probe.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
                let output = probe.output().map_err(|e| {
                    format!("PATH probe failed: {e}")
                })?;
                if !output.status.success() {
                    return Err(format!(
                        "'{}' not found on PATH. Install the CLI first, e.g. `npm install -g @{0}/cli` (or equivalent), then retry.",
                        trimmed
                    ));
                }
                let mut cmd = CommandBuilder::new("cmd.exe");
                cmd.arg("/C");
                cmd.arg(trimmed);
                if let Some(a) = agent {
                    cmd.arg("--agent");
                    cmd.arg(a);
                }
                Ok(cmd)
            }
            #[cfg(not(windows))]
            {
                let output = std::process::Command::new("which")
                    .arg(trimmed)
                    .output()
                    .map_err(|e| format!("PATH probe failed: {e}"))?;
                if !output.status.success() {
                    return Err(format!(
                        "'{}' not found on PATH. Install the CLI first and retry.",
                        trimmed
                    ));
                }
                let mut cmd = CommandBuilder::new(trimmed);
                if let Some(a) = agent {
                    cmd.arg("--agent");
                    cmd.arg(a);
                }
                Ok(cmd)
            }
        }
        "powershell" => {
            // Plain Windows PowerShell 5.1 inside the PTY. -NoLogo keeps the
            // banner away; we still want the interactive prompt so the user
            // can type commands.
            let mut cmd = CommandBuilder::new("powershell.exe");
            cmd.arg("-NoLogo");
            Ok(cmd)
        }
        "powershell-admin" => {
            // UAC elevation. We launch a *non-elevated* PowerShell whose sole
            // job is to call Start-Process -Verb RunAs on another PowerShell.
            // The elevated session necessarily opens in its own console window
            // (Windows does not let an unelevated PTY adopt an elevated child),
            // but the user gets the UAC prompt + admin shell as requested.
            let mut cmd = CommandBuilder::new("powershell.exe");
            cmd.arg("-NoLogo");
            cmd.arg("-NoProfile");
            cmd.arg("-Command");
            cmd.arg("Start-Process -Verb RunAs powershell.exe; Write-Host 'Admin PowerShell launched in a new window (UAC must run elevated outside this PTY).'");
            Ok(cmd)
        }
        other => Err(format!("unknown provider '{}'", other)),
    }
}

pub fn spawn_inner<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    card_id: Option<String>,
    provider: String,
    agent: Option<String>,
    cwd: String,
    _prompt: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    // Build the command. provider is one of:
    //   claude / codex / gemini  — AI CLI providers
    //   powershell               — plain Windows PowerShell 5.1 PTY
    //   powershell-admin         — UAC-elevated PowerShell (new window)
    // agent maps to `--agent <slug>` when supported (claude). prompt is
    // reserved for P4 (clipboard prime flow); not embedded in the command line.
    let mut cmd = build_command(&provider, agent.as_deref())?;
    cmd.cwd(&cwd);

    // Inherit env so OAuth tokens / PATH carry over.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    // Force xterm-256color so TUIs (Claude, Codex, Gemini) render the
    // box-drawing characters + ANSI sequences they rely on. The Control
    // Center process's TERM is typically empty on Windows, which causes
    // some CLIs to fall back to a dumb mode where the UI never paints.
    // COLORTERM lets the TUIs opt into 24-bit colour where supported.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {provider}: {e}"))?;
    drop(pair.slave); // child holds it now

    let master = pair.master;
    let mut reader = master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    let id = new_ulid();
    let session = PtySession {
        id: id.clone(),
        project_id: project_id.clone(),
        card_id: card_id.clone(),
        provider: provider.clone(),
        started_at: now_iso(),
        status: PtyStatus::Running,
        master,
        writer,
        child,
    };

    {
        let mut reg = registry().lock().map_err(|e| e.to_string())?;
        reg.insert(id.clone(), session);
    }

    // Reader thread: pump stdout/stderr chunks to the frontend.
    let app_for_reader = app.clone();
    let id_for_reader = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let engine = base64::engine::general_purpose::STANDARD;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = engine.encode(&buf[..n]);
                    let _ = app_for_reader.emit(
                        &format!("pty:data:{id_for_reader}"),
                        serde_json::json!({ "data": chunk }),
                    );
                }
                Err(_) => break,
            }
        }
        // Reader EOF → wait for child to exit, then emit pty:exit.
        let exit_code = {
            let mut reg = registry().lock().ok();
            match reg.as_mut() {
                Some(reg) => match reg.get_mut(&id_for_reader) {
                    Some(s) => match s.child.wait() {
                        Ok(status) => {
                            let code = status.exit_code() as i32;
                            s.status = PtyStatus::Exited(code);
                            code
                        }
                        Err(_) => {
                            s.status = PtyStatus::Killed;
                            -1
                        }
                    },
                    None => -1,
                },
                None => -1,
            }
        };
        let _ = app_for_reader.emit(
            &format!("pty:exit:{id_for_reader}"),
            serde_json::json!({ "exit_code": exit_code }),
        );
    });

    Ok(id)
}

pub fn write_inner(session_id: String, data_b64: String) -> Result<(), String> {
    let engine = base64::engine::general_purpose::STANDARD;
    let bytes = engine
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    let mut reg = registry().lock().map_err(|e| e.to_string())?;
    let s = reg
        .get_mut(&session_id)
        .ok_or_else(|| format!("session {session_id} not found"))?;
    s.writer
        .write_all(&bytes)
        .map_err(|e| format!("write: {e}"))?;
    Ok(())
}

pub fn resize_inner(session_id: String, rows: u16, cols: u16) -> Result<(), String> {
    let reg = registry().lock().map_err(|e| e.to_string())?;
    let s = reg
        .get(&session_id)
        .ok_or_else(|| format!("session {session_id} not found"))?;
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

pub fn kill_inner(session_id: String) -> Result<(), String> {
    let mut reg = registry().lock().map_err(|e| e.to_string())?;
    let s = reg
        .get_mut(&session_id)
        .ok_or_else(|| format!("session {session_id} not found"))?;
    let _ = s.child.kill();
    s.status = PtyStatus::Killed;
    Ok(())
}

pub fn list_inner(project_id: String) -> Result<Vec<PtySessionSummary>, String> {
    let reg = registry().lock().map_err(|e| e.to_string())?;
    let out: Vec<PtySessionSummary> = reg
        .values()
        .filter(|s| s.project_id == project_id)
        .map(|s| s.summary())
        .collect();
    Ok(out)
}

pub fn kill_all_inner() {
    if let Ok(mut reg) = registry().lock() {
        for s in reg.values_mut() {
            let _ = s.child.kill();
            s.status = PtyStatus::Killed;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_command_rejects_unknown_provider() {
        let r = build_command("nope", None);
        assert!(r.is_err(), "unknown provider should fail");
    }

    #[test]
    fn build_command_rejects_empty_provider() {
        let r = build_command("   ", None);
        assert!(r.is_err(), "empty provider should fail");
    }

    #[test]
    fn build_command_accepts_known_providers() {
        for p in ["claude", "codex", "gemini", "powershell", "powershell-admin"] {
            let r = build_command(p, None);
            assert!(r.is_ok(), "provider {p} should be accepted");
        }
    }
}
