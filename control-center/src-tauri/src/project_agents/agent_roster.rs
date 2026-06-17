// project_agents/agent_roster.rs — AI-assisted agent roster proposal.

use crate::agents::AgentEntry;

use super::persistence::roster_load;
use super::stack_detect::{detect_stack, read_head};
use super::types::{AgentRosterProposal, GapEntry, RosterEntry};

// ---------------------------------------------------------------------------
// List available agents with their descriptions
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
// Fallback deterministic proposal
// ---------------------------------------------------------------------------

/// Fallback: build a deterministic proposal when the AI Router is unavailable
/// or returns unparseable JSON.  Selects the first 7 agents from the available
/// list that fuzzy-match the detected stack tokens.
pub fn fallback_proposal(stack: &[String], agents: &[(String, String)]) -> AgentRosterProposal {
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

    let by_name: std::collections::HashSet<&str> = agents.iter().map(|(n, _)| n.as_str()).collect();
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
        add(
            slug,
            role,
            "Universal baseline agent",
            &mut recommended,
            &mut used,
        );
    }

    AgentRosterProposal {
        recommended,
        gaps: Vec::new(),
        detected_stack: stack.to_vec(),
    }
}

// ---------------------------------------------------------------------------
// AI response parsing
// ---------------------------------------------------------------------------

/// Parse the structured JSON the AI is asked to return.
/// Expected shape:
/// ```json
/// {
///   "recommended": [{"name": "...", "reason": "...", "suggested_role": "..."}],
///   "gaps": [{"suggested_name": "...", "reason": "..."}]
/// }
/// ```
fn parse_ai_response(raw: &str, stack: Vec<String>) -> Result<AgentRosterProposal, String> {
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

// ---------------------------------------------------------------------------
// Core proposal logic (called by Tauri command)
// ---------------------------------------------------------------------------

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
    let pinned_names: Vec<&str> = current_roster
        .entries
        .iter()
        .map(|e| e.name.as_str())
        .collect();

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
