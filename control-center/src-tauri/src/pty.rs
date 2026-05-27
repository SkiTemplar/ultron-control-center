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
    /// Ring buffer of raw output bytes captured by the reader thread.
    ///
    /// P0 bug fix (2026-05-24): the previous build emitted `pty:data:<id>`
    /// events immediately as the PTY produced output, but the frontend
    /// `EmbeddedTerminal` registers its `listen()` *after* the React mount
    /// has finished and the Tauri IPC handshake completes (tens to hundreds
    /// of ms). The first burst of output from Claude/Codex/Gemini — the TUI
    /// splash, banner and entire initial paint — was emitted into a void:
    /// the listener wasn't subscribed yet, so the chunks were lost forever.
    /// TUIs don't periodically repaint, so the terminal stayed blank.
    ///
    /// Fix: capture every byte the reader produces into this buffer and
    /// HOLD live emission until the frontend calls `pty_replay`. The
    /// replay call returns the buffered bytes and flips `subscribed=true`,
    /// after which the reader thread starts emitting `pty:data:<id>`
    /// events in real time. This way there is exactly one path bytes can
    /// reach the frontend — first as replay, then as live events — with
    /// no duplication and no loss. Capped at 256 KiB to bound memory;
    /// older bytes are dropped from the front when full.
    pub output_buffer: Vec<u8>,
    /// Has the frontend subscribed via `pty_replay`? While false, the
    /// reader thread captures bytes into `output_buffer` but does NOT
    /// emit `pty:data:<id>` events. Once true, the reader switches to
    /// live emission for every subsequent chunk.
    pub subscribed: bool,
}

const PTY_REPLAY_BUFFER_MAX: usize = 256 * 1024;

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

/// Resolve a caller-supplied `cwd` string to an absolute, existing directory.
///
/// P0 bug fix (2026-05-27): the frontend now passes the project's absolute path
/// (from `ProjectInfo.path`) instead of `"."`. The old `"."` was sensitive to
/// the Tauri process working directory which on Windows defaults to
/// `C:\Windows\System32`, causing every spawned session to open there instead
/// of the project folder.
///
/// `portable-pty` forwards the `cwd` string verbatim into `CreateProcessW`, so
/// any relative path is interpreted relative to the Tauri process — not the
/// user's project. This function normalises the path and provides safe fallbacks
/// in case the supplied path no longer exists (e.g. unmounted network drive).
///
/// Resolution order:
///   1. If `cwd` is a valid existing directory, canonicalise + return it.
///   2. Otherwise fall back to the user's home directory.
///   3. Otherwise fall back to the SystemDrive root (Windows) or `/`.
fn resolve_cwd(cwd: &str) -> String {
    use std::path::Path;
    let trimmed = cwd.trim();
    if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
        if let Ok(canon) = std::fs::canonicalize(trimmed) {
            // dunce-style: strip the Windows \\?\ prefix if present so the
            // path is friendlier inside the shell prompt.
            let s = canon.to_string_lossy().to_string();
            return s.trim_start_matches(r"\\?\").to_string();
        }
        return trimmed.to_string();
    }
    if let Some(home) = dirs::home_dir() {
        if home.is_dir() {
            return home.to_string_lossy().to_string();
        }
    }
    #[cfg(windows)]
    {
        std::env::var("SystemDrive")
            .map(|d| format!("{d}\\"))
            .unwrap_or_else(|_| "C:\\".to_string())
    }
    #[cfg(not(windows))]
    {
        "/".to_string()
    }
}

/// Append a single line to `~/.ultron/logs/pty-spawn.log` describing a PTY
/// spawn failure. Best-effort — if the log directory cannot be created we
/// silently drop the entry; the user already sees the propagated error in
/// the UI via the returned `Result<_, String>`.
fn log_pty_failure(provider: &str, cwd: &str, msg: &str) {
    let dir = match dirs::home_dir() {
        Some(h) => h.join(".ultron").join("logs"),
        None => return,
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("pty-spawn.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = writeln!(
            f,
            "[{}] provider={} cwd={} :: {}",
            now_iso(),
            provider,
            cwd,
            msg
        );
    }
}

/// Resolve which PowerShell executable to spawn into the PTY.
///
/// Preference order on Windows:
///   1. `pwsh.exe` (PowerShell 7+) if it resolves on PATH.
///   2. `powershell.exe` if it resolves on PATH.
///   3. Absolute fallback to `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`.
///
/// We never return an error here — if all probes fail, the absolute
/// System32 path is returned. portable-pty will surface a clear spawn
/// failure if that path is also missing (extremely unlikely on Windows).
#[cfg(windows)]
fn resolve_powershell_exe() -> String {
    fn on_path(exe: &str) -> bool {
        use std::os::windows::process::CommandExt;
        let mut probe = std::process::Command::new("where");
        probe.arg(exe);
        probe.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        match probe.output() {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    }
    if on_path("pwsh.exe") {
        return "pwsh.exe".to_string();
    }
    if on_path("powershell.exe") {
        return "powershell.exe".to_string();
    }
    // Absolute fallback. SystemRoot is virtually always set on Windows.
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    format!(
        "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        system_root.trim_end_matches('\\')
    )
}

#[cfg(not(windows))]
fn resolve_powershell_exe() -> String {
    // PowerShell on non-Windows is `pwsh`; build_command never reaches here
    // on those platforms because the provider list is Windows-only, but we
    // keep the helper compiling for cargo check / cross-target builds.
    "pwsh".to_string()
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
            // Plain Windows PowerShell PTY.
            //
            // v2.6.1 P0 bug fix: the previous build called
            //     CommandBuilder::new("powershell.exe").arg("-NoLogo")
            // which left the user's PowerShell profile enabled. A profile that
            // loads oh-my-posh, posh-git, PSReadLine custom prompts, or any
            // module with network/auth side-effects (Azure / AWS / GitHub) can
            // block startup for 5-30s — to the user the PTY just "stays
            // hanging without opening anything", exactly the reported P0 bug.
            //
            // Fix:
            //   1. Add -NoProfile so user-level profiles do not run inside the
            //      embedded PTY. Power users can still run `& $PROFILE` once
            //      the shell is up if they want their profile loaded.
            //   2. Prefer pwsh.exe (PowerShell 7) when on PATH — it's faster
            //      to start and renders modern TUIs better. Fall back to
            //      powershell.exe (Windows PowerShell 5.1).
            //   3. If neither shim is on PATH, fall back to the absolute
            //      System32 path so a corrupted PATH does not break the
            //      terminal entirely.
            let exe = resolve_powershell_exe();
            let mut cmd = CommandBuilder::new(&exe);
            cmd.arg("-NoLogo");
            cmd.arg("-NoProfile");
            Ok(cmd)
        }
        "powershell-admin" => {
            // UAC elevation. We launch a *non-elevated* PowerShell whose sole
            // job is to call Start-Process -Verb RunAs on another PowerShell.
            // The elevated session necessarily opens in its own console window
            // (Windows does not let an unelevated PTY adopt an elevated child),
            // but the user gets the UAC prompt + admin shell as requested.
            //
            // v2.6.1: also -NoProfile + resolved exe for the same reasons as
            // the plain `powershell` branch.
            let exe = resolve_powershell_exe();
            let mut cmd = CommandBuilder::new(&exe);
            cmd.arg("-NoLogo");
            cmd.arg("-NoProfile");
            cmd.arg("-Command");
            cmd.arg("try { Start-Process -Verb RunAs powershell.exe -ArgumentList '-NoLogo' -ErrorAction Stop; Write-Host 'Admin PowerShell launched in a new window. (UAC opens elevated consoles outside the embedded PTY.)' } catch { Write-Host ('Admin launch failed: ' + $_.Exception.Message) -ForegroundColor Red }");
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
    let mut cmd = build_command(&provider, agent.as_deref()).map_err(|e| {
        log_pty_failure(&provider, &cwd, &format!("build_command: {e}"));
        e
    })?;
    // All Claude sessions run with --dangerously-skip-permissions by default.
    // Opt out via claude_safe_mode=true in ~/.ultron/cockpit/features.json.
    if provider == "claude" {
        let safe_mode = crate::features::read_features_inner().claude_safe_mode;
        if !safe_mode {
            cmd.arg("--dangerously-skip-permissions");
        }
    }
    // Resolve cwd to an absolute path. The frontend now passes the project's
    // absolute path (ProjectInfo.path); the resolve_cwd helper canonicalises it
    // and provides safe fallbacks (home dir → SystemDrive root) in case the
    // directory no longer exists. This replaced the old "." default that caused
    // sessions to open in C:\Windows\System32 on Windows (P0 bug 2026-05-27).
    let resolved_cwd = resolve_cwd(&cwd);
    cmd.cwd(&resolved_cwd);

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

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        let msg = format!("spawn {provider}: {e}");
        log_pty_failure(&provider, &resolved_cwd, &msg);
        msg
    })?;
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
        output_buffer: Vec::with_capacity(8 * 1024),
        subscribed: false,
    };

    {
        let mut reg = registry().lock().map_err(|e| e.to_string())?;
        reg.insert(id.clone(), session);
    }

    // Reader thread: pump stdout/stderr chunks to the frontend.
    //
    // Every chunk is also appended to the session's output_buffer so that
    // `pty_replay` can hand back the early output if the frontend listener
    // subscribed after the chunk was emitted (see PtySession docs above).
    let app_for_reader = app.clone();
    let id_for_reader = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let engine = base64::engine::general_purpose::STANDARD;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let slice = &buf[..n];
                    // Capture for replay (ring-buffer trim if oversized) and
                    // check whether the frontend has subscribed yet. If not,
                    // we capture but do NOT emit — the bytes will be handed
                    // back via pty_replay when the listener registers. This
                    // is the canonical fix for the listen-after-emit race.
                    let subscribed_now = {
                        match registry().lock() {
                            Ok(mut reg) => {
                                if let Some(s) = reg.get_mut(&id_for_reader) {
                                    s.output_buffer.extend_from_slice(slice);
                                    if s.output_buffer.len() > PTY_REPLAY_BUFFER_MAX {
                                        let drop_n =
                                            s.output_buffer.len() - PTY_REPLAY_BUFFER_MAX;
                                        s.output_buffer.drain(0..drop_n);
                                    }
                                    s.subscribed
                                } else {
                                    false
                                }
                            }
                            Err(_) => false,
                        }
                    };
                    if subscribed_now {
                        let chunk = engine.encode(slice);
                        let _ = app_for_reader.emit(
                            &format!("pty:data:{id_for_reader}"),
                            serde_json::json!({ "data": chunk }),
                        );
                    }
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

/// Return the buffered output captured by the reader thread, base64-encoded,
/// AND flip the `subscribed` flag so the reader starts emitting live events.
///
/// Called by the frontend `EmbeddedTerminal` immediately after its
/// `pty:data:<id>` listener registers. The transition from "buffered" to
/// "live" happens under the registry mutex so no chunk can be lost or
/// duplicated: the reader thread either captures a chunk before this call
/// (in which case it's in the returned buffer and not emitted) or after this
/// call (in which case it's not in the buffer but is emitted as a live event).
///
/// Returns an empty string if the session is unknown (already exited and
/// pruned, etc.) so the caller can no-op without surfacing a misleading error.
pub fn replay_inner(session_id: String) -> Result<String, String> {
    let mut reg = registry().lock().map_err(|e| e.to_string())?;
    let s = match reg.get_mut(&session_id) {
        Some(s) => s,
        None => return Ok(String::new()),
    };
    let engine = base64::engine::general_purpose::STANDARD;
    let encoded = engine.encode(&s.output_buffer);
    s.subscribed = true;
    Ok(encoded)
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
