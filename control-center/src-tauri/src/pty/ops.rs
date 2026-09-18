// pty/ops.rs — Session lifecycle operations: spawn, write, kill, capture.

use base64::Engine;
use portable_pty::{native_pty_system, PtySize};
use std::io::{Read, Write};
use std::thread;
use tauri::{AppHandle, Emitter, Runtime};

use super::registry::{new_ulid, now_iso, registry};
use super::spawn::{build_command, log_pty_failure, resolve_cwd};
use super::types::{PtySession, PtyStatus, PTY_REPLAY_BUFFER_MAX};

pub fn spawn_inner<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    card_id: Option<String>,
    provider: String,
    agent: Option<String>,
    cwd: String,
    _prompt: Option<String>,
    // extra_args: argumentos adicionales para la CLI (p. ej. `--model opus`).
    // Vacio para los llamantes que no eligen modelo.
    extra_args: Vec<String>,
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
    //   claude / codex  — AI CLI providers
    //   powershell      — plain Windows PowerShell 5.1 PTY
    //   powershell-admin         — UAC-elevated PowerShell (new window)
    // agent maps to `--agent <slug>` when supported (claude). prompt is
    // reserved for P4 (clipboard prime flow); not embedded in the command line.
    let mut cmd = build_command(&provider, agent.as_deref()).map_err(|e| {
        log_pty_failure(&provider, &cwd, &format!("build_command: {e}"));
        e
    })?;
    for a in &extra_args {
        cmd.arg(a);
    }
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
    // Force xterm-256color so TUIs (Claude, Codex) render the
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

    // Reader thread: capture stdout/stderr chunks into the session buffer.
    //
    // Every chunk is appended to the session's output_buffer, which is the
    // source `capture_output_inner` polls (delegate flow). With the embedded
    // terminal retired nothing flips `subscribed` anymore, so the live
    // `pty:data:<id>` emit below never fires (kept for the buffer/emit
    // handoff structure documented in PtySession).
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
                    // Capture into the ring buffer (trim if oversized) and
                    // check the `subscribed` flag. While false — always,
                    // since the embedded terminal was retired — we capture
                    // but do NOT emit; consumers poll the buffer via
                    // capture_output_inner instead.
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

// ---------------------------------------------------------------------------
// Terminal embebida de mar.ia (2026-09-18)
// ---------------------------------------------------------------------------
//
// `write_inner`/`kill_inner` se retiraron en 2026-09-14 al quedarse sin
// consumidor. Vuelven — reescritos, no copiados — porque ahora SI hay
// interfaz: la pestana "Terminales" de mar.ia, que el usuario pidio para
// lanzar claude/codex/gemini dentro de la aplicacion en vez de en consolas
// sueltas. `subscribe_inner` es nuevo: enciende la emision en vivo y devuelve
// lo ya capturado, para que al volver a la pestana el terminal no aparezca en
// blanco.

/// Escribe en el PTY (tecleado del usuario).
pub fn write_inner(id: &str, data: &[u8]) -> Result<(), String> {
    let mut reg = registry().lock().map_err(|e| e.to_string())?;
    let s = reg.get_mut(id).ok_or("sesion de terminal no encontrada")?;
    s.writer
        .write_all(data)
        .and_then(|()| s.writer.flush())
        .map_err(|e| format!("escribir en el terminal: {e}"))
}

/// Ajusta el tamano del PTY. Sin esto, las TUIs (Claude, Codex) pintan sobre
/// una rejilla de 120x30 fija y el texto se parte al redimensionar la ventana.
pub fn resize_inner(id: &str, rows: u16, cols: u16) -> Result<(), String> {
    if rows == 0 || cols == 0 {
        return Err("tamano de terminal invalido".into());
    }
    let reg = registry().lock().map_err(|e| e.to_string())?;
    let s = reg.get(id).ok_or("sesion de terminal no encontrada")?;
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("redimensionar: {e}"))
}

/// Enciende la emision en vivo y devuelve en base64 lo capturado hasta ahora.
pub fn subscribe_inner(id: &str) -> Result<String, String> {
    let mut reg = registry().lock().map_err(|e| e.to_string())?;
    let s = reg.get_mut(id).ok_or("sesion de terminal no encontrada")?;
    s.subscribed = true;
    Ok(base64::engine::general_purpose::STANDARD.encode(&s.output_buffer))
}

/// Mata una sesion y la saca del registro.
pub fn kill_inner(id: &str) -> Result<(), String> {
    let mut reg = registry().lock().map_err(|e| e.to_string())?;
    let mut s = reg.remove(id).ok_or("sesion de terminal no encontrada")?;
    let _ = s.child.kill();
    s.status = PtyStatus::Killed;
    Ok(())
}

/// Sesiones vivas, para repintar las pestanas tras recargar la interfaz.
pub fn list_inner() -> Vec<(String, String, bool)> {
    let Ok(reg) = registry().lock() else {
        return Vec::new();
    };
    reg.values()
        .map(|s| {
            (
                s.id.clone(),
                s.provider.clone(),
                matches!(s.status, PtyStatus::Running),
            )
        })
        .collect()
}
