// ULTRON Control Center -- Contradiction detector (MEMORY KERNEL . Fase D)
//
// Closes the Fase D TODO: given a PROPOSED candidate summary, find ACTIVE
// items that are semantically close (same scope/project) and decide whether
// any of them CONTRADICTS the proposal. The output is advisory only -- it
// feeds `MemoryCandidate::contradiction_candidates` + a recommended action of
// `Quarantine`. It NEVER writes items and NEVER auto-approves.
//
// FAIL-SAFE by construction (1.7: now fail-CLOSED on infra):
//   - The semantic step (dense search + the LLM judge) is isolated in `check`.
//     When Qdrant/E5 is off, `check` returns `None` (NOT verifiable) so the
//     write-path marks the candidate `unjudged` and never auto-approves it; the
//     pipeline is never BLOCKED (the hook still completes).
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
use super::model::CandidateAction;
use super::sqlite_store as store;

/// How many dense neighbours to inspect per proposal. Kept small: the LLM
/// judge is the expensive step, and a contradiction with the proposal will be
/// among the very nearest items if it exists at all.
const NEIGHBOUR_LIMIT: u32 = 5;

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
///   - Qdrant/E5 unavailable              -> `None` (NOT verifiable → the caller
///     marks the candidate `unjudged` and never auto-approves it).
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
    let neighbour_ids =
        super::qdrant_index::search_dense_checked(proposed, NEIGHBOUR_LIMIT, project_id)?;

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

    // La búsqueda densa quedó VERIFICADA (Some). Residual declarado (mand. 13): el
    // juez LLM sigue conservador — un None del modelo no marca ese vecino; el
    // fail-closed cubre la infra de BÚSQUEDA, el juez-LLM-caído es residual menor.
    Some(findings)
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
}
