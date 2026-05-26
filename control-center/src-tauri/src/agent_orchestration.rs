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
    let result = sessions::spawn_session_inner(
        app,
        "claude".to_string(),
        Some(task.to_string()),
        req.cwd,
        Some(flags),
    )
    .await;

    // Log the delegation regardless of success — failures matter for the
    // Runs view too (the user wants to see "I tried to delegate to X and
    // it crashed"). Errors writing the log are silent; the spawn result
    // is the source of truth for the caller.
    // SpawnResult does not carry a session_id today; the new session shows
    // up in `claude_sessions::list_workspaces` once Claude Code writes the
    // first JSONL line. We log "launched" / "failed" only.
    let status = if result.is_ok() { "launched" } else { "failed" };
    let _ = log_delegation(DelegationLogEntry {
        id: format!("dl-{}", now_secs_safe()),
        agent: agent_trim.to_string(),
        task_preview: truncate(task, 200),
        cwd: cwd_for_log,
        used_cheap_model: req.use_cheap_model,
        started_at: format!("epoch:{}", now_secs_safe()),
        status: status.to_string(),
        session_id: None,
    });

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
    let trimmed = s.trim().replace('\n', " ");
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= max {
        return trimmed;
    }
    let head: String = chars.into_iter().take(max).collect();
    format!("{}…", head)
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
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    f.write_all(b"\n").map_err(|e| e.to_string())?;
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
    vec![
        WorkflowDefinition {
            id: "quick".to_string(),
            label: "Quick fix".to_string(),
            description: "Obvious bugs, simple fixes, fast technical answers.".to_string(),
            steps: vec![
                WorkflowStep {
                    agent: "terry-davis".to_string(),
                    note: Some("Quick mode".to_string()),
                },
                WorkflowStep {
                    agent: "kirkardo".to_string(),
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
                    agent: "don-claudio".to_string(),
                    note: Some("Architect".to_string()),
                },
                WorkflowStep {
                    agent: "terry-davis".to_string(),
                    note: Some("TDD implementation".to_string()),
                },
                WorkflowStep {
                    agent: "kirkardo".to_string(),
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
                    agent: "terry-davis".to_string(),
                    note: Some("Quick surgical fix".to_string()),
                },
                WorkflowStep {
                    agent: "kirkardo".to_string(),
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
                    agent: "kirkardo".to_string(),
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
                    agent: "einstein".to_string(),
                    note: Some("Theory + papers".to_string()),
                },
                WorkflowStep {
                    agent: "novalbos".to_string(),
                    note: Some("Deep dive".to_string()),
                },
                WorkflowStep {
                    agent: "don-claudio".to_string(),
                    note: Some("Translate to design".to_string()),
                },
                WorkflowStep {
                    agent: "terry-davis".to_string(),
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
                    agent: "don-claudio".to_string(),
                    note: Some("Multiplayer / engine architect".to_string()),
                },
                WorkflowStep {
                    agent: "ue5-dev".to_string(),
                    note: Some("Context discovery".to_string()),
                },
                WorkflowStep {
                    agent: "terry-davis".to_string(),
                    note: Some("TDD C++/C#".to_string()),
                },
                WorkflowStep {
                    agent: "kirkardo".to_string(),
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
                    agent: "novalbos".to_string(),
                    note: Some("Deep explanation + notes".to_string()),
                },
                WorkflowStep {
                    agent: "terry-davis".to_string(),
                    note: Some("Working example".to_string()),
                },
                WorkflowStep {
                    agent: "kirkardo".to_string(),
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
        let wf = list_workflows_inner();
        assert_eq!(wf.len(), 7);
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
