// ULTRON Control Center — catálogo de agentes del orquestador.
//
// Lectura del catálogo REAL de agentes en ~/.claude/agents/*.md: los nombres
// (para sanear los agentes fantasma de las plantillas de workflow) y la
// descripción del frontmatter (para el floor-inject de especialistas
// preferidos en `orchestrator::ranking`). El kernel no reinventa agentes:
// DELEGA en los que existen en disco.
//
// El índice semántico que vivía aquí (colecciones `ultron_catalog` y
// `ultron_skills_lazy` con embeddings) se retiró el 2026-11-14 junto con la
// ruta densa: la delegación se decide por reglas de intent y especialistas
// preferidos.

use std::path::PathBuf;

use serde::Serialize;

/// Candidato a delegación (agente o skill) que consume el ranking del
/// orquestador.
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
/// floor-inject the intent's preferred specialists. None if the file is
/// absent/malformed.
pub fn agent_description(name: &str) -> Option<String> {
    let dir = agents_dir()?;
    let content = std::fs::read_to_string(dir.join(format!("{name}.md"))).ok()?;
    parse_frontmatter(&content).map(|(_, d)| d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_frontmatter() {
        let md = "---\nname: code-reviewer\ndescription: \"Review code quality and security.\"\ntools: Read, Grep\nmodel: claude-opus-5\n---\n\nbody here";
        let (name, desc) = parse_frontmatter(md).expect("frontmatter");
        assert_eq!(name, "code-reviewer");
        assert_eq!(desc, "Review code quality and security.");
    }

    #[test]
    fn rejects_content_without_frontmatter() {
        assert!(parse_frontmatter("no frontmatter here").is_none());
        assert!(parse_frontmatter("---\nname: x\n---").is_none()); // no description
    }
}
