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

/// Read an agent's description from its frontmatter. Used by the orchestrator to
/// floor-inject preferred specialists that E5 retrieval (cross-lingual noise)
/// failed to surface in the raw top-k. None if the file is absent/malformed.
pub fn agent_description(name: &str) -> Option<String> {
    let dir = agents_dir()?;
    let content = std::fs::read_to_string(dir.join(format!("{name}.md"))).ok()?;
    parse_frontmatter(&content).map(|(_, d)| d)
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
///     "agent::{name}" so a skill and an agent of the same name never
///     collide on the same Qdrant point.
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

/// Qdrant collection holding ALL skills (enabled + disabled) for lazy-dispatch
/// evaluation. Separate from `ultron_catalog` so the orchestrator's active
/// routing is never contaminated with disabled skills.
pub const SKILLS_LAZY_COLLECTION: &str = "ultron_skills_lazy";

/// Index ALL skills (enabled AND disabled) into `ultron_skills_lazy` for
/// off-line accuracy evaluation of E5 vs mpnet routing. Disabled skills are
/// the ones the lazy dispatcher injects on-demand, so they must be present
/// here even though they are excluded from `ultron_catalog`.
///
/// Mirrors `index_skills` exactly, with three differences:
///   1. Calls `ensure_collection_dim` first (creates the collection if absent).
///   2. Does NOT skip disabled skills — every skill with a non-empty description
///      is indexed regardless of `enabled` status.
///   3. Adds an `enabled` boolean to the payload so callers can filter or weight
///      results downstream.
///
/// Idempotent (deterministic id = `deterministic_id("skill::{name}")`).
/// Returns `(indexed, errors)`.
pub fn index_skills_lazy() -> Result<(usize, usize), String> {
    crate::qdrant::ensure_collection_dim(SKILLS_LAZY_COLLECTION, 1024)?;

    let probe = crate::qdrant::embed_e5("warmup", false)?;
    if probe.iter().all(|&x| x == 0.0) {
        return Err("E5 model unavailable (zero vector) — cannot index skills lazy".to_string());
    }

    let skills = crate::skills::list_skills_with_origin_inner(None)
        .map_err(|e| format!("list skills: {e}"))?;

    let mut ok = 0usize;
    let mut err = 0usize;
    for skill in skills {
        // Index ALL skills — disabled ones are what the lazy dispatcher injects.
        // Only skip skills whose description is empty (embeds to noise).
        if skill.description.trim().is_empty() {
            continue;
        }
        let name = skill.name;
        let description = skill.description;
        let kind = classify_skill_kind(&name, &description);

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
        // Extra field (vs ultron_catalog): lets callers distinguish active from
        // lazy-only skills without a second lookup.
        payload.insert("enabled".to_string(), skill.enabled.into());

        let id = deterministic_id(&format!("skill::{name}")).to_string();
        match crate::qdrant::upsert_e5(SKILLS_LAZY_COLLECTION, &id, vector, payload) {
            Ok(()) => ok += 1,
            Err(_) => err += 1,
        }
    }
    Ok((ok, err))
}

/// Semantic search over `ultron_skills_lazy` (ALL skills, enabled + disabled).
/// No entity filter — every point in the collection is a skill. Returns up to
/// `k` hits ordered by cosine similarity descending (Qdrant guarantees this).
/// Empty when E5/Qdrant unavailable.
pub fn search_skills_lazy(query: &str, k: u32) -> Vec<CatalogHit> {
    let vector = match crate::qdrant::embed_e5(query, true) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    if vector.iter().all(|&x| x == 0.0) {
        return Vec::new();
    }
    match crate::qdrant::search_with_vector(SKILLS_LAZY_COLLECTION, vector, k, None) {
        Ok(hits) => hits
            .into_iter()
            .map(|h| CatalogHit {
                entity: h
                    .payload
                    .get("entity")
                    .and_then(|v| v.as_str())
                    .unwrap_or("skill")
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

/// Idempotent warm of `ultron_skills_lazy`: if a probe query returns nothing the
/// collection is (re)built with `index_skills_lazy`; otherwise it's a no-op. Cheap
/// to call on every daemon start (one probe search, then skip). This keeps the v3
/// semantic fallback working after a Qdrant wipe or a skill add/remove without a
/// manual `reindex-skills-lazy`. `(0, 0)` means "already populated — skipped".
pub fn maybe_index_skills_lazy() -> Result<(usize, usize), String> {
    // Generic probe — matches across skill descriptions regardless of which are
    // installed, so a populated collection always returns ≥1 hit.
    let already = search_skills_lazy("orchestrator master router skill", 1);
    if !already.is_empty() {
        return Ok((0, 0)); // already populated
    }
    index_skills_lazy()
}

/// Warm `ultron_catalog` once per process start: index agents + skills if the
/// collection looks empty/stale. Idempotent (deterministic upsert). Designed to
/// run inside `spawn_blocking` from the Tauri `setup()` so it never blocks
/// startup, and a missing E5 model degrades to "router uses whatever is already
/// indexed" instead of a hard failure.
///
/// Returns `(entities_indexed, errors)`. `(0, 0)` means "already warm — skipped".
pub fn maybe_warm_catalog() -> Result<(usize, usize), String> {
    // Cheap probe: if a known skill already resolves, assume the collection is
    // warm and skip the full re-embed. Avoids paying ~93 embeddings on every
    // launch. The query is intentionally generic so it matches across skill
    // descriptions regardless of which skills are installed.
    let already = search_catalog("orchestrator master router skill", Some("skill"), 1);
    if !already.is_empty() {
        return Ok((0, 0)); // already warm
    }

    // Agents first (so a skill-only failure still leaves agents routable), then
    // skills. An agent index failure is non-fatal here — we still try skills.
    let (a_ok, _a_err) = index_agents().unwrap_or((0, 0));
    let (s_ok, s_err) = index_skills()?;
    Ok((a_ok + s_ok, s_err))
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
                "Activa a ALFRED — el mayordomo digital del usuario."
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

    #[test]
    fn lazy_collection_is_distinct_from_catalog() {
        // Ensures the two collections never point to the same Qdrant namespace.
        // A naming collision would let index_skills_lazy overwrite active-routing
        // points in ultron_catalog with disabled-skill vectors.
        assert_ne!(
            SKILLS_LAZY_COLLECTION, CATALOG_COLLECTION,
            "lazy collection must be separate from the orchestrator catalog"
        );
    }

    #[test]
    fn maybe_warm_catalog_is_public_and_returns_tuple() {
        // Smoke: the symbol exists and has the expected shape. We do NOT call it
        // here (it needs E5/Qdrant); the e2e tests exercise the real path.
        let _f: fn() -> Result<(usize, usize), String> = maybe_warm_catalog;
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
