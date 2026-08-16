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
/// `session_id` is the Claude Code session the transcript came from — stamped as
/// `source_session_id` on every candidate (provenance episódica: with the id the
/// `provenance` subcommand resolves the real `<session_id>.jsonl` on disk).
#[must_use]
pub fn capture_session(
    transcript: &str,
    project: Option<&str>,
    session_id: Option<&str>,
) -> CaptureReport {
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

    let mut created = Vec::new();
    let mut discards: Vec<Discard> = Vec::new();
    for f in facts.into_iter().take(MAX_FACTS) {
        let scope = scope_for_fact(f.kind, project.is_some());
        // Lo Global no lleva proyecto: es del usuario, no de un repo.
        let fact_project = if scope == Scope::Global {
            None
        } else {
            project
        };
        // Filtro de trivialidad (decidido 2026-08-11): el eco de estado
        // (git/kanban ya lo registran) y los facts de baja importancia se
        // descartan EN ORIGEN en vez de llenar el inbox. Todo descarte queda
        // en capture-discards.jsonl para auditar falsos negativos.
        let importance = derive_importance(&f, router_used);
        if let Some(reason) = discard_reason(&f, importance) {
            discards.push(Discard {
                title: f.title,
                reason,
                importance,
            });
            continue;
        }
        let c = fact_to_candidate(f, scope, fact_project, router_used, session_id);
        // create_candidate applies redaction + dedupe (content_hash / FTS).
        if let Ok(id) = MemoryService::create_candidate(&c) {
            created.push(id);
        }
    }
    log_discards(&discards);

    let note = if discards.is_empty() {
        format!("{} candidate(s) proposed", created.len())
    } else {
        format!(
            "{} candidate(s) proposed, {} discarded ({})",
            created.len(),
            discards.len(),
            discards
                .iter()
                .map(|d| d.reason.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    CaptureReport {
        created,
        router_used,
        strategy: strategy.into(),
        note,
    }
}

/// Scope POR FACT (decidido 2026-08-12): preferencias y perfil del usuario son
/// SUYOS, no del proyecto — van a Global para que viajen a todos los proyectos
/// (Global nunca se penaliza en recall) y no haya que repetirselas al sistema
/// en cada repo. El resto queda atado a su proyecto (o Session sin proyecto).
/// Antes TODO iba por-proyecto y brain.db acabo con solo 3 items globales
/// activos. Pure -> unit-tested.
fn scope_for_fact(kind: MemoryType, has_project: bool) -> Scope {
    match kind {
        MemoryType::Preference | MemoryType::UserProfile => Scope::Global,
        _ if has_project => Scope::Project,
        _ => Scope::Session,
    }
}

// ---------------------------------------------------------------------------
// Trivialidad (decidido 2026-08-11): umbral + patrones de eco
// ---------------------------------------------------------------------------

/// Floor de importancia bajo el cual un fact no merece inbox. Calibrado sobre
/// `derive_importance`: un session-summary heuristico ronda 0.31-0.43 (muere),
/// una decision del router 0.78+ (vive), y una "decision" a la que el propio
/// LLM dio salience bajisima (~0.1) cae a ~0.44 (muere — el modelo mismo dijo
/// que no importa).
const MIN_IMPORTANCE: f32 = 0.45;

/// Patrones que delatan ECO DE ESTADO: cosas que git/kanban/CI ya registran y
/// que no son conocimiento reutilizable. Regex morfologico y no frases exactas
/// porque el LLM extractor PARAFRASEA (verificado e2e 2026-08-11: "se ha
/// implementado" del transcript salio como "ha sido implementada con exito").
/// Formas impersonales de PROGRESO, no de decision — el auxiliar + participio
/// exige raices de accion ("implementad", "cread"...); "se ha decidido X" NO
/// matchea a proposito.
static ECHO_RULES: once_cell::sync::Lazy<Vec<(&'static str, regex::Regex)>> =
    once_cell::sync::Lazy::new(|| {
        [
            (
                "aux_participio",
                r"(?i)\b(?:se\s+han?|han?\s+sido|fue(?:ron)?)\s+(?:implementad|completad|cread|actualizad|realizad|corregid|a[nñ]adid|desarrollad|construid|lograd)",
            ),
            ("se_logro", r"(?i)\bse\s+logr[oó]\b"),
            (
                "commit_eco",
                r"(?i)\bcommits?\s+(?:exitoso|realizado|pushead)|\bpushead[oa]s?\s+a\b|commit\s+con\s+el\s+identificador",
            ),
            // Gap `.{0,N}` sin excluir el punto a proposito: los numeros de
            // version ("0.9", "2.7.1") viven entre "tests" y "verdes" y un
            // `[^.]` los cortaria (fallo cazado por el propio test). El coste
            // de cruzar una frase en un fact corto es un descarte logueado.
            (
                "tests_verdes",
                r"(?i)\btests?\b.{0,60}\b(?:verdes?|en\s+verde|pasan)\b",
            ),
            ("build_ci_verde", r"(?i)\b(?:build|ci)\b.{0,30}\bverde\b"),
            (
                "sesion_resultado",
                r"(?i)la\s+sesi[oó]n\s+(?:ha\s+)?(?:resultado|terminado)",
            ),
        ]
        .into_iter()
        .map(|(name, pat)| {
            (
                name,
                regex::Regex::new(pat).expect("patron echo invalido (bug de compilacion)"),
            )
        })
        .collect()
    });

struct Discard {
    title: String,
    reason: String,
    importance: f32,
}

/// Reason to drop this fact before the inbox, or `None` if it earns a slot.
/// Pure -> unit-tested.
fn discard_reason(f: &Fact, importance: f32) -> Option<String> {
    let hay = format!("{} {}", f.title, f.body);
    if let Some((name, _)) = ECHO_RULES.iter().find(|(_, re)| re.is_match(&hay)) {
        return Some(format!("echo:{name}"));
    }
    if importance < MIN_IMPORTANCE {
        return Some(format!("low_importance:{importance:.2}"));
    }
    None
}

/// Best-effort audit trail of discarded facts (jsonl append). A logging failure
/// never breaks capture.
fn log_discards(discards: &[Discard]) {
    if discards.is_empty() {
        return;
    }
    let Some(home) = dirs::home_dir() else { return };
    let dir = home.join(".ultron").join(".tmp");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("capture-discards.jsonl"))
    else {
        return;
    };
    use std::io::Write;
    for d in discards {
        let line = serde_json::json!({
            "ts_epoch": epoch,
            "title": d.title,
            "reason": d.reason,
            "importance": d.importance,
        });
        let _ = writeln!(file, "{line}");
    }
}

/// Build the governed candidate for one extracted fact. Pure (no I/O) so the
/// provenance stamping is unit-testable without a DB: importance/confidence are
/// derived (fixes the 55%/50%-for-everything bug) and `source_session_id` carries
/// the episodic origin the `provenance` subcommand later resolves to a transcript.
///
/// Atribucion (fix 2026-08-11, decidido por el usuario): el project se estampa en el
/// candidato — ANTES solo decidia el scope y `proposed_project_id` quedaba None,
/// asi que TODA captura se promovia con scope=project y project_id=null y el
/// recall la colaba en cualquier proyecto. Se estampa doble: campo directo +
/// tag `project:<id>` (la tabla de candidatos no tiene columna project; el tag
/// es lo unico que sobrevive el round-trip SQLite — ver `to_item`).
fn fact_to_candidate(
    f: Fact,
    scope: Scope,
    project: Option<&str>,
    router_used: bool,
    session_id: Option<&str>,
) -> MemoryCandidate {
    let mut c = MemoryCandidate::new(f.kind, scope);
    c.importance = derive_importance(&f, router_used);
    c.confidence = derive_confidence(&f, router_used);
    c.proposed_title = Some(f.title);
    c.proposed_summary = Some(f.body.clone());
    c.proposed_content = Some(f.body);
    let project = project.map(str::trim).filter(|p| !p.is_empty());
    c.proposed_project_id = project.map(String::from);
    if let Some(p) = project {
        c.proposed_tags.push(format!("project:{p}"));
    }
    c.source_session_id = session_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    c
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

// Tests de captura — extraidos a fichero hermano (limite 800 lineas, cat7.3).
#[cfg(test)]
#[path = "capture_tests.rs"]
mod tests;
