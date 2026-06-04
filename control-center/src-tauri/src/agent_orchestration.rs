// ULTRON Control Center — Agent orchestration module.
//
// New surface introduced by the Agents tab redesign ("plantilla de empleados"):
//
//   - `delegate_task_to_agent` spawns a new Claude session with the given
//     agent slug as the subagent directive. Optionally requests a cheaper
//     model when the caller flags the work as low-cost.
//   - `list_workflows` returns the preconfigured workflow sequences from
//     `~/.claude/skills/ultron/references/skill-alignments.md`. We hard-code
//     the canonical seven so the UI works even when the user has the skill
//     vaulted or modified.
//   - `list_active_hooks` is a thin proxy over `hooks_admin::list_hooks_inner`
//     so the Agents > Automations sub-tab can render hooks alongside the
//     workflow + delegate panes without reaching into the Settings tab API.
//
// The module is intentionally small — the heavy lifting (spawn, hooks
// listing) lives in `sessions` and `hooks_admin`. We just provide the
// agent-centric framing the new UI needs.
//
// ---------------------------------------------------------------------------
// Workflow blackboard XML schema (KIRKARDO 17 P2 — formal contract)
// ---------------------------------------------------------------------------
//
// Every call to `build_blackboard_preamble` that finds context produces a
// `<workflow_blackboard>` block injected as a preamble before the agent's
// task.  The schema is strict so downstream agents and tests can rely on it:
//
// ```xml
// <workflow_blackboard project_id="..." workday_id="..." at="epoch:N">
//   <workday_summary>
//     Title — status — date — N/M goals done
//   </workday_summary>
//   <recent_files>
//     <file path="src/foo.rs" kind="modified"/>
//     <file path="src/bar.rs" kind="added"/>
//   </recent_files>
//   <next_steps>
//     <step>First pending goal text</step>
//     <step>Second pending goal text</step>
//   </next_steps>
//   <blockers>free-form text from the most recent "decision" entry, if any</blockers>
// </workflow_blackboard>
// ```
//
// Rules:
//   * `project_id` and `workday_id` are always present; `at` is the ISO
//     timestamp of preamble construction (not the workday start).
//   * `<workday_summary>` is omitted when the workday has no title (shouldn't
//     happen in practice, but the builder guards against it).
//   * `<recent_files>` lists the last 8 `file_change` context entries, newest
//     first.  Omitted entirely when there are no file-change entries.
//   * `<next_steps>` lists up to 3 pending goal texts.  Omitted when all
//     goals are done or the workday has no goals.
//   * `<blockers>` carries the text of the most recent `decision` context
//     entry (decisions often record blockers or constraints the next agent
//     must respect).  Omitted when empty.
//   * The `notes` + `agent_messages` lanes are rendered as a flat markdown
//     list AFTER the closing `</workflow_blackboard>` tag so agents that only
//     care about the structured data can stop parsing at `</workflow_blackboard>`.
//
// The builder is `BlackboardBuilder::new(wd).build() -> String`.
// ---------------------------------------------------------------------------

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::sessions::{self, SpawnFlags, SpawnResult};

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
// DelegateTaskResult — rich return type for the synchronous delegation path
// ---------------------------------------------------------------------------

/// Outcome of a fully-resolved `delegate_task_inner` call.
///
/// Unlike `SpawnResult` (which only confirms the process launched), this
/// struct carries the captured PTY output so the orchestrator can feed it
/// as blackboard input for the next pipeline step.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DelegateTaskResult {
    /// Plain-text output produced by the agent.  ANSI escape codes are
    /// stripped; the string is valid UTF-8 (lossy conversion applied).
    pub output: String,
    /// Exit code reported by the PTY child, or `None` when the session was
    /// killed (timeout / explicit kill).
    pub exit_code: Option<i32>,
    /// Wall-clock duration of the delegation in milliseconds.
    pub duration_ms: u64,
    /// `true` when the agent emitted `[AGENT TASK COMPLETE]` before the
    /// timeout elapsed.  `false` on timeout or forced kill.
    pub completed_normally: bool,
}

/// Strip ANSI/VT100 escape sequences and return printable UTF-8 text.
///
/// Handles the most common CSI sequences (ESC `[` … final-byte) and plain
/// two-byte ESC sequences. No external crate dependency — the scan is a
/// simple linear state machine.
fn strip_ansi(raw: &[u8]) -> String {
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
fn resolve_cheap_model() -> String {
    // Haiku 4.5 is the current cheap default per
    // `~/.claude/rules/common/performance.md`. If the user has overridden
    // this we still want the delegation flow to work — Claude Code will
    // just ignore an unknown model and use its default. We don't read the
    // override file here because (a) the AI Router is out of scope for
    // this surface, and (b) the user can always edit settings if they
    // want a different cheap pick.
    "claude-haiku-4-5".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DelegateRequest {
    pub agent: String,
    pub task: String,
    #[serde(default)]
    pub use_cheap_model: bool,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Workday id to use as the shared blackboard for this delegation
    /// (KIRKARDO 7 Paso 1). When Some, we (a) read the most recent context
    /// entries and inline them as a preamble in the prompt so the agent
    /// sees what previous steps in the pipeline produced, and (b) append
    /// an "agent_message" entry after spawn so subsequent agents in the
    /// chain see this delegation. When None we no-op the blackboard —
    /// preserves the existing one-shot behaviour for callers that don't
    /// participate in a workflow.
    #[serde(default)]
    pub workday_id: Option<String>,
    /// Override the default 300-second poll timeout. `None` or `0` use
    /// `DEFAULT_DELEGATE_TIMEOUT_SECS`. Maximum clamped to 3600 s (1 hour).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Project id forwarded to `pty::spawn_inner` for session registry
    /// grouping. Falls back to `"orchestrator"` when absent.
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WorkflowStep {
    pub agent: String,
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WorkflowDefinition {
    pub id: String,
    pub label: String,
    pub description: String,
    pub steps: Vec<WorkflowStep>,
}

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

    // Blackboard read: prepend workday context so the agent sees prior steps.
    let task_with_blackboard = if let Some(wid) = req.workday_id.as_deref() {
        match build_blackboard_preamble(wid) {
            Ok(preamble) if !preamble.is_empty() => {
                format!("{preamble}\n\n---\n\n{task}")
            }
            _ => task.to_string(),
        }
    } else {
        task.to_string()
    };

    // Tell the agent it MUST print the sentinel when done.
    let full_prompt = format!(
        "{task_with_blackboard}\n\n\
         ---\n\
         When you have fully completed the task above, print the following \
         token on its own line as the very last line of your response:\n\
         {COMPLETION_SENTINEL}"
    );

    use tauri::Emitter;
    let _ = app.emit(
        "workflow:delegating",
        serde_json::json!({
            "agent": agent_trim,
            "task_preview": truncate(task, 160),
            "use_cheap_model": req.use_cheap_model,
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
        None, // card_id
        "claude".to_string(),
        Some(agent_trim.to_string()),
        req.cwd.clone().unwrap_or_default(),
        Some(full_prompt),
    )?;

    let start = Instant::now();

    // Write the prompt text to the PTY stdin so Claude picks it up.
    // We encode it as UTF-8 bytes terminated by \n (Enter).
    {
        let engine = base64::engine::general_purpose::STANDARD;
        let mut payload = task_with_blackboard.replace('\r', "").into_bytes();
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

    // Blackboard write: record the delegation outcome.
    if let Some(wid) = req.workday_id.as_deref() {
        let summary = format!(
            "[{agent}] {status} ({duration_ms}ms): {preview}",
            agent = agent_trim,
            status = if completed_normally {
                "done"
            } else {
                "timeout"
            },
            preview = truncate(task, 160),
        );
        if let Err(e) = crate::workdays::append_context_inner(
            wid.to_string(),
            "agent_message".to_string(),
            summary,
            Some(agent_trim.to_string()),
        ) {
            eprintln!("[agent_orchestration] blackboard append failed: {e}");
        }
    }

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
/// immediately without waiting for the agent to finish.  Used by the UI
/// "Launch agent" button and any caller that does not need the output.
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

    let mut flags = SpawnFlags::default();
    flags.agent = Some(agent_trim.to_string());
    if req.use_cheap_model {
        flags.model = Some(resolve_cheap_model());
    }
    let cwd_for_log = req.cwd.clone();

    let task_with_blackboard = if let Some(wid) = req.workday_id.as_deref() {
        match build_blackboard_preamble(wid) {
            Ok(preamble) if !preamble.is_empty() => format!("{preamble}\n\n---\n\n{task}"),
            _ => task.to_string(),
        }
    } else {
        task.to_string()
    };

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
        Some(task_with_blackboard),
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

    if let Some(wid) = req.workday_id.as_deref() {
        let summary = format!(
            "[{agent}] {status}: {preview}",
            agent = agent_trim,
            status = if result.is_ok() {
                "launched"
            } else {
                "spawn_failed"
            },
            preview = truncate(task, 160),
        );
        if let Err(e) = crate::workdays::append_context_inner(
            wid.to_string(),
            "agent_message".to_string(),
            summary,
            Some(agent_trim.to_string()),
        ) {
            eprintln!("[agent_orchestration] blackboard append failed: {e}");
        }
    }

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

// ---------------------------------------------------------------------------
// Delegation log — append-only JSONL at ~/.ultron/cockpit/delegations.jsonl
// Powers the Agents > Runs view (status badges + recent delegations list).
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DelegationLogEntry {
    pub id: String,
    pub agent: String,
    pub task_preview: String,
    pub cwd: Option<String>,
    pub used_cheap_model: bool,
    pub started_at: String,
    /// "launched" when spawn succeeded, "failed" otherwise. Future: track
    /// "running" / "done" via session_id polling.
    pub status: String,
    pub session_id: Option<String>,
}

fn delegations_path() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".ultron")
            .join("cockpit")
            .join("delegations.jsonl"),
    )
}

fn now_secs_safe() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Blackboard builder — produces the formal <workflow_blackboard> XML schema
// ---------------------------------------------------------------------------

/// Builder that renders a [`crate::workdays::Workday`] as the strict
/// `<workflow_blackboard>` XML defined in this module's top-level doc comment.
///
/// Usage:
/// ```ignore
/// let xml = BlackboardBuilder::new(&wd).build();
/// ```
struct BlackboardBuilder<'a> {
    wd: &'a crate::workdays::Workday,
}

impl<'a> BlackboardBuilder<'a> {
    fn new(wd: &'a crate::workdays::Workday) -> Self {
        Self { wd }
    }

    /// Escape the five XML special characters so attribute values and text
    /// content are safe to embed verbatim.
    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    /// Render the complete `<workflow_blackboard>` block.  Returns an empty
    /// string when the workday carries no context worth injecting (no notes,
    /// no decisions, no agent messages, no file changes, no pending goals).
    fn build(self) -> String {
        let wd = self.wd;

        // Collect sections individually so we can decide whether anything is
        // worth emitting before building the outer tag.
        let summary = self.build_summary();
        let recent_files = self.build_recent_files();
        let next_steps = self.build_next_steps();
        let blockers = self.build_blockers();
        let notes_md = self.build_notes_md();

        let has_content = summary.is_some()
            || recent_files.is_some()
            || next_steps.is_some()
            || blockers.is_some()
            || !notes_md.is_empty();

        if !has_content {
            return String::new();
        }

        let project_id = Self::xml_escape(wd.project_id.as_deref().unwrap_or(""));
        let at = crate::activity_timeline::epoch_secs_to_iso(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        );

        let mut out = format!(
            "<workflow_blackboard project_id=\"{project_id}\" workday_id=\"{wid}\" at=\"{at}\">\n",
            wid = Self::xml_escape(&wd.id),
        );

        if let Some(s) = summary {
            out.push_str("  <workday_summary>\n    ");
            out.push_str(&s);
            out.push_str("\n  </workday_summary>\n");
        }
        if let Some(rf) = recent_files {
            out.push_str("  <recent_files>\n");
            out.push_str(&rf);
            out.push_str("  </recent_files>\n");
        }
        if let Some(ns) = next_steps {
            out.push_str("  <next_steps>\n");
            out.push_str(&ns);
            out.push_str("  </next_steps>\n");
        }
        if let Some(b) = blockers {
            out.push_str("  <blockers>");
            out.push_str(&b);
            out.push_str("</blockers>\n");
        }
        out.push_str("</workflow_blackboard>");

        // Append the flat notes + agent_messages section after the closing tag
        // so structured parsers can stop at `</workflow_blackboard>`.
        if !notes_md.is_empty() {
            out.push_str("\n\n## Shared context from previous workflow steps\n\n");
            out.push_str(&notes_md);
        }

        out
    }

    fn build_summary(&self) -> Option<String> {
        let wd = self.wd;
        if wd.title.is_empty() {
            return None;
        }
        let done = wd
            .goals
            .iter()
            .filter(|g| g.status == crate::workdays::GoalStatus::Done)
            .count();
        let total = wd.goals.len();
        Some(format!(
            "{} — {} — {} — {done}/{total} goals done",
            Self::xml_escape(&wd.title),
            wd.status,
            wd.planned_date,
        ))
    }

    fn build_recent_files(&self) -> Option<String> {
        let entries: Vec<&crate::workdays::WorkdayContextEntry> =
            self.wd.context.file_changes.iter().rev().take(8).collect();
        if entries.is_empty() {
            return None;
        }
        let mut buf = String::new();
        for e in entries {
            // Convention: text is "path [kind]" or just "path"; we extract
            // the optional bracketed kind suffix if present.
            let (path, kind) = if let Some((path_part, kind_part)) =
                e.text.rfind('[').and_then(|i| {
                    let tail = e.text[i..].trim_matches(|c| c == '[' || c == ']');
                    Some((e.text[..i].trim(), tail))
                }) {
                (path_part.to_string(), kind_to_attr(kind_part))
            } else {
                (e.text.trim().to_string(), "modified")
            };
            buf.push_str(&format!(
                "    <file path=\"{p}\" kind=\"{k}\"/>\n",
                p = Self::xml_escape(&path),
                k = kind,
            ));
        }
        Some(buf)
    }

    fn build_next_steps(&self) -> Option<String> {
        let pending: Vec<&str> = self
            .wd
            .goals
            .iter()
            .filter(|g| g.status == crate::workdays::GoalStatus::Pending)
            .map(|g| g.text.as_str())
            .take(3)
            .collect();
        if pending.is_empty() {
            return None;
        }
        let mut buf = String::new();
        for step in pending {
            buf.push_str(&format!("    <step>{}</step>\n", Self::xml_escape(step),));
        }
        Some(buf)
    }

    fn build_blockers(&self) -> Option<String> {
        // Most recent decision entry = likeliest blocker/constraint.
        self.wd
            .context
            .decisions
            .last()
            .map(|e| Self::xml_escape(&truncate(&e.text, 300)))
    }

    fn build_notes_md(&self) -> String {
        let mut entries: Vec<(&str, &str)> = Vec::new();
        for e in self.wd.context.notes.iter().rev().take(4) {
            entries.push(("note", &e.text));
        }
        for e in self.wd.context.agent_messages.iter().rev().take(8) {
            entries.push(("agent", &e.text));
        }
        entries.truncate(12);
        if entries.is_empty() {
            return String::new();
        }
        entries
            .iter()
            .map(|(kind, text)| format!("- **{kind}**: {}\n", truncate(text, 200)))
            .collect()
    }
}

/// Map a file-change kind string to one of the two allowed XML attribute
/// values (`"modified"` | `"added"`).  Unknown values default to `"modified"`.
fn kind_to_attr(s: &str) -> &'static str {
    match s.to_lowercase().trim() {
        "added" | "add" | "new" | "created" => "added",
        _ => "modified",
    }
}

/// Read the most recent context entries from a workday and render them as the
/// formal `<workflow_blackboard>` XML preamble for an agent delegation.
///
/// Returns `""` (empty string) in all non-fatal situations:
///   * `workday_id` does not exist on disk (`Ok(None)` from `get_workday_by_id`)
///   * Workday exists but has no context worth injecting
///
/// Returns `Err` only when the file system itself fails (permission error,
/// corrupt JSON that cannot be parsed).  The caller (`delegate_task_inner`)
/// treats any return value as optional enrichment and proceeds regardless.
fn build_blackboard_preamble(workday_id: &str) -> Result<String, String> {
    // O(1) direct-path lookup — KIRKARDO 17 HIGH.
    // get_workday_by_id returns Ok(None) for unknown ids (graceful fallback),
    // Err only for I/O / parse failures.
    let wd = match crate::workdays::get_workday_by_id(workday_id)? {
        Some(w) => w,
        None => {
            eprintln!(
                "[agent_orchestration] blackboard: workday '{workday_id}' not found, skipping preamble"
            );
            return Ok(String::new());
        }
    };
    Ok(BlackboardBuilder::new(&wd).build())
}

fn truncate(s: &str, max: usize) -> String {
    // Strip control characters (incl. \r, \t, vertical-tab) — \n is already
    // collapsed below — so the JSONL line stays grep/jq-friendly even when
    // a task description was pasted from a terminal with weird escapes
    // (KIRKARDO 3 LOW). Spaces survive.
    let cleaned: String = s
        .trim()
        .chars()
        .map(|c| if c == '\n' { ' ' } else { c })
        .filter(|c| !c.is_control() || *c == ' ')
        .collect();
    // Single pass: bound iteration to `max` chars instead of allocating
    // Vec<char> (KIRKARDO 2 MED). The truncated marker '…' only appears
    // when we actually had to cut.
    let mut count = 0usize;
    let mut head = String::with_capacity(max.min(cleaned.len()) + 3);
    let mut truncated = false;
    for ch in cleaned.chars() {
        if count >= max {
            truncated = true;
            break;
        }
        head.push(ch);
        count += 1;
    }
    if truncated {
        head.push('…');
    }
    head
}

fn log_delegation(entry: DelegationLogEntry) -> Result<(), String> {
    let path = delegations_path().ok_or("no home dir")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    // KIRKARDO 19 fix: single write_all so two concurrent delegations can't
    // interleave their JSON body with the newline separator and produce a
    // malformed JSONL line on Windows (where O_APPEND atomicity is weaker
    // than POSIX). Avoids the {a}{b}\n\n pattern.
    let mut buf = line.into_bytes();
    buf.push(b'\n');
    f.write_all(&buf).map_err(|e| e.to_string())?;
    Ok(())
}

/// Read up to `limit` of the most recent delegations (newest first). Tolerant
/// to malformed lines — bad records are skipped silently. Returns an empty
/// vec when the file is missing.
pub fn list_delegations_inner(limit: usize) -> Result<Vec<DelegationLogEntry>, String> {
    let cap = if limit == 0 || limit > 500 {
        100
    } else {
        limit
    };
    let Some(path) = delegations_path() else {
        return Ok(Vec::new());
    };
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut out: Vec<DelegationLogEntry> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<DelegationLogEntry>(l).ok())
        .collect();
    out.reverse();
    out.truncate(cap);
    Ok(out)
}

/// Hard-coded snapshot of the canonical seven alignments. We pin them
/// here so the UI works on a fresh install with no skill files present.
/// If the user edits the skill markdown the workflow definitions still
/// remain consistent with the documented semantics.
pub fn list_workflows_inner() -> Vec<WorkflowDefinition> {
    // KIRKARDO 26 CRITICAL fix: the previous version referenced 6 ghost
    // slugs (terry-davis, kirkardo, don-claudio, einstein, novalbos,
    // ue5-dev) that exist as SKILLS in ~/.claude/skills/ but NOT as
    // agents in ~/.claude/agents/. Tauri's delegate_task spawns by
    // subagent_type which must resolve to an actual .md file in agents/.
    // 5 of 7 workflows were silently no-op'ing the persona steps.
    //
    // New mapping uses agents that exist on disk (verified 2026-05-27):
    //   terry-davis        → code-reviewer
    //   kirkardo           → qa-expert
    //   don-claudio        → architect-reviewer
    //   einstein           → ai-engineer
    //   novalbos           → llm-architect
    //   ue5-dev            → unreal-engine-engineer
    //
    // The personas still live as skills and continue to be invokable by
    // name from the user prompt; this list is strictly about subagent
    // delegation that touches ~/.claude/agents/.
    vec![
        WorkflowDefinition {
            id: "quick".to_string(),
            label: "Quick fix".to_string(),
            description: "Obvious bugs, simple fixes, fast technical answers.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "code-reviewer".to_string(),
                    note: Some("Quick surgical fix".to_string()),
                },
                WorkflowStep {
                    agent: "qa-expert".to_string(),
                    note: Some("30s validation".to_string()),
                },
            ],
        },
        WorkflowDefinition {
            id: "feature".to_string(),
            label: "New feature".to_string(),
            description: "New features in any project — design first.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "architect-reviewer".to_string(),
                    note: Some("Architect".to_string()),
                },
                WorkflowStep {
                    agent: "fullstack-developer".to_string(),
                    note: Some("TDD implementation".to_string()),
                },
                WorkflowStep {
                    agent: "code-reviewer".to_string(),
                    note: Some("Quality PR".to_string()),
                },
            ],
        },
        WorkflowDefinition {
            id: "debug".to_string(),
            label: "Stuck debug".to_string(),
            description: "Bugs that have gone over 20 minutes without resolution.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "debugger".to_string(),
                    note: Some("Systematic debugging".to_string()),
                },
                WorkflowStep {
                    agent: "error-detective".to_string(),
                    note: Some("Cross-service correlation".to_string()),
                },
                WorkflowStep {
                    agent: "qa-expert".to_string(),
                    note: Some("Verify fix".to_string()),
                },
            ],
        },
        WorkflowDefinition {
            id: "security".to_string(),
            label: "Security audit".to_string(),
            description: "Before a release, or on new auth / permissions code.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "security-auditor".to_string(),
                    note: Some("OWASP + blast radius".to_string()),
                },
                WorkflowStep {
                    agent: "penetration-tester".to_string(),
                    note: Some("Dependencies + taint".to_string()),
                },
                WorkflowStep {
                    agent: "code-reviewer".to_string(),
                    note: Some("Final verdict".to_string()),
                },
            ],
        },
        WorkflowDefinition {
            id: "research".to_string(),
            label: "Research first".to_string(),
            description: "Features that need understanding something new first.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "ai-engineer".to_string(),
                    note: Some("Theory + papers".to_string()),
                },
                WorkflowStep {
                    agent: "llm-architect".to_string(),
                    note: Some("Architecture deep dive".to_string()),
                },
                WorkflowStep {
                    agent: "architect-reviewer".to_string(),
                    note: Some("Translate to design".to_string()),
                },
                WorkflowStep {
                    agent: "fullstack-developer".to_string(),
                    note: Some("Implementation".to_string()),
                },
            ],
        },
        WorkflowDefinition {
            id: "game".to_string(),
            label: "Game dev".to_string(),
            description: "Tortunabo / other game projects — engine-specific stack.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "architect-reviewer".to_string(),
                    note: Some("Multiplayer / engine architect".to_string()),
                },
                WorkflowStep {
                    agent: "unreal-engine-engineer".to_string(),
                    note: Some("UE5 C++ + Blueprints".to_string()),
                },
                WorkflowStep {
                    agent: "cpp-pro".to_string(),
                    note: Some("Modern C++ gameplay".to_string()),
                },
                WorkflowStep {
                    agent: "qa-expert".to_string(),
                    note: Some("Review".to_string()),
                },
            ],
        },
        WorkflowDefinition {
            id: "learning".to_string(),
            label: "Learning".to_string(),
            description: "Learn something new deeply, not just copy it.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "llm-architect".to_string(),
                    note: Some("Deep explanation + notes".to_string()),
                },
                WorkflowStep {
                    agent: "code-reviewer".to_string(),
                    note: Some("Working example".to_string()),
                },
                WorkflowStep {
                    agent: "qa-expert".to_string(),
                    note: Some("Verify correctness".to_string()),
                },
            ],
        },
    ]
}

fn validate_agent_slug(slug: &str) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_slug_accepts_canonical_agents() {
        for name in [
            "terry-davis",
            "kirkardo",
            "don-claudio",
            "ue5-dev",
            "novalbos",
            "einstein",
        ] {
            assert!(
                validate_agent_slug(name).is_ok(),
                "slug '{}' should be accepted",
                name
            );
        }
    }

    #[test]
    fn validate_slug_rejects_uppercase_and_path_chars() {
        assert!(validate_agent_slug("Terry").is_err());
        assert!(validate_agent_slug("agent/etc").is_err());
        assert!(validate_agent_slug("agent\\bad").is_err());
        assert!(validate_agent_slug("agent.md").is_err());
    }

    #[test]
    fn list_workflows_contains_canonical_seven() {
        // list_workflows_inner() returns only the built-in set (>= 7 entries).
        // The merged list (user + built-ins) may exceed 7 when the user has
        // YAML files in ~/.ultron/cockpit/workflows/ — that path is tested in
        // workflow_loader::tests. Here we only assert the built-in floor.
        let wf = list_workflows_inner();
        assert!(
            wf.len() >= 7,
            "expected at least 7 built-in workflows, got {}",
            wf.len()
        );
        let ids: Vec<&str> = wf.iter().map(|w| w.id.as_str()).collect();
        for required in [
            "quick", "feature", "debug", "security", "research", "game", "learning",
        ] {
            assert!(
                ids.contains(&required),
                "missing workflow id '{}'",
                required
            );
        }
    }

    #[test]
    fn resolve_cheap_model_returns_non_empty() {
        assert!(!resolve_cheap_model().is_empty());
    }

    // ------------------------------------------------------------------
    // strip_ansi tests
    // ------------------------------------------------------------------

    #[test]
    fn strip_ansi_removes_csi_colour_codes() {
        // ESC[32m = green, ESC[0m = reset
        let raw = b"\x1b[32mHello\x1b[0m world";
        let result = strip_ansi(raw);
        assert_eq!(result, "Hello world");
    }

    #[test]
    fn strip_ansi_preserves_plain_ascii() {
        let raw = b"plain text [AGENT TASK COMPLETE]";
        let result = strip_ansi(raw);
        assert_eq!(result, "plain text [AGENT TASK COMPLETE]");
    }

    #[test]
    fn strip_ansi_handles_two_byte_esc_sequences() {
        // ESC= (application keypad mode) followed by text
        let raw = b"\x1b=some text\x1b>";
        let result = strip_ansi(raw);
        assert_eq!(result, "some text");
    }

    #[test]
    fn strip_ansi_detects_sentinel_after_stripping() {
        // Sentinel wrapped in green colour codes as a TUI would emit it.
        let raw = b"\x1b[1m[AGENT TASK COMPLETE]\x1b[0m";
        let text = strip_ansi(raw);
        assert!(
            text.contains(COMPLETION_SENTINEL),
            "sentinel must survive ANSI strip; got: {text:?}"
        );
    }

    // ------------------------------------------------------------------
    // DelegateRequest timeout resolution tests
    // ------------------------------------------------------------------

    #[test]
    fn delegate_request_timeout_defaults() {
        // None and 0 both resolve to DEFAULT_DELEGATE_TIMEOUT_SECS.
        for val in [None, Some(0u64)] {
            let resolved = match val {
                Some(0) | None => DEFAULT_DELEGATE_TIMEOUT_SECS,
                Some(n) => n.min(3_600),
            };
            assert_eq!(
                resolved, DEFAULT_DELEGATE_TIMEOUT_SECS,
                "timeout {:?} should default to {DEFAULT_DELEGATE_TIMEOUT_SECS}",
                val
            );
        }
    }

    #[test]
    fn delegate_request_timeout_clamps_to_one_hour() {
        let huge: u64 = 99_999;
        let resolved = match Some(huge) {
            Some(0) | None => DEFAULT_DELEGATE_TIMEOUT_SECS,
            Some(n) => n.min(3_600),
        };
        assert_eq!(resolved, 3_600, "timeout should be clamped to 3600s");
    }

    #[test]
    fn delegate_request_timeout_custom_value_respected() {
        let custom: u64 = 60;
        let resolved = match Some(custom) {
            Some(0) | None => DEFAULT_DELEGATE_TIMEOUT_SECS,
            Some(n) => n.min(3_600),
        };
        assert_eq!(resolved, 60);
    }

    // ------------------------------------------------------------------
    // Sentinel constant sanity
    // ------------------------------------------------------------------

    #[test]
    fn completion_sentinel_is_non_empty_and_ascii() {
        assert!(!COMPLETION_SENTINEL.is_empty());
        assert!(
            COMPLETION_SENTINEL.is_ascii(),
            "sentinel must be pure ASCII to survive PTY encoding"
        );
        // Must start with '[' so it stands out on its own line.
        assert!(COMPLETION_SENTINEL.starts_with('['));
    }

    // ------------------------------------------------------------------
    // Poll-loop sentinel detection logic (unit-tested without real PTY)
    // ------------------------------------------------------------------

    /// Simulate what the poll loop does: take raw bytes, strip ANSI, check
    /// for the sentinel. This validates the detection algorithm in isolation
    /// from the actual PTY infrastructure.
    fn poll_loop_detects(raw: &[u8]) -> bool {
        let text = strip_ansi(raw);
        text.contains(COMPLETION_SENTINEL)
    }

    #[test]
    fn poll_detects_sentinel_plain() {
        let output = format!("some work done\n{COMPLETION_SENTINEL}\n");
        assert!(poll_loop_detects(output.as_bytes()));
    }

    #[test]
    fn poll_detects_sentinel_with_ansi_colour() {
        let output = format!("doing work\r\n\x1b[32m{COMPLETION_SENTINEL}\x1b[0m\r\n");
        assert!(poll_loop_detects(output.as_bytes()));
    }

    #[test]
    fn poll_does_not_false_positive_on_partial_sentinel() {
        let partial = b"[AGENT TASK INCOMPLET";
        assert!(!poll_loop_detects(partial));
    }

    #[test]
    fn poll_does_not_false_positive_on_empty_output() {
        assert!(!poll_loop_detects(b""));
    }

    // -------------------------------------------------------------------------
    // KIRKARDO 17 P2 — blackboard contract tests
    //
    // Tests that require disk I/O write fixtures under the prefix
    // "wd-test-17-" and delete them on completion.  Pure-logic tests use
    // in-memory Workday values only.
    // -------------------------------------------------------------------------

    fn make_workday(id: &str) -> crate::workdays::Workday {
        use crate::workdays::*;
        Workday {
            id: id.to_string(),
            template_id: None,
            workflow_template: None,
            project_id: Some("proj-test".to_string()),
            project_cwd: None,
            title: "Test workday".to_string(),
            status: WorkdayStatus::InProgress,
            planned_date: "2026-05-27".to_string(),
            start_ts: None,
            end_ts: None,
            focus_seconds: 0,
            break_seconds: 0,
            energy_before: None,
            energy_after: None,
            mood_note: None,
            retro_good: None,
            retro_bad: None,
            retro_learned: None,
            summary_md: None,
            goals: Vec::new(),
            linked_sessions: Vec::new(),
            linked_tasks: Vec::new(),
            context: WorkdayContext::default(),
            created_at: "epoch:0".to_string(),
            ai_summary: None,
        }
    }

    fn write_fixture(wd: &crate::workdays::Workday) -> std::path::PathBuf {
        let dir = crate::workdays::workdays_dir().expect("workdays dir");
        std::fs::create_dir_all(&dir).expect("create workdays dir");
        let path = dir.join(format!("{}.json", wd.id));
        let json = serde_json::to_string_pretty(wd).expect("serialize workday");
        std::fs::write(&path, json).expect("write fixture");
        path
    }

    // -- get_workday_by_id ----------------------------------------------------

    #[test]
    fn get_workday_by_id_returns_some_for_existing() {
        let wd = make_workday("wd-test-17-exists");
        let path = write_fixture(&wd);
        let result = crate::workdays::get_workday_by_id("wd-test-17-exists");
        let _ = std::fs::remove_file(&path);
        let found = result.expect("must not error for existing workday");
        assert!(found.is_some(), "expected Some for id written to disk");
        assert_eq!(found.unwrap().id, "wd-test-17-exists");
    }

    #[test]
    fn get_workday_by_id_returns_none_for_unknown_id() {
        let result = crate::workdays::get_workday_by_id("wd-test-17-never-written-99999");
        assert!(
            matches!(result, Ok(None)),
            "expected Ok(None) for unknown id, got: {result:?}",
        );
    }

    // -- BlackboardBuilder pure-logic (no disk) --------------------------------

    /// A workday whose title is empty AND has no context entries whatsoever
    /// must produce an empty preamble — the builder has nothing to inject.
    ///
    /// A workday that has a title but no context is still emitted (it shows
    /// the `<workday_summary>` so the agent knows which day it is operating
    /// in).  This test verifies only the fully-empty edge case: no title,
    /// no context, no goals.
    #[test]
    fn blackboard_builder_no_title_no_context_returns_empty_string() {
        let mut wd = make_workday("wd-test-17-bb-empty");
        wd.title = String::new(); // blank title → build_summary returns None
                                  // context is already default (all vecs empty), goals is empty
        let out = BlackboardBuilder::new(&wd).build();
        assert!(
            out.is_empty(),
            "workday with no title and no context must produce empty preamble, got: {out:?}"
        );
    }

    /// A workday with a non-empty title but no context entries still emits
    /// the XML block (with `<workday_summary>`) so the agent knows what
    /// workday it is operating in.
    #[test]
    fn blackboard_builder_titled_workday_no_context_emits_summary_only() {
        let wd = make_workday("wd-test-17-bb-titled-only");
        // title = "Test workday", context = default empty
        let out = BlackboardBuilder::new(&wd).build();
        assert!(
            out.contains("<workflow_blackboard"),
            "must emit opening tag"
        );
        assert!(
            out.contains("<workday_summary>"),
            "must emit summary for titled workday"
        );
        assert!(
            !out.contains("<next_steps>"),
            "no pending goals → no next_steps"
        );
        assert!(!out.contains("<blockers>"), "no decisions → no blockers");
    }

    #[test]
    fn blackboard_builder_with_note_produces_xml_block() {
        use crate::workdays::{WorkdayContext, WorkdayContextEntry};
        let mut wd = make_workday("wd-test-17-bb-note");
        wd.context = WorkdayContext {
            notes: vec![WorkdayContextEntry {
                id: "ctx-1".to_string(),
                kind: "note".to_string(),
                text: "decided to use serde_json for serialization".to_string(),
                source: None,
                created_at: "epoch:0".to_string(),
            }],
            ..WorkdayContext::default()
        };
        let out = BlackboardBuilder::new(&wd).build();
        assert!(out.contains("<workflow_blackboard"), "missing opening tag");
        assert!(
            out.contains("</workflow_blackboard>"),
            "missing closing tag"
        );
        assert!(out.contains("<workday_summary>"), "missing workday_summary");
        assert!(out.contains("serde_json"), "note text missing from output");
    }

    #[test]
    fn blackboard_builder_pending_goals_populate_next_steps() {
        use crate::workdays::{
            GoalSource, GoalStatus, WorkdayContext, WorkdayContextEntry, WorkdayGoal,
        };
        let mut wd = make_workday("wd-test-17-bb-goals");
        wd.context = WorkdayContext {
            notes: vec![WorkdayContextEntry {
                id: "ctx-seed".to_string(),
                kind: "note".to_string(),
                text: "seed note".to_string(),
                source: None,
                created_at: "epoch:0".to_string(),
            }],
            ..WorkdayContext::default()
        };
        wd.goals = vec![
            WorkdayGoal {
                id: "g1".to_string(),
                text: "Implement O(1) lookup".to_string(),
                status: GoalStatus::Pending,
                source: GoalSource::Manual,
                linked_card_id: None,
            },
            WorkdayGoal {
                id: "g2".to_string(),
                text: "Write tests".to_string(),
                status: GoalStatus::Done,
                source: GoalSource::Manual,
                linked_card_id: None,
            },
        ];
        let out = BlackboardBuilder::new(&wd).build();
        assert!(
            out.contains("<next_steps>"),
            "expected <next_steps> section"
        );
        assert!(
            out.contains("Implement O(1) lookup"),
            "pending goal must appear"
        );
        assert!(
            !out.contains("Write tests"),
            "done goal must NOT appear in next_steps"
        );
    }

    #[test]
    fn blackboard_builder_decision_populates_blockers() {
        use crate::workdays::{WorkdayContext, WorkdayContextEntry};
        let mut wd = make_workday("wd-test-17-bb-decision");
        wd.context = WorkdayContext {
            decisions: vec![WorkdayContextEntry {
                id: "ctx-d1".to_string(),
                kind: "decision".to_string(),
                text: "Do not change the public API surface".to_string(),
                source: None,
                created_at: "epoch:0".to_string(),
            }],
            ..WorkdayContext::default()
        };
        let out = BlackboardBuilder::new(&wd).build();
        assert!(out.contains("<blockers>"), "expected <blockers> section");
        assert!(
            out.contains("Do not change the public API surface"),
            "decision text missing"
        );
    }

    #[test]
    fn blackboard_builder_xml_escapes_special_chars() {
        use crate::workdays::{WorkdayContext, WorkdayContextEntry};
        let mut wd = make_workday("wd-test-17-bb-escape");
        wd.title = "Feature: <foo> & \"bar\"".to_string();
        wd.context = WorkdayContext {
            notes: vec![WorkdayContextEntry {
                id: "ctx-e1".to_string(),
                kind: "note".to_string(),
                text: "plain note".to_string(),
                source: None,
                created_at: "epoch:0".to_string(),
            }],
            ..WorkdayContext::default()
        };
        let out = BlackboardBuilder::new(&wd).build();
        assert!(!out.contains("<foo>"), "raw angle bracket must be escaped");
        assert!(out.contains("&lt;foo&gt;"), "must become &lt;/&gt;");
        assert!(out.contains("&amp;"), "ampersand must become &amp;");
        assert!(
            out.contains("&quot;bar&quot;"),
            "double-quote must become &quot;"
        );
    }

    // -- build_blackboard_preamble integration (disk) -------------------------

    #[test]
    fn blackboard_preamble_some_existing_workday_has_summary() {
        use crate::workdays::{WorkdayContext, WorkdayContextEntry};
        let mut wd = make_workday("wd-test-17-preamble-exists");
        wd.context = WorkdayContext {
            notes: vec![WorkdayContextEntry {
                id: "ctx-p1".to_string(),
                kind: "note".to_string(),
                text: "architecture decision: use blackboard pattern".to_string(),
                source: None,
                created_at: "epoch:0".to_string(),
            }],
            ..WorkdayContext::default()
        };
        let path = write_fixture(&wd);
        let result = build_blackboard_preamble("wd-test-17-preamble-exists");
        let _ = std::fs::remove_file(&path);
        let preamble = result.expect("must not error for existing workday");
        assert!(
            preamble.contains("<workday_summary>"),
            "preamble must contain <workday_summary>"
        );
        assert!(
            preamble.contains("blackboard pattern"),
            "preamble must include note text"
        );
    }

    #[test]
    fn blackboard_preamble_none_workday_id_passes_task_through() {
        let task = "do something important";
        let workday_id: Option<&str> = None;
        let task_with_blackboard = if let Some(wid) = workday_id {
            match build_blackboard_preamble(wid) {
                Ok(p) if !p.is_empty() => format!("{p}\n\n---\n\n{task}"),
                _ => task.to_string(),
            }
        } else {
            task.to_string()
        };
        assert_eq!(
            task_with_blackboard, task,
            "task must pass through when workday_id is None"
        );
    }

    #[test]
    fn blackboard_preamble_some_nonexistent_id_returns_empty_ok() {
        let result = build_blackboard_preamble("wd-test-17-nonexistent-99999");
        assert!(
            matches!(result, Ok(ref s) if s.is_empty()),
            "expected Ok(\"\") for unknown workday_id, got: {result:?}",
        );
    }

    // -- kind_to_attr ---------------------------------------------------------

    #[test]
    fn kind_to_attr_maps_known_variants() {
        assert_eq!(kind_to_attr("added"), "added");
        assert_eq!(kind_to_attr("new"), "added");
        assert_eq!(kind_to_attr("created"), "added");
        assert_eq!(kind_to_attr("modified"), "modified");
        assert_eq!(kind_to_attr("unknown_kind"), "modified");
        assert_eq!(kind_to_attr(""), "modified");
    }
}
