// ULTRON Control Center — Per-project agent orchestration.
//
// Two operations:
//
//   1. `propose_roster_inner` — reads the project's manifest files (CLAUDE.md,
//      package.json, Cargo.toml, pyproject.toml), detects the stack, lists the
//      available agents on disk, and asks the AI Router (zone "utility") to
//      produce a recommended roster + gap list.  The result is NOT persisted
//      automatically; the frontend shows a confirmation modal first.
//
//   2. `invoke_from_session_inner` — finds the most recent running PTY for the
//      given project_id, then writes a sub-agent delegation line into it.
//      Claude Code (running inside that PTY) picks up the text, spawns the
//      named sub-agent, and streams the output back through the same terminal.
//
// Roster persistence lives at:
//   ~/.ultron/cockpit/projects/<project_id>/agent-roster.json
//
// The JSON shape is `AgentRosterFile { entries: Vec<RosterEntry> }`, the same
// struct returned by `propose_roster_inner` after the user confirms so the UI
// and the persistence layer share one type.

use std::fs;
use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::agents::AgentEntry;
use crate::skills::SkillEntry;
use crate::ultron_root;

// ---------------------------------------------------------------------------
// Public types (serialised to/from the frontend via Tauri IPC)
// ---------------------------------------------------------------------------

/// One agent the AI recommends for the project roster.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosterEntry {
    pub name: String,
    pub reason: String,
    /// Suggested role label (pre-populated in the role badge).
    pub suggested_role: String,
}

/// An agent that does not exist yet but the AI thinks would be valuable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GapEntry {
    pub suggested_name: String,
    pub reason: String,
}

/// Full AI proposal returned to the frontend confirmation modal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRosterProposal {
    pub recommended: Vec<RosterEntry>,
    pub gaps: Vec<GapEntry>,
    /// Stack tokens detected from the manifest files (displayed in the modal).
    pub detected_stack: Vec<String>,
}

/// Persisted roster file at
/// `~/.ultron/cockpit/projects/<id>/agent-roster.json`.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct AgentRosterFile {
    pub entries: Vec<RosterEntry>,
}

/// Result of writing a sub-agent invocation into an active PTY.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvokeResult {
    /// PTY session id the command was written to.
    pub pty_id: String,
    /// true if the write succeeded.
    pub sent: bool,
}

// ---------------------------------------------------------------------------
// Skill roster types (mirror of agent roster, returned by propose_skill_roster)
// ---------------------------------------------------------------------------

/// One skill the AI recommends activating for the project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRosterEntry {
    pub name: String,
    pub reason: String,
    /// Tags surfaced from the skill's frontmatter (informational for the UI).
    pub tags: Vec<String>,
}

/// Full AI proposal for the project's skill set, returned to the frontend
/// confirmation modal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRosterProposal {
    pub recommended: Vec<SkillRosterEntry>,
    /// Stack tokens used to produce the recommendation.
    pub detected_stack: Vec<String>,
}

// ---------------------------------------------------------------------------
// Roster persistence helpers
// ---------------------------------------------------------------------------

fn roster_path(project_id: &str) -> Result<PathBuf, String> {
    let root = ultron_root()?;
    Ok(root
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("agent-roster.json"))
}

pub fn roster_load(project_id: &str) -> Result<AgentRosterFile, String> {
    let path = roster_path(project_id)?;
    if !path.exists() {
        return Ok(AgentRosterFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read roster: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse roster: {e}"))
}

pub fn roster_save(project_id: &str, file: &AgentRosterFile) -> Result<(), String> {
    let path = roster_path(project_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(file).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Stack detection — reads manifest files in the project directory
// ---------------------------------------------------------------------------

fn read_head(path: &std::path::Path, max_bytes: usize) -> String {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.chars().take(max_bytes).collect())
        .unwrap_or_default()
}

/// Returns a deduplicated, sorted list of detected technology tokens.
/// Reads CLAUDE.md, package.json, Cargo.toml, pyproject.toml, go.mod from
/// `project_path`.  Each file contributes at most its first 2000 chars to
/// avoid over-reading monorepo package-locks.
pub fn detect_stack(project_path: &str) -> Vec<String> {
    let root = std::path::Path::new(project_path);
    let mut corpus = String::new();

    for file in &[
        "CLAUDE.md",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "go.mod",
        "build.gradle",
        "pom.xml",
    ] {
        let p = root.join(file);
        if p.is_file() {
            let snippet = read_head(&p, 2_000);
            corpus.push(' ');
            corpus.push_str(&snippet);
        }
    }

    let hay = corpus.to_lowercase();
    let mut detected: std::collections::BTreeSet<String> = Default::default();

    let tokens: &[(&str, &str)] = &[
        ("rust", "rust"),
        ("cargo", "rust"),
        ("[package]", "rust"),
        ("typescript", "typescript"),
        ("\"tsx\"", "typescript"),
        ("react", "react"),
        ("next.js", "next.js"),
        ("nextjs", "next.js"),
        ("vue", "vue"),
        ("svelte", "svelte"),
        ("python", "python"),
        ("fastapi", "python"),
        ("django", "python"),
        ("flask", "python"),
        ("go ", "go"),
        ("golang", "go"),
        ("module ", "go"),          // go.mod starts with "module"
        ("java", "java"),
        ("spring", "java"),
        ("kotlin", "kotlin"),
        ("swift", "swift"),
        ("c++", "cpp"),
        ("#include", "cpp"),
        ("cmake", "cpp"),
        ("unreal", "unreal"),
        ("unity", "unity"),
        ("tauri", "tauri"),
        ("electron", "electron"),
        ("postgres", "postgres"),
        ("postgresql", "postgres"),
        ("sqlite", "sqlite"),
        ("redis", "redis"),
        ("docker", "docker"),
        ("kubernetes", "kubernetes"),
        ("terraform", "terraform"),
    ];

    for (keyword, label) in tokens {
        if hay.contains(keyword) {
            detected.insert(label.to_string());
        }
    }

    detected.into_iter().collect()
}

// ---------------------------------------------------------------------------
// List available agents with their descriptions from ~/.claude/agents/*.md
// ---------------------------------------------------------------------------

/// Returns `(name, description)` pairs for every enabled agent `.md` file.
/// Falls back to an empty description when the frontmatter is absent.
///
/// Used by [`propose_roster_inner`] so the LLM receives full context instead
/// of just a stem name.
fn list_available_agents_with_desc() -> Vec<(String, String)> {
    // Reuse the richer origin-aware listing from the agents module.
    let entries: Vec<AgentEntry> =
        crate::agents::list_agents_with_origin_inner(None).unwrap_or_default();
    let mut pairs: Vec<(String, String)> = entries
        .into_iter()
        .filter(|e| e.enabled)
        .map(|e| (e.name, e.description))
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    pairs
}

// ---------------------------------------------------------------------------
// Read project CLAUDE.md (first 500 chars)
// ---------------------------------------------------------------------------

fn read_project_claude_md(project_path: &str) -> String {
    let p = std::path::Path::new(project_path).join("CLAUDE.md");
    read_head(&p, 500)
}

// ---------------------------------------------------------------------------
// AI-assisted roster proposal
// ---------------------------------------------------------------------------

/// Fallback: build a deterministic proposal when the AI Router is unavailable
/// or returns unparseable JSON.  Selects the first 7 agents from the available
/// list that fuzzy-match the detected stack tokens.
fn fallback_proposal(stack: &[String], agents: &[(String, String)]) -> AgentRosterProposal {
    // Baseline agents useful on every project.
    let baseline = [
        ("code-reviewer", "Code reviewer"),
        ("debugger", "Debugger"),
        ("security-auditor", "Security auditor"),
        ("architect-reviewer", "Architect"),
    ];
    // Stack-to-agent prefix hints.
    let stack_hints: Vec<(&str, &str)> = stack
        .iter()
        .flat_map(|s| match s.as_str() {
            "rust" => vec![("rust-engineer", "Rust specialist")],
            "typescript" | "react" => vec![
                ("typescript-pro", "TypeScript specialist"),
                ("react-specialist", "React specialist"),
            ],
            "python" => vec![("python-pro", "Python specialist")],
            "go" => vec![("golang-pro", "Go specialist")],
            "cpp" => vec![("cpp-pro", "C++ specialist")],
            _ => vec![],
        })
        .collect();

    let by_name: std::collections::HashSet<&str> =
        agents.iter().map(|(n, _)| n.as_str()).collect();
    let mut recommended: Vec<RosterEntry> = Vec::new();
    let mut used: std::collections::HashSet<String> = Default::default();

    let add = |slug: &str,
               role: &str,
               reason: &str,
               rec: &mut Vec<RosterEntry>,
               used: &mut std::collections::HashSet<String>| {
        if used.contains(slug) {
            return;
        }
        if by_name.contains(slug) {
            rec.push(RosterEntry {
                name: slug.to_string(),
                reason: reason.to_string(),
                suggested_role: role.to_string(),
            });
            used.insert(slug.to_string());
        }
    };

    for (slug, role) in &stack_hints {
        if recommended.len() >= 7 {
            break;
        }
        add(
            slug,
            role,
            &format!("Detected {} in project", role),
            &mut recommended,
            &mut used,
        );
    }
    for (slug, role) in &baseline {
        if recommended.len() >= 7 {
            break;
        }
        add(slug, role, "Universal baseline agent", &mut recommended, &mut used);
    }

    AgentRosterProposal {
        recommended,
        gaps: Vec::new(),
        detected_stack: stack.to_vec(),
    }
}

/// Parse the structured JSON the AI is asked to return.
/// Expected shape:
/// ```json
/// {
///   "recommended": [{"name": "...", "reason": "...", "suggested_role": "..."}],
///   "gaps": [{"suggested_name": "...", "reason": "..."}]
/// }
/// ```
fn parse_ai_response(
    raw: &str,
    stack: Vec<String>,
) -> Result<AgentRosterProposal, String> {
    // The model may wrap the JSON in a markdown fence — strip it.
    let trimmed = raw.trim();
    let json_str = if let Some(s) = trimmed.strip_prefix("```json") {
        s.trim_end_matches("```").trim()
    } else if let Some(s) = trimmed.strip_prefix("```") {
        s.trim_end_matches("```").trim()
    } else {
        trimmed
    };

    let v: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("JSON parse: {e}"))?;

    let recommended = v["recommended"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    Some(RosterEntry {
                        name: item["name"].as_str()?.to_string(),
                        reason: item["reason"].as_str().unwrap_or("").to_string(),
                        suggested_role: item["suggested_role"]
                            .as_str()
                            .unwrap_or("Specialist")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let gaps = v["gaps"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    Some(GapEntry {
                        suggested_name: item["suggested_name"].as_str()?.to_string(),
                        reason: item["reason"].as_str().unwrap_or("").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(AgentRosterProposal {
        recommended,
        gaps,
        detected_stack: stack,
    })
}

/// Core logic for the `project_propose_agent_roster` Tauri command.
///
/// Uses [`list_available_agents_with_desc`] so the LLM prompt includes each
/// agent's real description instead of just its slug name.  This dramatically
/// improves recommendation quality because the model no longer has to guess
/// what e.g. `ultron-perf` does from the name alone.
pub fn propose_roster_inner(
    project_id: &str,
    project_path: &str,
) -> Result<AgentRosterProposal, String> {
    let stack = detect_stack(project_path);
    let claude_md = read_project_claude_md(project_path);
    let agents = list_available_agents_with_desc();

    if agents.is_empty() {
        return Err("No agents found under ~/.claude/agents/ — install agents first.".to_string());
    }

    // Current roster so the AI does not re-suggest already-pinned agents.
    let current_roster = roster_load(project_id)?;
    let pinned_names: Vec<&str> =
        current_roster.entries.iter().map(|e| e.name.as_str()).collect();

    // Build a human-readable catalogue: "rust-engineer — Rust systems / Tauri backend"
    let agents_catalogue = agents
        .iter()
        .map(|(name, desc)| {
            if desc.is_empty() {
                name.clone()
            } else {
                // Truncate descriptions at 80 chars to keep the prompt compact.
                let short: String = desc.chars().take(80).collect();
                format!("{name} — {short}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Plain name list for the "only suggest names from this list" constraint.
    let names_only: Vec<&str> = agents.iter().map(|(n, _)| n.as_str()).collect();
    let names_list = names_only.join(", ");

    let stack_str = if stack.is_empty() {
        "unknown (no manifest files detected)".to_string()
    } else {
        stack.join(", ")
    };
    let already_str = if pinned_names.is_empty() {
        "none".to_string()
    } else {
        pinned_names.join(", ")
    };
    let claude_md_snippet = if claude_md.is_empty() {
        "(no CLAUDE.md)".to_string()
    } else {
        claude_md
    };

    let prompt = format!(
        "You are an expert software team lead. Analyse a project and propose the optimal agent roster.\n\n\
         Stack detected: {stack_str}\n\
         CLAUDE.md snippet: {claude_md_snippet}\n\
         Available agents (name — description):\n{agents_catalogue}\n\n\
         Valid agent names (ONLY use names from this list): {names_list}\n\
         Already in roster: {already_str}\n\n\
         Rules:\n\
         - Recommend 5-8 agents NOT already in the roster.\n\
         - ONLY suggest agents whose name appears in 'Valid agent names'.\n\
         - Use the descriptions above to pick agents that best fit the stack.\n\
         - For each agent provide a concise reason (max 15 words) and a suggested_role label.\n\
         - In 'gaps', list 1-3 agent names that do NOT exist yet but would be highly valuable for this stack.\n\n\
         Respond with ONLY valid JSON, no markdown fences, no prose:\n\
         {{\"recommended\":[{{\"name\":\"...\",\"reason\":\"...\",\"suggested_role\":\"...\"}}],\
         \"gaps\":[{{\"suggested_name\":\"...\",\"reason\":\"...\"}}]}}"
    );

    match crate::ai_router::route("utility", &prompt) {
        Ok(raw) => match parse_ai_response(&raw, stack.clone()) {
            Ok(proposal) => Ok(proposal),
            Err(_) => Ok(fallback_proposal(&stack, &agents)),
        },
        Err(_) => Ok(fallback_proposal(&stack, &agents)),
    }
}

// ---------------------------------------------------------------------------
// Invoke agent from active PTY session
// ---------------------------------------------------------------------------

/// Write a sub-agent delegation line into the most-recent running PTY for
/// `project_id`.  The text is a plain-text instruction that Claude Code
/// (running inside that PTY) interprets as a sub-agent task.
///
/// Session selection: `pty::list_inner` returns all PTYs for the project.
/// We pick the one with `status == Running` whose `started_at` is lexically
/// largest (the iso-epoch format "epoch:<secs>" sorts correctly that way).
pub fn invoke_from_session_inner(
    project_id: &str,
    agent_name: &str,
    task_prompt: &str,
) -> Result<InvokeResult, String> {
    use crate::pty::{list_inner, write_inner, PtyStatus};

    let sessions = list_inner(project_id.to_string())?;

    let active = sessions
        .iter()
        .filter(|s| s.status == PtyStatus::Running)
        .max_by(|a, b| a.started_at.cmp(&b.started_at))
        .ok_or_else(|| {
            format!(
                "No active terminal session for project '{}'. \
                 Open a terminal session first from the Terminal tab.",
                project_id
            )
        })?;

    let pty_id = active.id.clone();

    // Build the delegation text.  Claude Code understands natural-language
    // sub-agent instructions — "Use the X agent to: <task>" is idiomatic.
    let instruction = format!(
        "Use the {agent_name} agent to: {task_prompt}\n"
    );

    // write_inner expects base64-encoded bytes.
    let engine = base64::engine::general_purpose::STANDARD;
    let encoded = engine.encode(instruction.as_bytes());
    write_inner(pty_id.clone(), encoded)?;

    Ok(InvokeResult {
        pty_id,
        sent: true,
    })
}

// ---------------------------------------------------------------------------
// AI-assisted skill roster proposal
// ---------------------------------------------------------------------------

/// Parse the structured JSON returned by the AI for skill recommendations.
///
/// Expected shape:
/// ```json
/// {
///   "recommended": [{"name": "...", "reason": "...", "tags": ["..."]}]
/// }
/// ```
fn parse_skill_ai_response(
    raw: &str,
    stack: Vec<String>,
) -> Result<SkillRosterProposal, String> {
    let trimmed = raw.trim();
    let json_str = if let Some(s) = trimmed.strip_prefix("```json") {
        s.trim_end_matches("```").trim()
    } else if let Some(s) = trimmed.strip_prefix("```") {
        s.trim_end_matches("```").trim()
    } else {
        trimmed
    };

    let v: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("JSON parse: {e}"))?;

    let recommended = v["recommended"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let name = item["name"].as_str()?.to_string();
                    let reason = item["reason"].as_str().unwrap_or("").to_string();
                    let tags = item["tags"]
                        .as_array()
                        .map(|t| {
                            t.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(SkillRosterEntry { name, reason, tags })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(SkillRosterProposal { recommended, detected_stack: stack })
}

/// Deterministic fallback for skill proposals when the AI Router is unavailable.
///
/// Matches skills whose name or description contains keywords derived from the
/// detected stack tokens.  `SkillEntry` does not carry tags (those live in the
/// separate `SkillInfo` / registry path) so we match against the description
/// text and the slug itself.
fn fallback_skill_proposal(stack: &[String], skills: &[SkillEntry]) -> SkillRosterProposal {
    // Keywords to search for in the skill name + description, keyed by stack token.
    let keyword_hints: &[(&str, &[&str])] = &[
        ("rust", &["rust", "cargo", "systems"]),
        ("typescript", &["typescript", "javascript", "ts"]),
        ("react", &["react", "frontend", "ui"]),
        ("python", &["python", "py", "django", "fastapi"]),
        ("go", &["golang", " go "]),
        ("cpp", &["c++", "cpp", "native"]),
        ("tauri", &["tauri", "desktop"]),
        ("postgres", &["postgres", "sql", "database"]),
        ("docker", &["docker", "container", "devops"]),
    ];

    let mut wanted_keywords: std::collections::HashSet<&str> = Default::default();
    for token in stack {
        for (key, kws) in keyword_hints {
            if token == key {
                wanted_keywords.extend(*kws);
            }
        }
    }

    if wanted_keywords.is_empty() {
        return SkillRosterProposal {
            recommended: Vec::new(),
            detected_stack: stack.to_vec(),
        };
    }

    let mut recommended: Vec<SkillRosterEntry> = Vec::new();
    for skill in skills {
        if recommended.len() >= 8 {
            break;
        }
        let haystack = format!("{} {}", skill.name, skill.description).to_ascii_lowercase();
        let matches = wanted_keywords.iter().any(|kw| haystack.contains(kw));
        if matches {
            recommended.push(SkillRosterEntry {
                name: skill.name.clone(),
                reason: format!("Description matches detected stack ({})", stack.join(", ")),
                tags: Vec::new(), // tags not available in SkillEntry; populated by LLM path
            });
        }
    }

    SkillRosterProposal {
        recommended,
        detected_stack: stack.to_vec(),
    }
}

/// Core logic for the `project_propose_skill_roster` Tauri command.
///
/// Mirrors [`propose_roster_inner`] for skills: reads the project stack from
/// manifest files, loads the full skill registry (name + description + tags),
/// and asks the AI Router to recommend the most relevant active skills.
///
/// The LLM receives real descriptions and tags so it can make informed
/// recommendations rather than guessing from slugs alone.
///
/// # Future work
/// TODO: semantic matching via Qdrant — index skill cards in the `catalog-skills`
/// collection and use vector similarity to rank suggestions instead of relying
/// on the LLM catalogue prompt.  This will matter once the skill count exceeds
/// ~200 and the prompt catalogue grows too large for the context window.
pub fn propose_skill_roster_inner(project_path: &str) -> Result<SkillRosterProposal, String> {
    let stack = detect_stack(project_path);

    // Load all skills from the registry (active + plugin layers).
    let all_skills: Vec<SkillEntry> =
        crate::skills::list_skills_with_origin_inner(Some(project_path.to_string()))
            .unwrap_or_default();

    // Only offer enabled skills to the LLM — no point recommending disabled ones.
    let active_skills: Vec<&SkillEntry> = all_skills.iter().filter(|s| s.enabled).collect();

    if active_skills.is_empty() {
        return Ok(SkillRosterProposal {
            recommended: Vec::new(),
            detected_stack: stack,
        });
    }

    // Build a catalogue line per skill: "name — description (first 80 chars)"
    // SkillEntry.description comes from the SKILL.md frontmatter.  Tags are
    // available only through the registry path (SkillInfo), but the description
    // is sufficient context for the LLM to make good recommendations.
    let catalogue = active_skills
        .iter()
        .map(|s| {
            let desc: String = s.description.chars().take(80).collect();
            format!("{} — {}", s.name, desc)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let valid_names: Vec<&str> = active_skills.iter().map(|s| s.name.as_str()).collect();
    let names_list = valid_names.join(", ");

    let stack_str = if stack.is_empty() {
        "unknown (no manifest files detected)".to_string()
    } else {
        stack.join(", ")
    };

    let prompt = format!(
        "You are an expert software team lead. Recommend the most relevant skills to activate \
         for a project.\n\n\
         Stack detected: {stack_str}\n\
         Available skills (name — description [tags]):\n{catalogue}\n\n\
         Valid skill names (ONLY use names from this list): {names_list}\n\n\
         Rules:\n\
         - Recommend 4-8 skills that best match the detected stack.\n\
         - ONLY suggest skills whose name appears in 'Valid skill names'.\n\
         - Use the descriptions and tags to pick the best fits.\n\
         - For each skill provide a concise reason (max 15 words) and include its tags array.\n\n\
         Respond with ONLY valid JSON, no markdown fences, no prose:\n\
         {{\"recommended\":[{{\"name\":\"...\",\"reason\":\"...\",\"tags\":[\"...\"]}}]}}"
    );

    let owned_active: Vec<SkillEntry> = active_skills.iter().map(|s| (*s).clone()).collect();

    match crate::ai_router::route("utility", &prompt) {
        Ok(raw) => match parse_skill_ai_response(&raw, stack.clone()) {
            Ok(proposal) => Ok(proposal),
            Err(_) => Ok(fallback_skill_proposal(&stack, &owned_active)),
        },
        Err(_) => Ok(fallback_skill_proposal(&stack, &owned_active)),
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::{SkillEntry, SkillOrigin};

    fn make_skill(name: &str, desc: &str) -> SkillEntry {
        SkillEntry {
            name: name.to_string(),
            path: format!("/fake/skills/{}", name),
            description: desc.to_string(),
            origin: SkillOrigin::Global,
            enabled: true,
        }
    }

    /// The fallback proposer must match skills whose name or description
    /// contains stack-relevant keywords, and must exclude unrelated ones.
    #[test]
    fn fallback_skill_proposal_returns_matches_for_rust_stack() {
        let stack = vec!["rust".to_string(), "tauri".to_string()];
        let skills = vec![
            make_skill("rust-patterns", "Idiomatic Rust patterns and cargo tips"),
            make_skill("tauri-helpers", "Tauri desktop integration helpers"),
            make_skill("python-typing", "Python type hints guide for modern code"),
            make_skill("react-hooks", "React hooks best practices for UI"),
        ];
        let proposal = fallback_skill_proposal(&stack, &skills);
        let names: Vec<&str> = proposal.recommended.iter().map(|e| e.name.as_str()).collect();
        assert!(
            names.contains(&"rust-patterns"),
            "rust-patterns expected in proposal, got: {names:?}"
        );
        assert!(
            names.contains(&"tauri-helpers"),
            "tauri-helpers expected in proposal, got: {names:?}"
        );
        assert!(
            !names.contains(&"python-typing"),
            "python-typing should NOT be in rust/tauri proposal, got: {names:?}"
        );
    }

    /// An empty stack must yield an empty proposal (no false positives).
    #[test]
    fn fallback_skill_proposal_empty_stack_returns_empty() {
        let skills = vec![make_skill("some-skill", "Some generic description")];
        let proposal = fallback_skill_proposal(&[], &skills);
        assert!(
            proposal.recommended.is_empty(),
            "empty stack should yield no recommendations"
        );
    }

    /// The AI response parser must accept clean JSON without a markdown fence.
    #[test]
    fn parse_skill_ai_response_parses_valid_json() {
        let raw = r#"{"recommended":[{"name":"rust-patterns","reason":"Rust project detected","tags":["rust"]}]}"#;
        let result = parse_skill_ai_response(raw, vec!["rust".to_string()]);
        assert!(result.is_ok());
        let proposal = result.unwrap();
        assert_eq!(proposal.recommended.len(), 1);
        assert_eq!(proposal.recommended[0].name, "rust-patterns");
        assert_eq!(proposal.recommended[0].tags, vec!["rust"]);
    }

    /// The AI response parser must strip ` ```json ` markdown fences.
    #[test]
    fn parse_skill_ai_response_strips_markdown_fence() {
        let raw = "```json\n{\"recommended\":[]}\n```";
        let result = parse_skill_ai_response(raw, vec![]);
        assert!(result.is_ok());
        assert!(result.unwrap().recommended.is_empty());
    }
}
