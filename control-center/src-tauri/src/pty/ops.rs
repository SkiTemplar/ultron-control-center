// pty/ops.rs — Session lifecycle operations: spawn, write, resize, kill, replay, capture, list.

use base64::Engine;
use portable_pty::{native_pty_system, PtySize};
use std::io::{Read, Write};
use std::thread;
use tauri::{AppHandle, Emitter, Runtime};

use super::registry::{new_ulid, now_iso, registry};
use super::spawn::{build_command, log_pty_failure, resolve_cwd};
use super::types::{
    CaptureResult, PtySession, PtySessionSummary, PtyStatus, PTY_REPLAY_BUFFER_MAX,
};

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
                                        let drop_n = s.output_buffer.len() - PTY_REPLAY_BUFFER_MAX;
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

        // card-vis-notif-session-error: surface an immediate alert + toast when
        // a session exits with an error code. Reuses the existing toast_emit
        // pipeline (alerts.jsonl append + native toast on critical, rate-limited
        // + user-toggleable). Gated by the errors_immediate_notify feature flag.
        if should_notify_session_error(
            exit_code,
            crate::features::read_features_inner().errors_immediate_notify,
        ) {
            crate::toast_emit::record_alert_and_maybe_toast(
                &app_for_reader,
                &format!("session:{id_for_reader}"),
                "critical",
                &format!("La sesion termino con error (codigo {exit_code})"),
            );
        }
    });

    Ok(id)
}

/// Whether a PTY exit warrants an error notification. Only genuine non-zero
/// process exits (`code > 0`) qualify — a manual kill or `wait()` failure maps
/// to `-1` and must NOT nag the user — and only when the user toggle is on.
/// card-vis-notif-session-error.
pub(super) fn should_notify_session_error(exit_code: i32, enabled: bool) -> bool {
    enabled && exit_code > 0
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

/// Return raw output bytes from `since_offset` to the current end of the
/// session's `output_buffer`, base64-encoded.
///
/// This is the deterministic polling primitive for `delegate_task_inner`:
/// the caller snapshots the current buffer length, spawns the PTY, then
/// periodically calls this function with the previous snapshot as
/// `since_offset`. This gives a strictly monotone window of new bytes
/// without locking the whole session for the duration of the agent run.
///
/// Behaviour:
/// - `since_offset == 0` → return the full buffer (initial poll or replay).
/// - `since_offset >= buffer.len()` → return an empty string (no new bytes).
/// - Unknown session → return an empty string (already exited / pruned).
///
/// The returned string is base64-encoded raw PTY output (including ANSI
/// escape codes). Callers that need plain text should strip ANSI sequences
/// before inspecting the content.
pub fn capture_output_inner(
    session_id: &str,
    since_offset: usize,
) -> Result<CaptureResult, String> {
    let reg = registry().lock().map_err(|e| e.to_string())?;
    let s = match reg.get(session_id) {
        Some(s) => s,
        None => {
            return Ok(CaptureResult {
                data_b64: String::new(),
                new_offset: since_offset,
                session_status: None,
            })
        }
    };
    let buf = &s.output_buffer;
    let start = since_offset.min(buf.len());
    let slice = &buf[start..];
    let engine = base64::engine::general_purpose::STANDARD;
    Ok(CaptureResult {
        data_b64: engine.encode(slice),
        new_offset: buf.len(),
        session_status: Some(s.status.clone()),
    })
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

/// Summary of a single session by id (no project filter). Used by the embedded
/// terminal to show the active-CLI badge (card-vis-cli-model-indicator). Returns
/// None when the id is unknown.
pub fn list_one_inner(session_id: &str) -> Option<PtySessionSummary> {
    let reg = registry().lock().ok()?;
    reg.get(session_id).map(|s| s.summary())
}
