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

    // Build the command. provider is `claude|codex|gemini`. agent maps to
    // `--agent <slug>` when supported (claude). prompt is reserved for P4
    // (clipboard prime flow); not embedded in the command line.
    let mut cmd = CommandBuilder::new(&provider);
    if let Some(a) = agent.as_deref() {
        cmd.arg("--agent");
        cmd.arg(a);
    }
    cmd.cwd(&cwd);

    // Inherit env so OAuth tokens / PATH carry over.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }

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
