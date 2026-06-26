// ULTRON Control Center — Automatic session capture (MEMORY KERNEL · OLA write-path)
//
// Closes the "memory never captures our conversations" gap. At Stop, the hook
// pipes the session transcript here; this:
//   1. asks an LLM (via the canonical `ai_router::route`) to extract a few
//      durable facts/decisions — which ALSO populates the AI Router telemetry
//      (`metrics.json`) with real traffic using the user's configured keys;
//   2. turns each fact into a `MemoryCandidate` (so redaction + dedupe run in
//      `MemoryService::create_candidate`), landing it in the governed inbox for
//      human approval. With auto-approve OFF (the default) it is never promoted;
//      with the toggle ON, only a CLEAN fact clearing the BAND-A floor is — see
//      `auto_approve::classify_band` (the secret/contradiction/duplicate gate holds).
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
    /// Optional self-reported salience score parsed from the LLM line (0..1).
    /// `None` when the model omitted it or we fell back to the heuristic.
    llm_score: Option<f32>,
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
        // Derive VARIED importance/confidence from the fact's type + signals BEFORE
        // moving its strings into the candidate (fixes the 55%/50%-for-everything
        // bug: previously importance was hardcoded to 0.55 and confidence left at
        // the 0.5 default, so every candidate looked identical in the UI).
        c.importance = derive_importance(&f, router_used);
        c.confidence = derive_confidence(&f, router_used);
        c.proposed_title = Some(f.title);
        c.proposed_summary = Some(f.body.clone());
        c.proposed_content = Some(f.body);
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
         (decisiones tecnicas, preferencias del usuario, hechos del proyecto, restricciones, \
         o identidad/rol estable del usuario). \
         Ignora lo efimero. Una linea por hecho, formato exacto:\n\
         TIPO | titulo corto | resumen de una frase | importancia\n\
         donde TIPO es uno de: decision, preference, fact, constraint, task, user_profile; \
         usa user_profile SOLO para identidad/rol/forma-de-trabajar ESTABLE del usuario \
         (quien es, a que se dedica, como prefiere trabajar), no para gustos puntuales (eso es preference); \
         e importancia es un numero entre 0 y 1 que refleja cuan importante y duradero \
         es el hecho (las decisiones y restricciones suelen ser altas, los resumenes bajos).\n\
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
        // Accept BOTH the legacy 3-field form and the new 4-field form with a
        // trailing importance score: TIPO | titulo | resumen [| score].
        let parts: Vec<&str> = line.splitn(4, '|').map(str::trim).collect();
        if parts.len() < 3 || parts[1].is_empty() || parts[2].is_empty() {
            continue;
        }
        let kind = MemoryType::parse(&parts[0].to_lowercase()).unwrap_or(MemoryType::Fact);
        let llm_score = parts.get(3).and_then(|s| parse_score(s));
        out.push(Fact {
            kind,
            title: parts[1].chars().take(120).collect(),
            body: parts[2].chars().take(400).collect(),
            llm_score,
        });
    }
    out
}

/// Parse a tolerant 0..1 salience score from a model token (handles "0.8",
/// "0,8", "80%", or a stray "score=0.7"). Returns `None` when nothing numeric is
/// present so the caller falls back to the type/signal heuristic. Pure.
fn parse_score(raw: &str) -> Option<f32> {
    let cleaned: String = raw
        .chars()
        .map(|c| if c == ',' { '.' } else { c })
        .filter(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let v: f32 = cleaned.parse().ok()?;
    // A bare percentage (e.g. "80") collapses to >1; rescale into 0..1.
    let v = if raw.contains('%') || v > 1.0 {
        v / 100.0
    } else {
        v
    };
    if v.is_finite() {
        Some(v.clamp(0.0, 1.0))
    } else {
        None
    }
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
        llm_score: None,
    }]
}

// ---------------------------------------------------------------------------
// Dynamic importance / confidence (point 1)
//
// The old write-path stamped every candidate with importance=0.55 and left
// confidence at the 0.5 default, so the inbox showed an identical 55%/50% for
// EVERYTHING. These two pure functions derive a VARIED score from:
//   - the memory TYPE (decision/constraint high, fact/task medium, summary low),
//   - cheap text SIGNALS (length + specificity of the summary),
//   - PROVENANCE (router extraction is more trustworthy than the local fallback),
//   - and, when present, the LLM's own self-reported salience score (blended in).
// Kept pure (no I/O) so they are unit-tested without a router or DB.
// ---------------------------------------------------------------------------

/// Type-derived base importance. Durable, decision-bearing knowledge ranks high;
/// ephemeral summaries low; the rest sit in a medium band. The spread is what
/// makes candidates visibly DIFFERENT in the UI.
fn type_base_importance(kind: MemoryType) -> f32 {
    match kind {
        MemoryType::Decision | MemoryType::Constraint | MemoryType::Architecture => 0.78,
        MemoryType::Preference | MemoryType::UserProfile => 0.70,
        MemoryType::CodebaseFact | MemoryType::ErrorResolution | MemoryType::Skill => 0.62,
        MemoryType::Fact | MemoryType::Task => 0.55,
        MemoryType::AgentNote => 0.48,
        MemoryType::SessionSummary => 0.40,
    }
}

/// A small, bounded specificity bonus from cheap text signals: longer, concrete
/// summaries (containing numbers, identifiers, code-ish punctuation) tend to be
/// more reusable than one-liners. Range roughly [-0.06, +0.10].
fn specificity_bonus(body: &str) -> f32 {
    let len = body.chars().count();
    // Length: very short blurbs lose a little; meaty ones gain a little.
    let len_adj = if len < 40 {
        -0.06
    } else if len < 120 {
        0.02
    } else {
        0.06
    };
    // Concreteness: digits or code/identifier punctuation signal a specific fact.
    let has_digit = body.chars().any(|c| c.is_ascii_digit());
    let has_codeish = body.contains('/')
        || body.contains('_')
        || body.contains('.')
        || body.contains('(')
        || body.contains('`');
    let concrete_adj = f32::from(has_digit) * 0.02 + f32::from(has_codeish) * 0.02;
    len_adj + concrete_adj
}

/// Final candidate importance in [0.05, 0.95]. Blends the type base + signal
/// bonus with the LLM's self-reported score (when present, weighted 50/50) and
/// nudges router-extracted facts up slightly vs the local heuristic fallback.
fn derive_importance(fact: &Fact, router_used: bool) -> f32 {
    let heuristic = type_base_importance(fact.kind) + specificity_bonus(&fact.body);
    let blended = match fact.llm_score {
        Some(s) => 0.5 * heuristic + 0.5 * s,
        None => heuristic,
    };
    // Router extraction is more trustworthy than the degraded local fallback.
    let provenance_adj = if router_used { 0.02 } else { -0.03 };
    (blended + provenance_adj).clamp(0.05, 0.95)
}

/// Final candidate confidence in [0.05, 0.95]. Confidence reflects how sure we
/// are the fact is TRUE/well-formed (vs importance = how much it MATTERS). It is
/// driven mostly by provenance and the presence of an explicit LLM score, with a
/// gentle penalty for suspiciously short bodies. Deliberately distinct from
/// importance so the two columns don't move in lockstep in the UI.
fn derive_confidence(fact: &Fact, router_used: bool) -> f32 {
    // Router-extracted facts start more trusted than the local-tail heuristic.
    let mut conf = if router_used { 0.66 } else { 0.42 };
    // An explicit self-reported score means the model engaged with salience —
    // pull confidence toward that score a little.
    if let Some(s) = fact.llm_score {
        conf = 0.7 * conf + 0.3 * s;
    }
    // Very short bodies are more likely to be noise/truncation.
    if fact.body.chars().count() < 30 {
        conf -= 0.08;
    }
    // Session summaries are inherently fuzzier than atomic decisions/facts.
    if matches!(fact.kind, MemoryType::SessionSummary) {
        conf -= 0.06;
    }
    conf.clamp(0.05, 0.95)
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

    #[test]
    fn parses_optional_trailing_importance_score() {
        // 4-field form carries an LLM score; 3-field form leaves it None.
        let facts = parse_facts(
            "decision | usar E5 | se eligio E5 sobre bge-m3 | 0.9\n\
             fact | algo | un detalle sin score",
        );
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].llm_score, Some(0.9));
        assert!(facts[1].llm_score.is_none());
    }

    #[test]
    fn parse_score_handles_common_formats() {
        assert_eq!(parse_score("0.8"), Some(0.8));
        assert_eq!(parse_score("0,8"), Some(0.8));
        assert_eq!(parse_score("80%"), Some(0.8));
        assert_eq!(parse_score("score=0.7"), Some(0.7));
        assert_eq!(parse_score("alto"), None);
        // Out-of-range bare percentages collapse into 0..1.
        assert_eq!(parse_score("90"), Some(0.9));
    }

    #[test]
    fn importance_varies_by_type_not_constant() {
        // The core bug: every candidate used to be 0.55. Distinct types must now
        // yield clearly DIFFERENT importance values.
        let decision = Fact {
            kind: MemoryType::Decision,
            title: "t".into(),
            body: "se decidio migrar a sqlite como source of truth canonico".into(),
            llm_score: None,
        };
        let summary = Fact {
            kind: MemoryType::SessionSummary,
            title: "t".into(),
            body: "hablamos de cosas".into(),
            llm_score: None,
        };
        let imp_decision = derive_importance(&decision, true);
        let imp_summary = derive_importance(&summary, true);
        assert!(
            imp_decision > imp_summary + 0.2,
            "a decision must score clearly higher than a session summary \
             (got decision={imp_decision}, summary={imp_summary})"
        );
        assert_ne!(imp_decision, 0.55, "importance is no longer hardcoded");
    }

    #[test]
    fn llm_score_shifts_importance() {
        let base = Fact {
            kind: MemoryType::Fact,
            title: "t".into(),
            body: "un hecho concreto del proyecto con detalle suficiente".into(),
            llm_score: None,
        };
        let scored = Fact {
            llm_score: Some(0.95),
            ..clone_fact(&base)
        };
        assert!(
            derive_importance(&scored, true) > derive_importance(&base, true),
            "a high LLM score must raise importance vs no score"
        );
    }

    #[test]
    fn confidence_distinct_from_importance_and_provenance_aware() {
        let f = Fact {
            kind: MemoryType::Decision,
            title: "t".into(),
            body: "se decidio usar e5 1024d para recall semantico".into(),
            llm_score: None,
        };
        let conf_router = derive_confidence(&f, true);
        let conf_heuristic = derive_confidence(&f, false);
        assert!(
            conf_router > conf_heuristic,
            "router-extracted facts must be more confident than the local fallback"
        );
        // Confidence and importance must not be the identical constant pair the
        // UI complained about.
        let imp = derive_importance(&f, true);
        assert_ne!(conf_router, imp, "confidence and importance must differ");
        assert!((0.05..=0.95).contains(&conf_router));
    }

    #[test]
    fn factory_threshold_can_auto_approve_top_confidence_capture() {
        // INVARIANTE 1.1 (conductual, cross-module): la confianza MÁXIMA que el
        // write-path de captura puede emitir —router + `llm_score = 1.0`, cuerpo
        // no trivial, tipo auto-aprobable— DEBE caer en BAND A bajo la config de
        // FÁBRICA. Si el umbral de fábrica supera el techo de `derive_confidence`,
        // el auto-approve es código MUERTO para captura conversacional (todo fact
        // del Stop-hook se queda en el inbox por más limpio y seguro que sea — el
        // bug que cierra 1.1). El test falla con el viejo umbral 0.85 (0.762 < 0.85
        // → Pending) y pasa con el umbral alcanzable.
        use super::super::auto_approve::{classify_band, AutoBand, DEFAULT_AUTO_APPROVE_THRESHOLD};
        let top = Fact {
            kind: MemoryType::Fact,
            title: "t".into(),
            body: "un hecho concreto y verificable del proyecto con detalle suficiente".into(),
            llm_score: Some(1.0),
        };
        // Techo REAL del path de captura (no un número mágico): se ata el test a la
        // función productora, así que subir el umbral por encima de este techo lo rompe.
        let ceiling = derive_confidence(&top, true);
        assert!(
            ceiling < 0.85,
            "premisa del bug: el techo de captura ({ceiling:.3}) queda bajo el viejo umbral 0.85"
        );
        let mut cand = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
        cand.confidence = ceiling;
        assert_eq!(
            classify_band(&cand, DEFAULT_AUTO_APPROVE_THRESHOLD),
            AutoBand::Approve,
            "la config de fábrica DEBE poder auto-aprobar el fact de máxima confianza del \
             path de captura (conf={ceiling:.3} vs umbral de fábrica {DEFAULT_AUTO_APPROVE_THRESHOLD})"
        );
    }

    #[test]
    fn prompt_offers_user_profile_type() {
        // 1.4: el extractor SOLO puede emitir tipos que el prompt le ofrece. Para que
        // `user_profile` deje de ser una categoría vacía-sin-productor, el prompt debe
        // ofrecerla (el parser ya la mapea). ROJO si el prompt no la lista.
        let p = extraction_prompt("una sesion de prueba con suficiente contenido para no truncar");
        assert!(
            p.contains("user_profile"),
            "el extraction_prompt debe ofrecer user_profile como tipo capturable"
        );
        // Regresión 1.4: los tipos retirados NO deben reaparecer ofrecidos en el prompt.
        assert!(
            !p.contains("tool_usage"),
            "tool_usage retirado: el prompt no debe ofrecerlo"
        );
        assert!(
            !p.contains("workflow_state"),
            "workflow_state retirado: el prompt no debe ofrecerlo"
        );
    }

    #[test]
    fn retired_memory_types_no_longer_parse() {
        // 1.4: `tool_usage` y `workflow_state` se retiran (sin productor). El parser de
        // captura ya no debe reconocerlos como MemoryType. ROJO mientras sigan en el enum.
        assert!(
            MemoryType::parse("tool_usage").is_none(),
            "tool_usage retirado"
        );
        assert!(
            MemoryType::parse("workflow_state").is_none(),
            "workflow_state retirado"
        );
        // Sanidad: los tipos CONSERVADOS siguen parseando (skill/architecture tienen productor).
        assert!(MemoryType::parse("user_profile").is_some());
        assert!(MemoryType::parse("skill").is_some());
        assert!(MemoryType::parse("architecture").is_some());
    }

    // Small helper: Fact is a private test-local struct without Clone.
    fn clone_fact(f: &Fact) -> Fact {
        Fact {
            kind: f.kind,
            title: f.title.clone(),
            body: f.body.clone(),
            llm_score: f.llm_score,
        }
    }
}
