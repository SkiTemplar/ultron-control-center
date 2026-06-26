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
}

impl ContradictionFinding {
    /// Build a finding from a conflicting item id and a reason string.
    #[must_use]
    pub fn new(conflicting_id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            conflicting_id: conflicting_id.into(),
            reason: reason.into(),
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

        // The LLM judge is fail-safe: None (undecidable) and Some(false) are
        // treated as "no conflict", so a degraded model never spuriously
        // quarantines. Only a confident Some(true) flags a contradiction.
        if super::ai_tasks::judge_contradiction(proposed, &existing_text) == Some(true) {
            findings.push(ContradictionFinding::new(existing.id, existing_text));
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
}
