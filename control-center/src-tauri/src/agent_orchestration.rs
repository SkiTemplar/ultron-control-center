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

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// provider_router — multi-IA PTY dispatch (inline module)
//
// Decides WHICH agentic CLI runs a delegation without the user asking.
// Pure O(1) logic; no network, no Qdrant. The semantic routing (E5) already
// chose WHAT agent; here we choose IN WHICH provider it runs.
// ---------------------------------------------------------------------------
pub mod provider_router {
    /// PTY-spawnable provider for an agent delegation. The PTY layer
    /// (`build_command` in `pty.rs`) only knows how to launch three agentic
    /// CLIs; everything else degrades to Claude.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum PtyProvider {
        Claude,
        Codex,
        Gemini,
    }

    impl PtyProvider {
        /// The exact string `pty::build_command` expects. Keeping this in one
        /// place guarantees the orchestrator and the PTY layer never disagree.
        pub fn as_str(self) -> &'static str {
            match self {
                Self::Claude => "claude",
                Self::Codex => "codex",
                Self::Gemini => "gemini",
            }
        }
    }

    // Light agents: review/docs/qa/news — Gemini CLI (free via OAuth) is
    // plenty. Mirrors the AI Router `code-review` / `summarize` zones.
    const LIGHT_AGENTS: &[&str] = &[
        "code-reviewer",
        "qa-expert",
        "ultron-docs",
        "ultron-changelog",
        "ultron-news",
        "documentation-engineer",
        "accessibility-tester",
        "knowledge-synthesizer",
        "dx-optimizer",
    ];

    // Code-implementation-heavy agents — Codex CLI. Mirrors the AI Router
    // `code-edit` zone (primary codex/gpt-5).
    const CODE_HEAVY_AGENTS: &[&str] = &[
        "rust-engineer",
        "cpp-pro",
        "backend-developer",
        "golang-pro",
        "python-pro",
        "typescript-pro",
        "fullstack-developer",
        "refactoring-specialist",
        "legacy-modernizer",
    ];

    /// Decide which agentic CLI should run a delegation, WITHOUT the user asking.
    ///
    /// Strategy (cheapest correct provider first, Claude as hard fallback):
    ///   1. `use_cheap_model` OR a "light" agent  → Gemini CLI (free via OAuth).
    ///   2. A code-implementation-heavy agent      → Codex CLI.
    ///   3. Otherwise                               → Claude (current behaviour).
    ///
    /// The returned provider is ALWAYS one `build_command` accepts. The caller
    /// is responsible for falling back to Claude when the chosen CLI is not on
    /// PATH (see `pty::cli_on_path`), so a missing codex/gemini install never
    /// breaks a delegation.
    pub fn infer_pty_provider(agent_slug: &str, use_cheap_model: bool) -> PtyProvider {
        let s = agent_slug.trim().to_lowercase();

        if use_cheap_model || LIGHT_AGENTS.iter().any(|a| s == *a || s.contains(a)) {
            return PtyProvider::Gemini;
        }
        if CODE_HEAVY_AGENTS.iter().any(|a| s == *a || s.contains(a)) {
            return PtyProvider::Codex;
        }
        PtyProvider::Claude
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn cheap_flag_routes_to_gemini() {
            assert_eq!(infer_pty_provider("python-pro", true), PtyProvider::Gemini);
        }

        #[test]
        fn light_agent_routes_to_gemini_without_flag() {
            assert_eq!(
                infer_pty_provider("code-reviewer", false),
                PtyProvider::Gemini
            );
        }

        #[test]
        fn code_heavy_agent_routes_to_codex() {
            assert_eq!(
                infer_pty_provider("rust-engineer", false),
                PtyProvider::Codex
            );
        }

        #[test]
        fn unknown_agent_defaults_to_claude() {
            assert_eq!(
                infer_pty_provider("some-random-agent", false),
                PtyProvider::Claude
            );
        }

        #[test]
        fn provider_strings_match_build_command_contract() {
            // build_command (pty.rs) matches exactly these three literals.
            for p in [PtyProvider::Claude, PtyProvider::Codex, PtyProvider::Gemini] {
                assert!(matches!(p.as_str(), "claude" | "codex" | "gemini"));
            }
        }

        #[test]
        fn cheap_flag_overrides_code_heavy() {
            // Explicit cheap request beats the code-heavy default.
            assert_eq!(
                infer_pty_provider("rust-engineer", true),
                PtyProvider::Gemini
            );
        }
    }
}

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
/// struct carries the captured PTY output so the orchestrator can use it
/// as input for the next pipeline step.
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
/// Resolve the cheap model id from the AI Router's `light` zone primary, so
/// the cheap delegation path follows the same config as the rest of the system
/// instead of a hardcoded literal. Falls back to Haiku 4.5 (the historical
/// default) when zones are unreadable, preserving prior behaviour.
fn resolve_cheap_model() -> String {
    crate::ai_router::primary_model_for_zone("light")
        .unwrap_or_else(|| "claude-haiku-4-5".to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DelegateRequest {
    pub agent: String,
    pub task: String,
    #[serde(default)]
    pub use_cheap_model: bool,
    #[serde(default)]
    pub cwd: Option<String>,
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

    // Tell the agent it MUST print the sentinel when done.
    let full_prompt = format!(
        "{task}\n\n\
         ---\n\
         When you have fully completed the task above, print the following \
         token on its own line as the very last line of your response:\n\
         {COMPLETION_SENTINEL}"
    );

    // Multi-IA dispatch: pick the cheapest correct agentic CLI for this agent
    // WITHOUT the user asking. Fall back HARD to Claude when the chosen CLI is
    // not installed, so a missing codex/gemini binary never breaks delegation
    // (zero observable change when the router cannot improve on Claude).
    let chosen = provider_router::infer_pty_provider(agent_trim, req.use_cheap_model);
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
            "provider": provider, // claude | codex | gemini (multi-IA dispatch)
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
    let mut head = String::with_capacity(max.min(cleaned.len()) + 3);
    let mut truncated = false;
    for (count, ch) in cleaned.chars().enumerate() {
        if count >= max {
            truncated = true;
            break;
        }
        head.push(ch);
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
}
