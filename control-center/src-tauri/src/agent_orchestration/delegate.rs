// agent_orchestration/delegate.rs — task delegation core logic.
//
// Provides the synchronous (wait-for-completion) and fire-and-forget
// delegation paths, plus the input-validation and ANSI-stripping helpers
// they share.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;

use crate::sessions::{self, SpawnFlags, SpawnResult};

use super::delegation_log::{log_delegation, now_secs_safe, truncate};
use super::provider_router;
use super::types::{DelegateRequest, DelegateTaskResult, DelegationLogEntry};

// ---------------------------------------------------------------------------
// Completion sentinel & timing constants
// ---------------------------------------------------------------------------

/// Token that agents print to signal normal completion of a delegated task.
///
/// Agents must emit this on its own line, e.g.:
///   printf '\n[AGENT TASK COMPLETE]\n'
///
/// The poll loop strips ANSI escape codes before scanning so terminal colour
/// sequences around the token do not prevent detection.
pub const COMPLETION_SENTINEL: &str = "[AGENT TASK COMPLETE]";

/// Default poll timeout in seconds. Overridable per-request via
/// `DelegateRequest.timeout_secs`. 300 s (5 min) is long enough for a
/// medium `cargo test --workspace` run but short enough to surface hangs.
pub const DEFAULT_DELEGATE_TIMEOUT_SECS: u64 = 300;

/// Poll interval in milliseconds. 2 s gives sub-3-s detection latency
/// while keeping the registry-mutex contention negligible.
const POLL_INTERVAL_MS: u64 = 2_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Strip ANSI/VT100 escape sequences and return printable UTF-8 text.
///
/// Handles the most common CSI sequences (ESC `[` … final-byte) and plain
/// two-byte ESC sequences. No external crate dependency — the scan is a
/// simple linear state machine.
pub fn strip_ansi(raw: &[u8]) -> String {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == 0x1b {
            i += 1;
            if i < raw.len() {
                if raw[i] == b'[' {
                    // CSI: skip until a byte in 0x40–0x7E (final byte).
                    i += 1;
                    while i < raw.len() && !(0x40..=0x7e).contains(&raw[i]) {
                        i += 1;
                    }
                    i += 1; // consume final byte
                } else {
                    // Two-byte sequence (ESC =, ESC >, etc.)
                    i += 1;
                }
            }
        } else {
            out.push(raw[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Lightweight model hint picked by the UI when the user opts into the
/// "use cheap model" checkbox. We map this to a concrete Claude CLI
/// `--model` flag here so the frontend stays agnostic about which model
/// IDs are valid at any given time.
/// Resolve the cheap model id from the AI Router's `light` zone primary, so
/// the cheap delegation path follows the same config as the rest of the system
/// instead of a hardcoded literal. Falls back to Haiku 4.5 (the historical
/// default) when zones are unreadable, preserving prior behaviour.
#[cfg_attr(not(test), allow(dead_code))]
pub fn resolve_cheap_model() -> String {
    crate::ai_router::primary_model_for_zone("light")
        .unwrap_or_else(|| "claude-haiku-4-5".to_string())
}

pub fn validate_agent_slug(slug: &str) -> Result<(), String> {
    if slug.len() > 80 {
        return Err("agent slug too long".to_string());
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(format!(
            "agent slug '{}' contains invalid characters (allowed: a-z 0-9 - _)",
            slug
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Core delegation paths
// ---------------------------------------------------------------------------

/// Delegate a task to an agent via PTY and **wait** for completion.
///
/// This is the real hand-off contract for `ultron-orchestrator`:
///
/// 1. Spawns a PTY session running `claude --agent <slug> -p <task>`.
/// 2. Polls the session's `output_buffer` every 2 s looking for the
///    completion sentinel `[AGENT TASK COMPLETE]` on any line.
/// 3. Returns `Ok(DelegateTaskResult)` with the full captured output when
///    the sentinel is found.
/// 4. If the timeout elapses before the sentinel, kills the PTY and returns
///    `Err("timeout — partial output: ...")` containing whatever was
///    captured so the caller can pass it to a `debugger` fallback.
///
/// The legacy `SpawnResult`-returning fire-and-forget path is preserved as
/// `delegate_task_fire_and_forget` for callers that do not need the output
/// (e.g. the UI "Launch agent" button).
pub async fn delegate_task_inner(
    app: &tauri::AppHandle,
    req: DelegateRequest,
) -> Result<DelegateTaskResult, String> {
    let agent_trim = req.agent.trim();
    if agent_trim.is_empty() {
        return Err("agent slug is empty".to_string());
    }
    validate_agent_slug(agent_trim)?;
    let task = req.task.trim();
    if task.is_empty() {
        return Err("task description is empty".to_string());
    }
    if task.len() > 16_000 {
        return Err("task description exceeds 16KB ceiling".to_string());
    }

    // Resolve timeout — clamp to 1 hour ceiling, default 300 s.
    let timeout_secs = match req.timeout_secs {
        Some(0) | None => DEFAULT_DELEGATE_TIMEOUT_SECS,
        Some(n) => n.min(3_600),
    };
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);

    let project_id = req
        .project_id
        .clone()
        .unwrap_or_else(|| "orchestrator".to_string());

    // Tell the agent it MUST print the sentinel when done.
    let full_prompt = format!(
        "{task}\n\n\
         ---\n\
         When you have fully completed the task above, print the following \
         token on its own line as the very last line of your response:\n\
         {COMPLETION_SENTINEL}"
    );

    // Multi-IA dispatch: pick the correct agentic CLI for this agent WITHOUT
    // the user asking. Fall back HARD to Claude when the chosen CLI is not
    // installed, so a missing codex binary never breaks delegation (zero
    // observable change when the router cannot improve on Claude).
    let chosen = provider_router::infer_pty_provider(agent_trim);
    let provider = if chosen == provider_router::PtyProvider::Claude
        || crate::pty::cli_on_path(chosen.as_str())
    {
        chosen.as_str()
    } else {
        "claude" // hard fallback — preserves current behaviour exactly
    };

    use tauri::Emitter;
    let _ = app.emit(
        "workflow:delegating",
        serde_json::json!({
            "agent": agent_trim,
            "task_preview": truncate(task, 160),
            "use_cheap_model": req.use_cheap_model,
            "provider": provider, // claude | codex
            "started_at": crate::activity_timeline::epoch_secs_to_iso(now_secs_safe()),
            "timeout_secs": timeout_secs,
        }),
    );

    // -----------------------------------------------------------------------
    // Spawn the PTY session directly via pty::spawn_inner so we get a
    // session_id we can poll. sessions::spawn_session_inner goes through
    // wt.exe (new terminal window) which we cannot read back from.
    // -----------------------------------------------------------------------
    let session_id = crate::pty::spawn_inner(
        app.clone(),
        project_id.clone(),
        None,                 // card_id
        provider.to_string(), // was hardcoded "claude"
        Some(agent_trim.to_string()),
        req.cwd.clone().unwrap_or_default(),
        Some(full_prompt),
    )?;

    let start = Instant::now();

    // Write the prompt text to the PTY stdin so Claude picks it up.
    // We encode it as UTF-8 bytes terminated by \n (Enter).
    {
        let engine = base64::engine::general_purpose::STANDARD;
        let mut payload = task.replace('\r', "").into_bytes();
        payload.push(b'\n');
        let b64 = engine.encode(&payload);
        // Best-effort: if write fails the poll loop will still time out
        // cleanly rather than panicking.
        let _ = crate::pty::write_inner(session_id.clone(), b64);
    }

    // -----------------------------------------------------------------------
    // Poll loop
    // -----------------------------------------------------------------------
    let mut offset: usize = 0;
    let mut completed_normally = false;
    let mut exit_code: Option<i32> = None;

    loop {
        // Sleep first so the agent has time to start up before the first check.
        std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));

        let capture = crate::pty::capture_output_inner(&session_id, offset)?;
        offset = capture.new_offset;

        // Check whether the session has already exited.
        if let Some(ref status) = capture.session_status {
            match status {
                crate::pty::PtyStatus::Exited(code) => {
                    exit_code = Some(*code);
                }
                crate::pty::PtyStatus::Killed => {
                    exit_code = None;
                }
                crate::pty::PtyStatus::Running => {}
            }
        }

        // Decode the accumulated buffer from offset 0 for sentinel scan.
        // We re-read from the beginning to handle the case where the sentinel
        // spans a poll boundary, but we only decode the new chunk for
        // efficiency — the sentinel is always printed as a complete line.
        if !capture.data_b64.is_empty() {
            let engine = base64::engine::general_purpose::STANDARD;
            if let Ok(new_bytes) = engine.decode(&capture.data_b64) {
                let text = strip_ansi(&new_bytes);
                if text.contains(COMPLETION_SENTINEL) {
                    completed_normally = true;
                    break;
                }
            }
        }

        // If the process exited normally (exit 0) without the sentinel,
        // treat it as complete to avoid blocking forever on well-behaved
        // agents that forgot to print the token.
        if matches!(exit_code, Some(0)) {
            completed_normally = true;
            break;
        }

        // Check timeout.
        if Instant::now() >= deadline {
            // Kill the session so it doesn't linger.
            let _ = crate::pty::kill_inner(session_id.clone());
            break;
        }
    }

    let duration_ms = start.elapsed().as_millis() as u64;

    // Collect the full output accumulated in the buffer.
    let full_capture = crate::pty::capture_output_inner(&session_id, 0)?;
    let engine = base64::engine::general_purpose::STANDARD;
    let raw_bytes = engine.decode(&full_capture.data_b64).unwrap_or_default();
    let output = strip_ansi(&raw_bytes);

    let _ = app.emit(
        "workflow:delegated",
        serde_json::json!({
            "agent": agent_trim,
            "status": if completed_normally { "done" } else { "timeout" },
            "task_preview": truncate(task, 160),
            "duration_ms": duration_ms,
        }),
    );

    // Delegation log (append-only JSONL).
    let id_nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_micros() % 10_000)
        .unwrap_or(0);
    let log_status = if completed_normally {
        "done"
    } else {
        "timeout"
    };
    if let Err(e) = log_delegation(DelegationLogEntry {
        id: format!("dl-{}-{:04}", now_secs_safe(), id_nonce),
        agent: agent_trim.to_string(),
        task_preview: truncate(task, 200),
        cwd: req.cwd.clone(),
        used_cheap_model: req.use_cheap_model,
        started_at: crate::activity_timeline::epoch_secs_to_iso(now_secs_safe()),
        status: log_status.to_string(),
        session_id: Some(session_id.clone()),
    }) {
        eprintln!("[agent_orchestration] log_delegation failed: {e}");
    }

    if completed_normally {
        Ok(DelegateTaskResult {
            output,
            exit_code,
            duration_ms,
            completed_normally: true,
        })
    } else {
        // Return Err with partial output so the orchestrator can escalate.
        let preview = truncate(&output, 500);
        Err(format!(
            "timeout after {timeout_secs}s — partial output: {preview}"
        ))
    }
}

/// Fire-and-forget delegation: spawns a session via wt.exe and returns
/// immediately without waiting for the agent to finish.  Retained for
/// future re-wiring; the `delegate_task_launch` Tauri command was
/// removed (cat10, 2026-06-19) pending a live frontend invoke().
#[allow(dead_code)]
pub async fn delegate_task_fire_and_forget(
    app: &tauri::AppHandle,
    req: DelegateRequest,
) -> Result<SpawnResult, String> {
    let agent_trim = req.agent.trim();
    if agent_trim.is_empty() {
        return Err("agent slug is empty".to_string());
    }
    validate_agent_slug(agent_trim)?;
    let task = req.task.trim();
    if task.is_empty() {
        return Err("task description is empty".to_string());
    }
    if task.len() > 16_000 {
        return Err("task description exceeds 16KB ceiling".to_string());
    }

    let mut flags = SpawnFlags {
        agent: Some(agent_trim.to_string()),
        ..Default::default()
    };
    if req.use_cheap_model {
        flags.model = Some(resolve_cheap_model());
    }
    let cwd_for_log = req.cwd.clone();

    use tauri::Emitter;
    let _ = app.emit(
        "workflow:delegating",
        serde_json::json!({
            "agent": agent_trim,
            "task_preview": truncate(task, 160),
            "use_cheap_model": req.use_cheap_model,
            "started_at": crate::activity_timeline::epoch_secs_to_iso(now_secs_safe()),
        }),
    );

    let result = sessions::spawn_session_inner(
        app,
        "claude".to_string(),
        Some(task.to_string()),
        req.cwd,
        Some(flags),
    )
    .await;

    let _ = app.emit(
        "workflow:delegated",
        serde_json::json!({
            "agent": agent_trim,
            "status": if result.is_ok() { "launched" } else { "failed" },
            "task_preview": truncate(task, 160),
        }),
    );

    let status = if result.is_ok() { "launched" } else { "failed" };
    let id_nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_micros() % 10_000)
        .unwrap_or(0);
    if let Err(e) = log_delegation(DelegationLogEntry {
        id: format!("dl-{}-{:04}", now_secs_safe(), id_nonce),
        agent: agent_trim.to_string(),
        task_preview: truncate(task, 200),
        cwd: cwd_for_log,
        used_cheap_model: req.use_cheap_model,
        started_at: crate::activity_timeline::epoch_secs_to_iso(now_secs_safe()),
        status: status.to_string(),
        session_id: None,
    }) {
        eprintln!("[agent_orchestration] log_delegation failed: {e}");
    }

    result
}
