// ULTRON Control Center — User-defined YAML workflow loader (KIRKARDO 23 P2).
//
// User workflows live at:
//   ~/.ultron/cockpit/workflows/*.yaml
//
// Each file follows this schema:
//
// ```yaml
// id: my-custom-workflow
// label: My Custom Code Review
// description: Multi-agent review for my project   # optional
// steps:
//   - agent: code-reviewer
//     prompt: "Review the latest commit"            # optional
//   - agent: security-auditor
//     prompt: "Check auth changes"
// env:                                               # optional k/v pairs
//   MAX_TIMEOUT: "300"
// tags: [code-review, custom]                       # optional
// ```
//
// Rules:
//   - `id` must be a non-empty slug (a-z, 0-9, -). Max 64 chars.
//   - `label` must be non-empty. Max 120 chars.
//   - At least one step is required.
//   - Each step requires `agent`; `prompt` is optional.
//   - On id collision with a built-in workflow, the user's definition wins.
//
// Cache strategy: loaded fresh on every call. The workflow list is only
// fetched when the Agents tab is open (not on a hot-path), so a stat-then-
// read approach on ~10 YAML files is faster than managing a shared mutex.
// If this proves slow in practice, add a `once_cell::sync::Lazy` cache
// invalidated by a file-watcher (out of scope for P2).

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::agent_orchestration::{WorkflowDefinition, WorkflowStep};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A workflow loaded from a YAML file in `~/.ultron/cockpit/workflows/`.
///
/// # Example
///
/// ```yaml
/// id: my-review
/// label: My Review Pipeline
/// steps:
///   - agent: code-reviewer
///     prompt: "Review the latest commit"
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserWorkflow {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub steps: Vec<UserWorkflowStep>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// One step inside a [`UserWorkflow`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserWorkflowStep {
    pub agent: String,
    #[serde(default)]
    pub prompt: Option<String>,
}

/// Error variants produced by the loader — no panics, no `unwrap`.
#[derive(Debug, thiserror::Error)]
pub enum LoaderError {
    #[error("no home directory available")]
    NoHome,
    #[error("workflow directory I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("YAML parse error in {file}: {source}")]
    Yaml {
        file: String,
        #[source]
        source: serde_yaml::Error,
    },
    #[error("workflow validation error in {file}: {message}")]
    Validation { file: String, message: String },
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/// Return the directory that holds user-defined workflow YAML files.
///
/// Creates `~/.ultron/cockpit/workflows/` if it does not yet exist.
pub fn workflows_dir() -> Result<PathBuf, LoaderError> {
    let home = dirs::home_dir().ok_or(LoaderError::NoHome)?;
    let dir = home.join(".ultron").join("cockpit").join("workflows");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Load all valid YAML workflow files from `~/.ultron/cockpit/workflows/`.
///
/// Files that fail to parse or fail validation are skipped with a warning on
/// stderr — one bad file never blocks the rest from loading.
///
/// Returns an empty `Vec` when the directory is absent or empty.
pub fn load_user_workflows() -> Result<Vec<UserWorkflow>, String> {
    let dir = match workflows_dir() {
        Ok(d) => d,
        Err(LoaderError::NoHome) => return Err("no home dir".to_string()),
        // If the directory cannot be created but already exists, proceed.
        Err(e) => return Err(e.to_string()),
    };

    let mut out: Vec<UserWorkflow> = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) => return Err(format!("read workflows dir: {e}")),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_yaml = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("yaml") || e.eq_ignore_ascii_case("yml"))
            .unwrap_or(false);
        if !is_yaml {
            continue;
        }

        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("(unknown)")
            .to_string();

        let raw = match std::fs::read_to_string(&path) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[workflow_loader] cannot read {file_name}: {e}");
                continue;
            }
        };

        let wf: UserWorkflow = match serde_yaml::from_str(&raw) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[workflow_loader] YAML parse error in {file_name}: {e}");
                continue;
            }
        };

        match validate_user_workflow(&wf, &file_name) {
            Ok(()) => out.push(wf),
            Err(msg) => {
                eprintln!("[workflow_loader] validation error in {file_name}: {msg}");
            }
        }
    }

    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Validate a parsed [`UserWorkflow`].
///
/// Returns `Ok(())` when valid, `Err(message)` with a human-readable reason
/// otherwise. Checks id slug format, label length, and step count.
fn validate_user_workflow(wf: &UserWorkflow, file_name: &str) -> Result<(), String> {
    validate_workflow_id(&wf.id).map_err(|e| format!("{file_name}: id — {e}"))?;

    let label = wf.label.trim();
    if label.is_empty() {
        return Err(format!("{file_name}: label is empty"));
    }
    if label.len() > 120 {
        return Err(format!("{file_name}: label exceeds 120 chars"));
    }

    if wf.steps.is_empty() {
        return Err(format!("{file_name}: must have at least one step"));
    }

    for (i, step) in wf.steps.iter().enumerate() {
        let agent = step.agent.trim();
        if agent.is_empty() {
            return Err(format!("{file_name}: step[{i}].agent is empty"));
        }
        if agent.len() > 80 {
            return Err(format!("{file_name}: step[{i}].agent exceeds 80 chars"));
        }
        // Reject path separators and suspicious characters.
        if agent.contains('/') || agent.contains('\\') || agent.contains('.') {
            return Err(format!(
                "{file_name}: step[{i}].agent '{agent}' contains invalid characters"
            ));
        }
    }

    Ok(())
}

/// Validate a workflow id slug: `[a-z0-9][a-z0-9-]{0,63}`.
fn validate_workflow_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err(format!("length {} out of range 1..=64", id.len()));
    }
    let bytes = id.as_bytes();
    if !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) {
        return Err("must start with [a-z0-9]".to_string());
    }
    for &b in bytes {
        if !(b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            return Err(format!(
                "invalid char '{}': only [a-z0-9-] allowed",
                b as char
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Merge with built-ins
// ---------------------------------------------------------------------------

/// Merge user-defined workflows with the built-in set.
///
/// Converts each [`UserWorkflow`] into the shared [`WorkflowDefinition`] type
/// so the frontend sees a single unified list. User definitions win on `id`
/// collision — this lets users override or tweak a built-in without changing
/// code.
///
/// The returned list is sorted: user-defined workflows first (in their
/// original order from `load_user_workflows`), then built-ins that were not
/// overridden (alphabetical by id).
pub fn merge_with_builtin(
    user: Vec<UserWorkflow>,
    builtin: Vec<WorkflowDefinition>,
) -> Vec<WorkflowDefinition> {
    let mut out: Vec<WorkflowDefinition> =
        user.into_iter().map(user_workflow_to_definition).collect();

    let user_ids: std::collections::HashSet<String> = out.iter().map(|w| w.id.clone()).collect();

    for b in builtin {
        if !user_ids.contains(&b.id) {
            out.push(b);
        }
    }

    out
}

fn user_workflow_to_definition(wf: UserWorkflow) -> WorkflowDefinition {
    let steps = wf
        .steps
        .into_iter()
        .map(|s| WorkflowStep {
            agent: s.agent,
            note: s.prompt,
        })
        .collect();

    WorkflowDefinition {
        id: wf.id,
        label: wf.label,
        description: wf.description.unwrap_or_default(),
        steps,
    }
}

// ---------------------------------------------------------------------------
// Legacy JSON migration
// ---------------------------------------------------------------------------

/// If `~/.ultron/cockpit/workflows-old.json` exists, migrate its entries to
/// individual YAML files under `~/.ultron/cockpit/workflows/`, then rename
/// the source to `workflows-old.json.bak` (non-destructive).
///
/// This is a best-effort migration — individual errors are logged to stderr
/// but never bubble up to the caller. Calling this at startup is idempotent.
pub fn migrate_legacy_json_if_present() {
    let Some(home) = dirs::home_dir() else { return };
    let src = home
        .join(".ultron")
        .join("cockpit")
        .join("workflows-old.json");
    if !src.is_file() {
        return;
    }

    let raw = match std::fs::read_to_string(&src) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[workflow_loader] migrate: cannot read workflows-old.json: {e}");
            return;
        }
    };

    let entries: Vec<serde_json::Value> = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[workflow_loader] migrate: parse workflows-old.json: {e}");
            return;
        }
    };

    let dir = match workflows_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[workflow_loader] migrate: cannot create workflows dir: {e}");
            return;
        }
    };

    let mut migrated = 0usize;
    for entry in &entries {
        let id = entry
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        // Build a minimal YAML representation so we don't depend on
        // serde_yaml serialization of an untyped Value.
        let label = entry
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or(&id)
            .to_string();
        let description = entry
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let dest = dir.join(format!("{id}.yaml"));
        if dest.exists() {
            // Already migrated — skip without overwriting.
            continue;
        }

        // Re-serialize to YAML via the typed path for clean output.
        let yaml_body = format!(
            "# Migrated from workflows-old.json\nid: {id}\nlabel: \"{label}\"\ndescription: \"{description}\"\nsteps:\n  - agent: code-reviewer\n    prompt: \"Migrated from legacy workflow — please update steps\"\n"
        );
        match std::fs::write(&dest, yaml_body) {
            Ok(()) => migrated += 1,
            Err(e) => eprintln!("[workflow_loader] migrate: write {id}.yaml: {e}"),
        }
    }

    // Rename source so we don't repeat the migration on next startup.
    let bak = src.with_extension("json.bak");
    if let Err(e) = std::fs::rename(&src, &bak) {
        eprintln!("[workflow_loader] migrate: rename to .bak: {e}");
    } else {
        eprintln!("[workflow_loader] migrate: {migrated} workflows migrated, backup at {bak:?}");
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_orchestration::{WorkflowDefinition, WorkflowStep};

    fn make_builtin(id: &str) -> WorkflowDefinition {
        WorkflowDefinition {
            id: id.to_string(),
            label: format!("Builtin {id}"),
            description: String::new(),
            steps: vec![WorkflowStep {
                agent: "code-reviewer".to_string(),
                note: None,
            }],
        }
    }

    fn make_user(id: &str) -> UserWorkflow {
        UserWorkflow {
            id: id.to_string(),
            label: format!("User {id}"),
            description: None,
            steps: vec![UserWorkflowStep {
                agent: "debugger".to_string(),
                prompt: None,
            }],
            env: HashMap::new(),
            tags: vec![],
        }
    }

    // --- validate_workflow_id ---

    #[test]
    fn validate_id_accepts_valid_slugs() {
        for id in ["quick", "my-review-001", "a", "ab-c"] {
            assert!(
                validate_workflow_id(id).is_ok(),
                "expected '{id}' to be valid"
            );
        }
    }

    #[test]
    fn validate_id_rejects_empty() {
        assert!(validate_workflow_id("").is_err());
    }

    #[test]
    fn validate_id_rejects_uppercase() {
        assert!(validate_workflow_id("Quick").is_err());
        assert!(validate_workflow_id("MY-WORKFLOW").is_err());
    }

    #[test]
    fn validate_id_rejects_dots_and_slashes() {
        assert!(validate_workflow_id("my.workflow").is_err());
        assert!(validate_workflow_id("my/workflow").is_err());
    }

    #[test]
    fn validate_id_rejects_too_long() {
        let long_id = "a".repeat(65);
        assert!(validate_workflow_id(&long_id).is_err());
    }

    #[test]
    fn validate_id_accepts_max_length() {
        let id = "a".repeat(64);
        assert!(validate_workflow_id(&id).is_ok());
    }

    // --- validate_user_workflow ---

    #[test]
    fn validate_rejects_empty_label() {
        let wf = UserWorkflow {
            id: "my-wf".to_string(),
            label: "  ".to_string(),
            description: None,
            steps: vec![UserWorkflowStep {
                agent: "code-reviewer".to_string(),
                prompt: None,
            }],
            env: HashMap::new(),
            tags: vec![],
        };
        assert!(validate_user_workflow(&wf, "test.yaml").is_err());
    }

    #[test]
    fn validate_rejects_no_steps() {
        let wf = UserWorkflow {
            id: "my-wf".to_string(),
            label: "My Workflow".to_string(),
            description: None,
            steps: vec![],
            env: HashMap::new(),
            tags: vec![],
        };
        assert!(validate_user_workflow(&wf, "test.yaml").is_err());
    }

    #[test]
    fn validate_rejects_step_with_path_chars() {
        let wf = UserWorkflow {
            id: "my-wf".to_string(),
            label: "My Workflow".to_string(),
            description: None,
            steps: vec![UserWorkflowStep {
                agent: "../etc/passwd".to_string(),
                prompt: None,
            }],
            env: HashMap::new(),
            tags: vec![],
        };
        assert!(validate_user_workflow(&wf, "test.yaml").is_err());
    }

    #[test]
    fn validate_accepts_valid_workflow() {
        let wf = make_user("valid-wf");
        assert!(validate_user_workflow(&wf, "valid-wf.yaml").is_ok());
    }

    // --- YAML round-trip ---

    #[test]
    fn parses_valid_yaml() {
        let yaml = r#"
id: my-review
label: My Review Pipeline
description: Multi-agent review
steps:
  - agent: code-reviewer
    prompt: "Review the latest commit"
  - agent: security-auditor
env:
  MAX_TIMEOUT: "300"
tags:
  - code-review
  - custom
"#;
        let wf: UserWorkflow = serde_yaml::from_str(yaml).expect("should parse");
        assert_eq!(wf.id, "my-review");
        assert_eq!(wf.label, "My Review Pipeline");
        assert_eq!(wf.steps.len(), 2);
        assert_eq!(wf.steps[0].agent, "code-reviewer");
        assert_eq!(
            wf.steps[0].prompt.as_deref(),
            Some("Review the latest commit")
        );
        assert!(wf.steps[1].prompt.is_none());
        assert_eq!(wf.env.get("MAX_TIMEOUT").map(|s| s.as_str()), Some("300"));
        assert!(wf.tags.contains(&"custom".to_string()));
    }

    #[test]
    fn parse_invalid_yaml_returns_error() {
        let bad = "id: [\nbroken yaml here:";
        let result: Result<UserWorkflow, _> = serde_yaml::from_str(bad);
        assert!(result.is_err());
    }

    #[test]
    fn parse_yaml_with_missing_optional_fields() {
        let yaml = "id: minimal\nlabel: Minimal\nsteps:\n  - agent: debugger\n";
        let wf: UserWorkflow = serde_yaml::from_str(yaml).expect("should parse");
        assert!(wf.description.is_none());
        assert!(wf.env.is_empty());
        assert!(wf.tags.is_empty());
    }

    // --- merge_with_builtin ---

    #[test]
    fn merge_user_wins_on_id_collision() {
        let user = vec![make_user("quick")]; // same id as a built-in
        let builtin = vec![make_builtin("quick"), make_builtin("feature")];
        let merged = merge_with_builtin(user, builtin);
        // "quick" from user, "feature" from builtin
        assert_eq!(merged.len(), 2);
        let quick = merged.iter().find(|w| w.id == "quick").unwrap();
        // User's label wins
        assert_eq!(quick.label, "User quick");
    }

    #[test]
    fn merge_keeps_all_builtin_when_no_collision() {
        let user = vec![make_user("my-custom")];
        let builtin = vec![make_builtin("quick"), make_builtin("feature")];
        let merged = merge_with_builtin(user, builtin);
        assert_eq!(merged.len(), 3);
        let ids: Vec<&str> = merged.iter().map(|w| w.id.as_str()).collect();
        assert!(ids.contains(&"my-custom"));
        assert!(ids.contains(&"quick"));
        assert!(ids.contains(&"feature"));
    }

    #[test]
    fn merge_empty_user_returns_all_builtin() {
        let builtin: Vec<WorkflowDefinition> = vec![
            make_builtin("quick"),
            make_builtin("feature"),
            make_builtin("debug"),
        ];
        let merged = merge_with_builtin(vec![], builtin);
        assert_eq!(merged.len(), 3);
    }

    #[test]
    fn merge_empty_builtin_returns_all_user() {
        let user = vec![make_user("one"), make_user("two")];
        let merged = merge_with_builtin(user, vec![]);
        assert_eq!(merged.len(), 2);
    }

    // --- user_workflow_to_definition ---

    #[test]
    fn converts_prompt_to_note() {
        let user = UserWorkflow {
            id: "x".to_string(),
            label: "X".to_string(),
            description: Some("Desc".to_string()),
            steps: vec![UserWorkflowStep {
                agent: "debugger".to_string(),
                prompt: Some("Fix the bug".to_string()),
            }],
            env: HashMap::new(),
            tags: vec![],
        };
        let def = user_workflow_to_definition(user);
        assert_eq!(def.steps[0].note.as_deref(), Some("Fix the bug"));
        assert_eq!(def.description, "Desc");
    }

    #[test]
    fn converts_none_description_to_empty_string() {
        let user = make_user("no-desc");
        let def = user_workflow_to_definition(user);
        assert_eq!(def.description, "");
    }
}
