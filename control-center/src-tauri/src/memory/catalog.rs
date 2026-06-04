// ULTRON Control Center — Agent/Skill catalog index (MEMORY KERNEL · Auto-routing #7)
//
// The semantic catalog the orchestrator uses to pick a specialist agent (and,
// later, skill) for a prompt. Indexes ~/.claude/agents/*.md into the Qdrant
// collection `ultron_catalog` (E5 1024d), reusing the same embedding/index infra
// as `qdrant_index`. This REPLACES the dead `brain_index/index.db` FTS path the
// audit found (intent-dispatcher/agent_suggest no-op'd on a missing index).
//
// The kernel does NOT reinvent agents — it DELEGATES to the real ~78 agents in
// ~/.claude/agents/ and the ENABLED skills in ~/.claude/skills/ (+ project +
// plugin caches). This index is how it finds the right one by similarity.
//
// Both entities live in ONE collection, namespaced by point id (`agent::{name}`
// vs `skill::{name}`) and by an `entity` payload field, so a search can filter
// to agents, skills, or compete both. `index_agents` + `index_skills` are the
// two writers; `search_catalog` is the reader used by the orchestrator's
// `delegate_agents` path. `.disabled` skills are excluded (they must never be
// routed to).

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use serde::Serialize;

/// Qdrant collection holding the agent/skill catalog (E5 1024d).
pub const CATALOG_COLLECTION: &str = "ultron_catalog";

#[derive(Debug, Clone, Serialize)]
pub struct CatalogHit {
    pub entity: String, // "agent" | "skill"
    pub name: String,
    pub description: String,
    pub score: f32,
    /// Only present for skills: "persona" | "technical" | "meta". Empty for
    /// agents (which have no kind). Lets a caller weight a persona vs a
    /// technical skill without a second lookup.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub kind: String,
}

/// Deterministic non-zero u64 id from a key (so re-indexing upserts, not dups).
/// Qdrant point ids must be u64 or UUID — an agent name is neither, so we hash.
fn deterministic_id(key: &str) -> u64 {
    let mut h = DefaultHasher::new();
    key.hash(&mut h);
    h.finish() | 1
}

/// Parse `name` + `description` from a Claude agent/skill markdown frontmatter
/// (the YAML block delimited by `---`). Returns None when either is missing.
pub fn parse_frontmatter(content: &str) -> Option<(String, String)> {
    let trimmed = content.trim_start();
    let after = trimmed.strip_prefix("---")?;
    let end = after.find("\n---")?;
    let fm = &after[..end];

    let mut name: Option<String> = None;
    let mut desc: Option<String> = None;
    for line in fm.lines() {
        let line = line.trim_start();
        if let Some(v) = line.strip_prefix("name:") {
            name = Some(v.trim().trim_matches('"').trim_matches('\'').to_string());
        } else if let Some(v) = line.strip_prefix("description:") {
            desc = Some(v.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    match (name, desc) {
        (Some(n), Some(d)) if !n.is_empty() && !d.is_empty() => Some((n, d)),
        _ => None,
    }
}

fn agents_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("agents"))
}

/// The set of REAL agent names (filename stems) under `~/.claude/agents`. Used
/// to sanitize "ghost agents" referenced by workflow templates (planner/architect/
/// tdd-guide etc. don't exist on disk — KIRKARDO 11).
pub fn known_agent_names() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    if let Some(dir) = agents_dir() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("md") {
                    if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                        set.insert(stem.to_string());
                    }
                }
            }
        }
    }
    set
}

/// Index `~/.claude/agents/*.md` into `ultron_catalog`. Idempotent (id =
/// hash(name)). Warms up E5 first so a missing model surfaces as one clear error.
/// Returns `(indexed, errors)`.
pub fn index_agents() -> Result<(usize, usize), String> {
    let probe = crate::qdrant::embed_e5("warmup", false)?;
    if probe.iter().all(|&x| x == 0.0) {
        return Err("E5 model unavailable (zero vector) — cannot index catalog".to_string());
    }

    let dir = agents_dir().ok_or("no HOME dir")?;
    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;

    let mut ok = 0usize;
    let mut err = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => {
                err += 1;
                continue;
            }
        };
        let (name, description) = match parse_frontmatter(&content) {
            Some(x) => x,
            None => {
                err += 1;
                continue;
            }
        };
        // Embed name + description as a passage (E5 `passage:` prefix).
        let vector = match crate::qdrant::embed_e5(&format!("{name}: {description}"), false) {
            Ok(v) => v,
            Err(_) => {
                err += 1;
                continue;
            }
        };
        let mut payload: HashMap<String, serde_json::Value> = HashMap::new();
        payload.insert("entity".to_string(), "agent".into());
        payload.insert("name".to_string(), name.clone().into());
        payload.insert("description".to_string(), description.into());
        payload.insert("path".to_string(), path.display().to_string().into());

        let id = deterministic_id(&format!("agent::{name}")).to_string();
        match crate::qdrant::upsert_e5(CATALOG_COLLECTION, &id, vector, payload) {
            Ok(()) => ok += 1,
            Err(_) => err += 1,
        }
    }
    Ok((ok, err))
}

/// Classify a skill into a coarse `kind` so the orchestrator can weight a
/// persona (`alfred`, `terry-davis`, `jordan-belfort`…) differently from a
/// technical capability (`rust-patterns`, `docker-patterns`…) or a meta/workflow
/// skill (`council`, `superpowers`, `skill-creator`…). Heuristic only — the
/// authoritative signal is still the embedded description. Returns one of
/// `"persona" | "meta" | "technical"`.
fn classify_skill_kind(name: &str, description: &str) -> &'static str {
    let n = name.to_lowercase();
    let d = description.to_lowercase();

    // Personas declare themselves loudly in their descriptions ("Activa a X —",
    // "modo X", "el mayordomo", etc.). The cheapest reliable signal is the
    // "activa"/"activar" Spanish trigger verb most ULTRON personas use.
    let persona_markers = [
        "activa a ",
        "activar siempre",
        "modo ",
        "persona",
        "mayordomo",
        "padrino",
    ];
    if persona_markers.iter().any(|m| d.contains(m)) {
        return "persona";
    }

    // Meta / workflow / orchestration skills coordinate OTHER skills or the dev
    // process rather than carrying a single technical domain.
    let meta_names = [
        "council",
        "superpowers",
        "skill-creator",
        "consolidate-memory",
        "orchestrator",
        "ultron",
        "agentic",
        "autonomous",
        "continuous-agent",
        "hiper-plans",
        "prompt-optimizer",
        "second-opinion",
        "deep-research",
    ];
    if meta_names.iter().any(|m| n.contains(m)) {
        return "meta";
    }

    "technical"
}

/// Index ENABLED skills into `ultron_catalog` so they compete with agents in the
/// router. Discovery reuses `skills::list_skills_with_origin_inner(None)`, which
/// already enumerates the three real sources (`~/.claude/skills/*/SKILL.md`,
/// project `.claude/skills`, and plugin caches under `~/.claude/plugins`). Each
/// skill is upserted with:
///   - `entity = "skill"` (so `search_catalog(.., Some("skill"), ..)` can filter)
///   - `kind`  = persona | technical | meta (coarse weight signal)
///   - id      = deterministic_id("skill::{name}")  ← distinct namespace from
///               "agent::{name}" so a skill and an agent of the same name never
///               collide on the same Qdrant point.
///
/// `.disabled` skills are excluded: `list_skills_with_origin_inner` marks them
/// `enabled = false`, and we skip any skill that is not enabled or whose
/// description is empty (an empty description embeds to noise).
///
/// Idempotent (deterministic id → upsert, not duplicate). Warms E5 first so a
/// missing model surfaces as one clear error rather than N per-skill failures.
/// Returns `(indexed, errors)`.
pub fn index_skills() -> Result<(usize, usize), String> {
    let probe = crate::qdrant::embed_e5("warmup", false)?;
    if probe.iter().all(|&x| x == 0.0) {
        return Err("E5 model unavailable (zero vector) — cannot index skills".to_string());
    }

    let skills = crate::skills::list_skills_with_origin_inner(None)
        .map_err(|e| format!("list skills: {e}"))?;

    let mut ok = 0usize;
    let mut err = 0usize;
    for skill in skills {
        // Only ENABLED skills with a usable description should compete in the
        // router — a disabled skill must not be delegated to, and an empty
        // description embeds to noise.
        if !skill.enabled || skill.description.trim().is_empty() {
            continue;
        }
        let name = skill.name;
        let description = skill.description;
        let kind = classify_skill_kind(&name, &description);

        // Embed name + description as a passage (E5 `passage:` prefix), exactly
        // like agents, so query/passage geometry matches across both entities.
        let vector = match crate::qdrant::embed_e5(&format!("{name}: {description}"), false) {
            Ok(v) => v,
            Err(_) => {
                err += 1;
                continue;
            }
        };
        let mut payload: HashMap<String, serde_json::Value> = HashMap::new();
        payload.insert("entity".to_string(), "skill".into());
        payload.insert("name".to_string(), name.clone().into());
        payload.insert("description".to_string(), description.into());
        payload.insert("kind".to_string(), kind.into());
        payload.insert("path".to_string(), skill.path.into());

        let id = deterministic_id(&format!("skill::{name}")).to_string();
        match crate::qdrant::upsert_e5(CATALOG_COLLECTION, &id, vector, payload) {
            Ok(()) => ok += 1,
            Err(_) => err += 1,
        }
    }
    Ok((ok, err))
}

/// Semantic search over the catalog. `entity = Some("agent")` filters to agents
/// (None = any). Empty when E5/Qdrant unavailable. This is how the auto-router
/// maps a prompt to the best specialist agent to DELEGATE to.
pub fn search_catalog(query: &str, entity: Option<&str>, k: u32) -> Vec<CatalogHit> {
    let vector = match crate::qdrant::embed_e5(query, true) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    if vector.iter().all(|&x| x == 0.0) {
        return Vec::new();
    }
    let filter = entity
        .map(|e| serde_json::json!({ "must": [{ "key": "entity", "match": { "value": e } }] }));
    match crate::qdrant::search_with_vector(CATALOG_COLLECTION, vector, k, filter) {
        Ok(hits) => hits
            .into_iter()
            .map(|h| CatalogHit {
                entity: h
                    .payload
                    .get("entity")
                    .and_then(|v| v.as_str())
                    .unwrap_or("agent")
                    .to_string(),
                name: h
                    .payload
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                description: h
                    .payload
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                score: h.score,
                kind: h
                    .payload
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_frontmatter() {
        let md = "---\nname: code-reviewer\ndescription: \"Review code quality and security.\"\ntools: Read, Grep\nmodel: claude-opus-4-7\n---\n\nbody here";
        let (name, desc) = parse_frontmatter(md).expect("frontmatter");
        assert_eq!(name, "code-reviewer");
        assert_eq!(desc, "Review code quality and security.");
    }

    #[test]
    fn rejects_content_without_frontmatter() {
        assert!(parse_frontmatter("no frontmatter here").is_none());
        assert!(parse_frontmatter("---\nname: x\n---").is_none()); // no description
    }

    #[test]
    fn deterministic_id_is_stable_and_nonzero() {
        let a = deterministic_id("agent::code-reviewer");
        let b = deterministic_id("agent::code-reviewer");
        assert_eq!(a, b, "same key -> same id (idempotent upsert)");
        assert_ne!(a, 0);
        assert_ne!(a, deterministic_id("agent::debugger"));
    }

    #[test]
    fn skill_and_agent_namespaces_never_collide() {
        // A skill named "code-reviewer" and an agent named "code-reviewer" must
        // map to DIFFERENT Qdrant point ids — otherwise the skill upsert would
        // overwrite the agent's point in `ultron_catalog`.
        assert_ne!(
            deterministic_id("agent::code-reviewer"),
            deterministic_id("skill::code-reviewer"),
            "skill:: and agent:: must yield distinct ids for the same name"
        );
    }

    #[test]
    fn classify_skill_kind_detects_personas_meta_and_technical() {
        // Persona: ULTRON personas announce themselves with "Activa a … —".
        assert_eq!(
            classify_skill_kind(
                "alfred",
                "Activa a ALFRED — el mayordomo digital de USER."
            ),
            "persona"
        );
        // Meta / workflow skills coordinate other skills or the dev process.
        assert_eq!(
            classify_skill_kind("council", "Multi-perspective review."),
            "meta"
        );
        assert_eq!(
            classify_skill_kind("superpowers", "Workflow framework."),
            "meta"
        );
        // Plain technical capability with no persona/meta markers.
        assert_eq!(
            classify_skill_kind(
                "rust-patterns",
                "Idiomatic Rust ownership and trait patterns."
            ),
            "technical"
        );
    }

    // Indexes the REAL ~/.claude/agents and verifies semantic routing returns the
    // right specialist. Run: cargo test --lib -- --ignored --nocapture e2e_catalog
    #[test]
    #[ignore = "e2e: real ~/.claude/agents + Qdrant + E5"]
    fn e2e_catalog_index_and_route() {
        let (indexed, errors) = index_agents().expect("index_agents");
        eprintln!("\n=== CATALOG === indexed={indexed} errors={errors}");
        assert!(
            indexed >= 50,
            "expected the real agent catalog (~78) indexed"
        );

        let hits = search_catalog(
            "review my code for security vulnerabilities and quality",
            Some("agent"),
            5,
        );
        eprintln!("=== ROUTE 'review code security' ===");
        for h in &hits {
            eprintln!("  [{:.3}] {}", h.score, h.name);
        }
        assert!(!hits.is_empty(), "catalog search returned nothing");
        assert!(
            hits.iter()
                .take(5)
                .any(|h| h.name.contains("review") || h.name.contains("security")),
            "a code-review/security agent should rank in the top 5"
        );
    }

    // Indexes the REAL skills and verifies skills now COMPETE in the catalog.
    // Run: cargo test --lib --features qdrant -- --ignored --nocapture e2e_skills
    #[test]
    #[ignore = "e2e: real ~/.claude/skills + plugins + Qdrant + E5 (mutates ultron_catalog)"]
    fn e2e_skills_index_and_compete() {
        let (indexed, errors) = index_skills().expect("index_skills");
        eprintln!("\n=== SKILLS === indexed={indexed} errors={errors}");
        assert!(
            indexed >= 20,
            "expected the real skill catalog indexed (>=20)"
        );

        // entity=None must now return BOTH agents and skills (multi-entity route).
        let hits = search_catalog("design a beautiful UI with good UX", None, 10);
        eprintln!("=== ROUTE 'design UI/UX' (agents+skills) ===");
        for h in &hits {
            eprintln!(
                "  [{:.3}] {} ({}{})",
                h.score,
                h.name,
                h.entity,
                if h.kind.is_empty() {
                    String::new()
                } else {
                    format!("/{}", h.kind)
                }
            );
        }
        assert!(
            !hits.is_empty(),
            "multi-entity catalog search returned nothing"
        );
        assert!(
            hits.iter().any(|h| h.entity == "skill"),
            "at least one SKILL should compete in a multi-entity search"
        );
    }
}
