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

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::sessions::{self, SpawnFlags, SpawnResult};

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

pub async fn delegate_task_inner(
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

    // KIRKARDO 7 Paso 1 — Blackboard read: when a workday is provided,
    // prepend the most recent shared-context entries so the delegated agent
    // sees what previous workflow steps decided. Capped at 12 entries × 200
    // chars so the prompt stays under the 16KB ceiling even when the
    // workday has accumulated dozens of notes.
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

    // KIRKARDO 12 quick-win — Tauri event stream. Emit before/after the
    // spawn so the frontend Recent runs strip can refresh immediately
    // instead of waiting for the 30s poll. The emit failures themselves
    // are non-fatal: the delegation log is the source of truth.
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

    // KIRKARDO 7 Paso 1 — Blackboard write: record this delegation as an
    // agent_message context entry so subsequent agents in the chain (and
    // the user via the Workday detail panel) see what was delegated. We
    // do this best-effort; a workday append failure here does not bubble
    // up because the spawn itself already happened.
    if let Some(wid) = req.workday_id.as_deref() {
        let summary = format!(
            "[{agent}] {status}: {preview}",
            agent = agent_trim,
            status = if result.is_ok() { "delegated" } else { "spawn_failed" },
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

    // Log the delegation regardless of success — failures matter for the
    // Runs view too (the user wants to see "I tried to delegate to X and
    // it crashed"). Errors writing the log are silent; the spawn result
    // is the source of truth for the caller.
    // SpawnResult does not carry a session_id today; the new session shows
    // up in `claude_sessions::list_workspaces` once Claude Code writes the
    // first JSONL line. We log "launched" / "failed" only.
    let status = if result.is_ok() { "launched" } else { "failed" };
    // Don't silence log failures (KIRKARDO 5 CRIT). The delegation itself
    // already succeeded by the time we get here, so a log write error is
    // surface-only — we surface it on stderr where the dev tools can pick
    // it up but don't propagate it to the caller (a missing log line is
    // not worth tearing down the delegation result the user can see).
    // Append a microsecond nonce so two delegations in the same second
    // don't collide on id (KIRKARDO 17 MED).
    let id_nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_micros() % 10_000)
        .unwrap_or(0);
    if let Err(e) = log_delegation(DelegationLogEntry {
        id: format!("dl-{}-{:04}", now_secs_safe(), id_nonce),
        agent: agent_trim.to_string(),
        task_preview: truncate(task, 200),
        cwd: cwd_for_log,
        used_cheap_model: req.use_cheap_model,
        // ISO 8601 instead of "epoch:N" (KIRKARDO 2 quick-win) so frontend
        // sort/display works without parsing the inventado format.
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

/// Read the most recent context entries from a workday and render them as
/// a markdown preamble for an agent delegation. Returns "" when the
/// workday has no entries or cannot be loaded — both states are silent
/// because the delegation should still proceed (the blackboard is an
/// optional enrichment, not a precondition).
fn build_blackboard_preamble(workday_id: &str) -> Result<String, String> {
    // KIRKARDO 17 HIGH fix: was list_workdays_inner(..) + filter, O(N) over
    // every workday on disk. Now uses the O(1) direct path lookup.
    let wd = crate::workdays::get_workday_by_id(workday_id)?;
    let mut entries: Vec<(&str, &str, &str)> = Vec::new();
    for e in wd.context.notes.iter().rev().take(4) {
        entries.push(("note", &e.text, &e.created_at));
    }
    for e in wd.context.decisions.iter().rev().take(4) {
        entries.push(("decision", &e.text, &e.created_at));
    }
    for e in wd.context.agent_messages.iter().rev().take(8) {
        entries.push(("agent", &e.text, &e.created_at));
    }
    if entries.is_empty() {
        return Ok(String::new());
    }
    let mut md = String::from(
        "<workflow_blackboard>\n## Shared context from previous workflow steps\n\n",
    );
    for (kind, text, _ts) in entries.iter().take(12) {
        let line = truncate(text, 200);
        md.push_str(&format!("- **{kind}**: {line}\n"));
    }
    md.push_str("</workflow_blackboard>");
    Ok(md)
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
    let cap = if limit == 0 || limit > 500 { 100 } else { limit };
    let Some(path) = delegations_path() else { return Ok(Vec::new()) };
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
            assert!(ids.contains(&required), "missing workflow id '{}'", required);
        }
    }

    #[test]
    fn resolve_cheap_model_returns_non_empty() {
        assert!(!resolve_cheap_model().is_empty());
    }
}
