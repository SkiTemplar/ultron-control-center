// ULTRON Control Center — Automatic session capture (MEMORY KERNEL · OLA write-path)
//
// Closes the "memory never captures our conversations" gap. At Stop, the hook
// pipes the session transcript here; this:
//   1. asks an LLM (via the canonical `ai_router::route`) to extract a few
//      durable facts/decisions — which ALSO populates the AI Router telemetry
//      (`metrics.json`) with real traffic using the user's configured keys;
//   2. turns each fact into a `MemoryCandidate` (so redaction + dedupe run in
//      `MemoryService::create_candidate`), landing it in the governed inbox for
//      human approval — never auto-promoted to active.
//
// Fail-safe: if the router has no usable provider, it degrades to a cheap local
// heuristic so the Stop hook never errors and a candidate is still proposed.
// NOTHING here writes `memory_items` directly; the only writer stays MemoryService.

use serde::Serialize;

use super::model::{MemoryCandidate, MemoryType, Scope};
use super::service::MemoryService;

/// Router zone used for extraction. `chat` is the lightest cloud zone
/// (claude-haiku primary, groq fallback); both read their key from the process
/// env at call time, so the sidecar (launched by the Node hook with the system
/// env) reaches them even when `providers.json` shows a stale "missing".
const CAPTURE_ZONE: &str = "chat";

/// Max facts proposed per session (keeps the inbox signal-dense).
const MAX_FACTS: usize = 5;

#[derive(Debug, Clone, Serialize)]
pub struct CaptureReport {
    /// Candidate ids created in the inbox (awaiting human approval).
    pub created: Vec<String>,
    /// Whether the AI Router served the extraction (true) or we fell back to the
    /// local heuristic (false). When true, AI Router metrics were updated.
    pub router_used: bool,
    /// Short provenance string for the hook log.
    pub strategy: String,
    /// Non-fatal note (degradation reason / counts).
    pub note: String,
}

/// One extracted fact before it becomes a candidate.
struct Fact {
    kind: MemoryType,
    title: String,
    body: String,
}

/// Extract durable facts from `transcript` and propose them as candidates.
/// `project` scopes the candidates (falls back to session scope when absent).
#[must_use]
pub fn capture_session(transcript: &str, project: Option<&str>) -> CaptureReport {
    let trimmed = transcript.trim();
    if trimmed.len() < 40 {
        return CaptureReport {
            created: vec![],
            router_used: false,
            strategy: "skip".into(),
            note: "transcript too short".into(),
        };
    }

    let (facts, router_used, strategy) =
        match crate::ai_router::route(CAPTURE_ZONE, &extraction_prompt(trimmed)) {
            Ok(resp) => {
                let parsed = parse_facts(&resp);
                if parsed.is_empty() {
                    (heuristic_facts(trimmed), false, "router_empty->heuristic")
                } else {
                    (parsed, true, "router")
                }
            }
            Err(_) => (heuristic_facts(trimmed), false, "heuristic"),
        };

    let scope = if project.is_some() {
        Scope::Project
    } else {
        Scope::Session
    };
    let mut created = Vec::new();
    for f in facts.into_iter().take(MAX_FACTS) {
        let mut c = MemoryCandidate::new(f.kind, scope);
        c.proposed_title = Some(f.title);
        c.proposed_summary = Some(f.body.clone());
        c.proposed_content = Some(f.body);
        c.importance = 0.55;
        // create_candidate applies redaction + dedupe (content_hash / FTS).
        if let Ok(id) = MemoryService::create_candidate(&c) {
            created.push(id);
        }
    }

    let note = format!("{} candidate(s) proposed", created.len());
    CaptureReport {
        created,
        router_used,
        strategy: strategy.into(),
        note,
    }
}

/// Prompt the extraction LLM. Asks for a compact, parseable line format so we do
/// not depend on the model emitting valid JSON.
fn extraction_prompt(transcript: &str) -> String {
    // Cap the transcript fed to the model (cost + context); the tail holds the
    // most recent, decision-bearing turns.
    let capped: String = if transcript.chars().count() > 6000 {
        transcript
            .chars()
            .skip(transcript.chars().count() - 6000)
            .collect()
    } else {
        transcript.to_string()
    };
    format!(
        "Extrae como mucho {MAX_FACTS} hechos DURADEROS y reutilizables de esta sesion \
         (decisiones tecnicas, preferencias del usuario, hechos del proyecto, restricciones). \
         Ignora lo efimero. Una linea por hecho, formato exacto:\n\
         TIPO | titulo corto | resumen de una frase\n\
         donde TIPO es uno de: decision, preference, fact, constraint, task.\n\
         No incluyas secretos ni tokens. Si no hay nada relevante, responde NADA.\n\n\
         --- SESION ---\n{capped}\n--- FIN ---"
    )
}

/// Parse the `TIPO | titulo | resumen` line format. Skips malformed lines and a
/// bare `NADA`. Pure -> unit-tested.
fn parse_facts(resp: &str) -> Vec<Fact> {
    let mut out = Vec::new();
    for line in resp.lines() {
        let line = line.trim().trim_start_matches(['-', '*', '•', ' ']);
        if line.eq_ignore_ascii_case("nada") || line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(3, '|').map(str::trim).collect();
        if parts.len() != 3 || parts[1].is_empty() || parts[2].is_empty() {
            continue;
        }
        let kind = MemoryType::parse(&parts[0].to_lowercase()).unwrap_or(MemoryType::Fact);
        out.push(Fact {
            kind,
            title: parts[1].chars().take(120).collect(),
            body: parts[2].chars().take(400).collect(),
        });
    }
    out
}

/// Local fallback when the router has no provider: propose ONE session-summary
/// candidate from the transcript tail so capture never silently no-ops.
fn heuristic_facts(transcript: &str) -> Vec<Fact> {
    let tail: String = transcript
        .chars()
        .skip(transcript.chars().count().saturating_sub(300))
        .collect();
    vec![Fact {
        kind: MemoryType::SessionSummary,
        title: "Resumen de sesion (heuristico)".into(),
        body: tail.replace('\n', " ").trim().to_string(),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_well_formed_lines_and_skips_noise() {
        let resp = "decision | usar E5 1024d | se eligio E5 sobre bge-m3 por recall\n\
                    NADA\n\
                    basura sin separadores\n\
                    - preference | sin emojis | el usuario no quiere emojis en la UI";
        let facts = parse_facts(resp);
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].kind, MemoryType::Decision);
        assert_eq!(facts[0].title, "usar E5 1024d");
        assert_eq!(facts[1].kind, MemoryType::Preference);
    }

    #[test]
    fn unknown_type_defaults_to_fact() {
        let facts = parse_facts("xyz | algo | un detalle");
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].kind, MemoryType::Fact);
    }

    #[test]
    fn heuristic_always_yields_one() {
        let f = heuristic_facts(&"x".repeat(500));
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].kind, MemoryType::SessionSummary);
    }
}
