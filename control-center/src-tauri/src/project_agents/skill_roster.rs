// project_agents/skill_roster.rs — AI-assisted skill roster proposal.

use crate::skills::SkillEntry;

use super::stack_detect::detect_stack;
use super::types::{SkillRosterEntry, SkillRosterProposal};

// ---------------------------------------------------------------------------
// AI response parsing
// ---------------------------------------------------------------------------

/// Parse the structured JSON returned by the AI for skill recommendations.
///
/// Expected shape:
/// ```json
/// {
///   "recommended": [{"name": "...", "reason": "...", "tags": ["..."]}]
/// }
/// ```
fn parse_skill_ai_response(raw: &str, stack: Vec<String>) -> Result<SkillRosterProposal, String> {
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

    Ok(SkillRosterProposal {
        recommended,
        detected_stack: stack,
    })
}

// ---------------------------------------------------------------------------
// Fallback deterministic proposal
// ---------------------------------------------------------------------------

/// Deterministic fallback for skill proposals when the AI Router is unavailable.
///
/// Matches skills whose name or description contains keywords derived from the
/// detected stack tokens.  `SkillEntry` does not carry tags (those live in the
/// separate `SkillInfo` / registry path) so we match against the description
/// text and the slug itself.
pub fn fallback_skill_proposal(stack: &[String], skills: &[SkillEntry]) -> SkillRosterProposal {
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

// ---------------------------------------------------------------------------
// Core proposal logic (called by Tauri command)
// ---------------------------------------------------------------------------

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
        let names: Vec<&str> = proposal
            .recommended
            .iter()
            .map(|e| e.name.as_str())
            .collect();
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
