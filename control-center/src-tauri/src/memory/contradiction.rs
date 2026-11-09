// ULTRON Control Center -- Contradiction detector (MEMORY KERNEL . Fase D)
//
// Closes the Fase D TODO: given a PROPOSED candidate summary, find ACTIVE
// items that are semantically close (same scope/project) and decide whether
// any of them CONTRADICTS the proposal. The output is advisory only -- it
// feeds `MemoryCandidate::contradiction_candidates` + a recommended action of
// `Quarantine`. It NEVER writes items and NEVER auto-approves.
//
// FAIL-SAFE by construction (1.7: now fail-CLOSED on infra):
//   - The semantic step (neighbour search + the LLM judge) is isolated in
//     `check`. With the dense stack ON but Qdrant/E5 down, `check` returns
//     `None` (NOT verifiable) so the write-path marks the candidate `unjudged`
//     and never auto-approves it; the pipeline is never BLOCKED (the hook still
//     completes).
//   - With the dense stack deliberately OFF (`ULTRON_DENSE=0`, 2026-09-28) the
//     neighbours come from FTS5 instead (H11, 2026-10-17): before, every
//     candidate stayed `unjudged` forever and auto-approve never fired (677 of
//     677 pending). The lexical neighbours pass a topic floor
//     (`is_lexical_neighbour`) before reaching the judge, in the role of the
//     0.83 cosine floor of the dense path.
//   - The LLM judge (`ai_tasks::judge_contradiction`) is tolerant: on any
//     parse/route failure it reports `false` (no contradiction), so a degraded
//     model can never spuriously quarantine a memory.
//   - No function in this module can panic: every fallible step degrades to an
//     empty / negative result.
//
// `recommended_action` is a PURE decision over the findings, so it is unit
// tested without any network/DB/LLM dependency.

use rusqlite::Connection;

use super::ai_tasks::ContradictionClass;
use super::model::{CandidateAction, MemoryItem, Status};
use super::sqlite_store as store;

/// How many dense neighbours to inspect per proposal. Kept small: the LLM
/// judge is the expensive step, and a contradiction with the proposal will be
/// among the very nearest items if it exists at all.
const NEIGHBOUR_LIMIT: u32 = 5;

/// Candidatos que se piden a FTS5 (orden BM25) con el denso apagado, antes de
/// filtrar por proyecto y por tema. Holgado frente a `NEIGHBOUR_LIMIT` porque el
/// OR de términos de FTS5 trae ruido que el filtro descarta.
const LEXICAL_FANOUT: usize = 20;

/// Suelo de tema del camino léxico: términos de contenido compartidos mínimos.
/// Con uno solo, cualquier palabra común ("memoria", "build") emparejaría temas
/// sin relación y el juez decidiría sobre pares absurdos.
const LEXICAL_MIN_SHARED: usize = 2;

/// Suelo de tema del camino léxico: fracción del vocabulario del texto más corto
/// que aparece en el otro (coeficiente de solapamiento). Por debajo de la mitad
/// no es "el mismo tema" y no hay proposición que contradecir: el mismo papel
/// que el 0.83 de coseno del camino denso.
const LEXICAL_MIN_OVERLAP: f32 = 0.5;

/// A single detected contradiction between a proposal and an ACTIVE item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContradictionFinding {
    /// `id` of the ACTIVE `MemoryItem` that the proposal contradicts.
    pub conflicting_id: String,
    /// Human-readable justification (e.g. the conflicting item's summary).
    pub reason: String,
    /// Clasificación 3-way de la relación (1.3b). `new()` deja `RealConflict`
    /// (conservador → Quarantine); `check` la puebla con el juez.
    pub class: ContradictionClass,
}

impl ContradictionFinding {
    /// Build a finding defaulting to `RealConflict` (conservative → Quarantine).
    #[must_use]
    pub fn new(conflicting_id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new_classified(conflicting_id, reason, ContradictionClass::RealConflict)
    }

    /// Build a finding with an explicit 3-way class (used by `check`).
    #[must_use]
    pub fn new_classified(
        conflicting_id: impl Into<String>,
        reason: impl Into<String>,
        class: ContradictionClass,
    ) -> Self {
        Self {
            conflicting_id: conflicting_id.into(),
            reason: reason.into(),
            class,
        }
    }
}

/// Inspect ACTIVE items semantically near `proposed_summary` (optionally scoped
/// to `project_id`) and return every one the LLM judge marks as a
/// contradiction.
///
/// Degradation contract (1.7 fail-closed):
///   - Empty / whitespace-only proposal   -> `Some(vec![])` (nothing to compare).
///   - Dense ON, Qdrant/E5 unavailable    -> `None` (NOT verifiable → the caller
///     marks the candidate `unjudged` and never auto-approves it).
///   - Dense OFF (`ULTRON_DENSE=0`)        -> neighbours from FTS5 + topic floor;
///     a SQLite error on that search -> `None` (same fail-closed contract).
///   - Query ran but found 0 neighbours    -> `Some(vec![])` (verified clean).
///   - A neighbour id no longer in SQLite  -> skipped (never errors).
///   - The LLM judge unavailable           -> conservative `false` (declared
///     residual: the SEARCH infra is fail-closed; the judge stays advisory).
///
/// This function performs the network/DB/LLM work and is therefore NOT unit
/// tested here; `recommended_action` (the pure decision) is.
#[must_use]
pub fn check(
    conn: &Connection,
    proposed_summary: &str,
    project_id: Option<&str>,
) -> Option<Vec<ContradictionFinding>> {
    let proposed = proposed_summary.trim();
    if proposed.is_empty() {
        return Some(Vec::new()); // nada que comparar = verificado-vacío (no infra-fail)
    }

    // 1.7 fail-closed end-to-end: distinguir "infra de búsqueda caída" (Qdrant/E5
    // off → `None`, el caller marca `unjudged`) de "se consultó y no hay vecinos"
    // (`Some(vec![])`). Antes `search_dense` colapsaba ambos a un vec vacío, que el
    // pipeline trataba como "verificado limpio" → con auto-approve ON y Qdrant
    // caído, una Fact contradictoria se auto-promovía.
    let neighbour_ids = neighbour_ids(conn, proposed, project_id)?;

    let mut findings: Vec<ContradictionFinding> = Vec::new();
    for id in neighbour_ids {
        // Load the existing item. A missing item or a DB hiccup is not fatal:
        // we just skip this neighbour.
        let existing = match store::get_item(conn, &id) {
            Ok(Some(item)) => item,
            Ok(None) | Err(_) => continue,
        };

        // We can only judge against text we actually have. Prefer the compact
        // summary; fall back to content; skip if neither exists.
        let existing_text = match existing
            .summary
            .as_deref()
            .or(existing.content.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(text) => text.to_string(),
            None => continue,
        };

        // Clasificación 3-way fail-safe (1.3b): `None` (indecidible) y
        // `Some(NoConflict)` no marcan nada, así que un modelo degradado nunca
        // cuarentena ni supersede espuriamente. Solo `StateUpdate`/`RealConflict`
        // producen finding; la clase la consume `supersede_disposition`.
        if let Some(class) = super::ai_tasks::classify_contradiction(proposed, &existing_text) {
            if class != ContradictionClass::NoConflict {
                findings.push(ContradictionFinding::new_classified(
                    existing.id,
                    existing_text,
                    class,
                ));
            }
        }
    }

    // La búsqueda de vecinos (densa o FTS5) quedó VERIFICADA (Some). Residual
    // declarado (mand. 13): el juez LLM sigue conservador — un None del modelo no
    // marca ese vecino; el fail-closed cubre la infra de BÚSQUEDA, el
    // juez-LLM-caído es residual menor.
    Some(findings)
}

/// Vecinos ACTIVOS que el juez debe mirar. Denso encendido: k-NN en Qdrant con
/// su floor de coseno (y `None` si la infra está caída, fail-closed). Denso
/// apagado a propósito: FTS5 más el suelo de tema léxico. En ese caso no se toca
/// Qdrant: está apagado y sondearlo solo costaría el timeout del healthz.
fn neighbour_ids(
    conn: &Connection,
    proposed: &str,
    project_id: Option<&str>,
) -> Option<Vec<String>> {
    if crate::qdrant::dense_enabled() {
        return super::qdrant_index::search_dense_checked(proposed, NEIGHBOUR_LIMIT, project_id);
    }
    let hits = store::search_items(conn, proposed, Status::Active, LEXICAL_FANOUT).ok()?;
    Some(select_lexical_neighbours(proposed, project_id, &hits))
}

/// PURA: de los resultados de FTS5 (ya en orden BM25) se queda con los del mismo
/// proyecto o globales (el mismo filtro que el camino denso) que superan el
/// suelo de tema, hasta `NEIGHBOUR_LIMIT`.
fn select_lexical_neighbours(
    proposed: &str,
    project_id: Option<&str>,
    hits: &[MemoryItem],
) -> Vec<String> {
    hits.iter()
        .filter(|item| match (project_id, item.project_id.as_deref()) {
            (Some(pid), Some(other)) => other.is_empty() || other == pid,
            _ => true,
        })
        .filter(|item| is_lexical_neighbour(proposed, &lexical_text(item)))
        .take(NEIGHBOUR_LIMIT as usize)
        .map(|item| item.id.clone())
        .collect()
}

/// Texto de un item para el suelo de tema: título más resumen, o más contenido
/// si no hay resumen.
fn lexical_text(item: &MemoryItem) -> String {
    let body = item
        .summary
        .as_deref()
        .or(item.content.as_deref())
        .unwrap_or("");
    format!("{} {body}", item.title.as_deref().unwrap_or(""))
}

/// PURA: ¿hablan los dos textos del mismo tema? Al menos `LEXICAL_MIN_SHARED`
/// términos de contenido en común y un coeficiente de solapamiento (compartidos
/// entre el vocabulario del texto más corto) de al menos `LEXICAL_MIN_OVERLAP`.
fn is_lexical_neighbour(a: &str, b: &str) -> bool {
    let ta = store::row_mapping::content_terms(a);
    let tb = store::row_mapping::content_terms(b);
    let shared = ta.intersection(&tb).count();
    let shortest = ta.len().min(tb.len());
    if shared < LEXICAL_MIN_SHARED || shortest == 0 {
        return false;
    }
    shared as f32 / shortest as f32 >= LEXICAL_MIN_OVERLAP
}

/// Decide the recommended disposition for a candidate given its contradiction
/// findings. Pure and total:
///   - No findings  -> `None` (the candidate's own pipeline decides).
///   - >=1 finding  -> `Some(CandidateAction::Quarantine)` -- NEVER auto-approve.
///
/// Quarantine (not Reject) keeps the proposal visible for human adjudication
/// while keeping it OUT of recall until resolved.
#[must_use]
pub fn recommended_action(findings: &[ContradictionFinding]) -> Option<CandidateAction> {
    if findings.is_empty() {
        None
    } else {
        Some(CandidateAction::Quarantine)
    }
}

/// Disposición de un candidato con contradicciones bajo la política opt-in
/// `auto_supersede` (1.3b).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disposition {
    /// Sin contradicciones: el pipeline propio del candidato decide.
    None,
    /// Contradice → al inbox para adjudicación humana (comportamiento por defecto).
    Quarantine,
    /// Auto-supersede opt-in: state-update 1:1 claro → deprecar ESTE item viejo.
    Supersede(String),
}

/// Decide qué hacer con un candidato dadas sus contradicciones y el flag opt-in
/// `auto_supersede`. PURA (sin I/O), unit-testeada. CONSERVADORA por diseño:
///   - `auto_supersede` OFF                  -> `Quarantine` (comportamiento actual).
///   - EXACTAMENTE 1 finding `StateUpdate`   -> `Supersede(id)` (relación 1:1 clara).
///   - cualquier `RealConflict`, o >1 finding, o mezcla -> `Quarantine` (ojo humano).
///   - sin findings                          -> `None`.
///
/// El gate "exactamente 1 StateUpdate" evita deprecar de más: si el candidato
/// choca con varios items, o alguno es conflicto real, la relación no es un
/// simple update → va al inbox. `supersede` es reversible, pero preferimos NO
/// deprecar memoria válida ante la mínima ambigüedad (mand. fail-safe).
#[must_use]
pub fn supersede_disposition(
    findings: &[ContradictionFinding],
    auto_supersede: bool,
) -> Disposition {
    if findings.is_empty() {
        return Disposition::None;
    }
    if auto_supersede && findings.len() == 1 && findings[0].class == ContradictionClass::StateUpdate
    {
        return Disposition::Supersede(findings[0].conflicting_id.clone());
    }
    Disposition::Quarantine
}

// ---------------------------------------------------------------------------
// Tests -- PURE only. No Qdrant / network / API keys / E5. The semantic path
// (`check`) is intentionally excluded; `recommended_action` is the decision
// surface and is fully covered, plus the `ContradictionFinding` constructor.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_findings_yields_no_action() {
        assert_eq!(recommended_action(&[]), None);
    }

    #[test]
    fn any_finding_recommends_quarantine_never_approve() {
        let findings = vec![ContradictionFinding::new(
            "mem-1",
            "usar postgres, no sqlite",
        )];
        let action = recommended_action(&findings);
        assert_eq!(action, Some(CandidateAction::Quarantine));
        assert_ne!(
            action,
            Some(CandidateAction::Approve),
            "a contradiction must never auto-approve"
        );
    }

    #[test]
    fn multiple_findings_still_quarantine() {
        let findings = vec![
            ContradictionFinding::new("a", "reason a"),
            ContradictionFinding::new("b", "reason b"),
            ContradictionFinding::new("c", "reason c"),
        ];
        assert_eq!(
            recommended_action(&findings),
            Some(CandidateAction::Quarantine)
        );
    }

    #[test]
    fn finding_constructor_preserves_fields() {
        let f = ContradictionFinding::new("mem-42", "conflicting summary");
        assert_eq!(f.conflicting_id, "mem-42");
        assert_eq!(f.reason, "conflicting summary");
    }

    #[test]
    fn findings_compare_by_value() {
        let a = ContradictionFinding::new("id", "why");
        let b = ContradictionFinding::new("id", "why");
        assert_eq!(a, b, "findings with identical fields must be equal");
    }

    // --- supersede_disposition (1.3b) — PURA, sin LLM/DB/red ---

    #[test]
    fn supersede_off_quarantines_even_state_update() {
        // Default OFF: aunque sea state-update, sin el flag va al inbox (caso negativo).
        let f = vec![ContradictionFinding::new_classified(
            "m1",
            "r",
            ContradictionClass::StateUpdate,
        )];
        assert_eq!(supersede_disposition(&f, false), Disposition::Quarantine);
    }

    #[test]
    fn supersede_on_single_state_update_supersedes() {
        let f = vec![ContradictionFinding::new_classified(
            "old-1",
            "r",
            ContradictionClass::StateUpdate,
        )];
        assert_eq!(
            supersede_disposition(&f, true),
            Disposition::Supersede("old-1".to_string())
        );
    }

    #[test]
    fn supersede_on_real_conflict_quarantines() {
        // Caso negativo (mand. 7): un conflicto real NUNCA auto-supersede.
        let f = vec![ContradictionFinding::new_classified(
            "m1",
            "r",
            ContradictionClass::RealConflict,
        )];
        assert_eq!(supersede_disposition(&f, true), Disposition::Quarantine);
    }

    #[test]
    fn supersede_on_multiple_state_updates_quarantines() {
        // Caso negativo: >1 finding = relación ambigua -> inbox, no deprecar de más.
        let f = vec![
            ContradictionFinding::new_classified("a", "r", ContradictionClass::StateUpdate),
            ContradictionFinding::new_classified("b", "r", ContradictionClass::StateUpdate),
        ];
        assert_eq!(supersede_disposition(&f, true), Disposition::Quarantine);
    }

    #[test]
    fn supersede_no_findings_is_none() {
        assert_eq!(supersede_disposition(&[], true), Disposition::None);
    }

    // --- camino léxico con el denso apagado (H11): sin LLM ni red ---

    fn item(id: &str, project: Option<&str>, title: &str, summary: &str) -> MemoryItem {
        use super::super::model::{MemoryType, Scope, Source};
        let mut it = MemoryItem::new(
            MemoryType::Decision,
            Scope::Project,
            Source::UserExplicit,
            Status::Active,
        );
        it.id = id.to_string();
        it.project_id = project.map(str::to_string);
        it.title = Some(title.to_string());
        it.summary = Some(summary.to_string());
        it
    }

    #[test]
    fn lexical_neighbour_accepts_same_topic_with_opposite_claim() {
        // Una contradicción real comparte el tema aunque cambie la conclusión.
        assert!(is_lexical_neighbour(
            "Usar postgres como base de datos del cockpit",
            "Decisión: usar sqlite como base de datos del cockpit",
        ));
    }

    #[test]
    fn lexical_neighbour_rejects_unrelated_topics() {
        // Caso negativo: el par del falso positivo histórico del camino denso.
        assert!(!is_lexical_neighbour(
            "El usuario entrenó en otoño",
            "Mantener Autumn activo en el tema",
        ));
        // Una sola palabra común no basta (suelo de dos términos).
        assert!(!is_lexical_neighbour(
            "La memoria del daemon ocupa 17 MB",
            "Revisar la memoria del TFG antes de entregar",
        ));
    }

    #[test]
    fn lexical_neighbour_ignores_stop_words_and_folds_accents() {
        // Solo palabras vacías en común: no es el mismo tema.
        assert!(!is_lexical_neighbour(
            "de la que por para",
            "de la que por para"
        ));
        // Las tildes no separan el mismo vocabulario.
        assert!(is_lexical_neighbour(
            "decisión sobre la política de caché",
            "decision politica cache revisada",
        ));
    }

    #[test]
    fn select_lexical_neighbours_filters_project_topic_and_limit() {
        let mut hits = vec![
            item(
                "otro-proyecto",
                Some("explored"),
                "Usar postgres",
                "base de datos del cockpit",
            ),
            item("sin-tema", Some("ultron"), "Kanban", "columnas del tablero"),
            item("global", None, "Usar sqlite", "base de datos del cockpit"),
            item(
                "mismo",
                Some("ultron"),
                "Usar sqlite",
                "base de datos del cockpit",
            ),
        ];
        for i in 0..10 {
            hits.push(item(
                &format!("extra-{i}"),
                Some("ultron"),
                "Usar sqlite",
                "base de datos del cockpit",
            ));
        }
        let got = select_lexical_neighbours(
            "Usar postgres como base de datos del cockpit",
            Some("ultron"),
            &hits,
        );
        assert!(!got.contains(&"otro-proyecto".to_string()), "got={got:?}");
        assert!(!got.contains(&"sin-tema".to_string()), "got={got:?}");
        assert_eq!(got[0], "global", "conserva el orden BM25: got={got:?}");
        assert_eq!(got[1], "mismo", "got={got:?}");
        assert_eq!(got.len(), NEIGHBOUR_LIMIT as usize, "got={got:?}");
    }

    #[test]
    fn select_lexical_neighbours_without_project_keeps_every_project() {
        let hits = vec![item(
            "a",
            Some("explored"),
            "Usar sqlite",
            "base de datos del cockpit",
        )];
        let got = select_lexical_neighbours("usar postgres base datos cockpit", None, &hits);
        assert_eq!(got, vec!["a".to_string()]);
    }

    #[test]
    fn lexical_search_over_fts5_finds_the_neighbour_and_skips_noise() {
        // Extremo a extremo sobre una base en memoria: FTS5 real más el suelo de
        // tema. El ruido comparte una palabra ("cockpit") y FTS5 lo devuelve,
        // pero no llega al juez.
        let conn = Connection::open_in_memory().expect("open in-memory");
        store::apply_schema(&conn).expect("schema");
        let vecino = item(
            "vecino",
            Some("ultron"),
            "Usar sqlite",
            "base de datos del cockpit",
        );
        let ruido = item(
            "ruido",
            Some("ultron"),
            "Cockpit",
            "colores del tema oscuro",
        );
        store::insert_item(&conn, &vecino).expect("insert vecino");
        store::insert_item(&conn, &ruido).expect("insert ruido");

        let propuesta = "Usar postgres como base de datos del cockpit";
        let hits =
            store::search_items(&conn, propuesta, Status::Active, LEXICAL_FANOUT).expect("search");
        let ids: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
        assert!(ids.contains(&"ruido"), "FTS5 trae el ruido: ids={ids:?}");
        let got = select_lexical_neighbours(propuesta, Some("ultron"), &hits);
        assert_eq!(got, vec!["vecino".to_string()], "ids={ids:?}");
    }
}
