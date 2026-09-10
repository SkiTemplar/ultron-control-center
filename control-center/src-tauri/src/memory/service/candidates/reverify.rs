// memory/service/candidates/reverify.rs — re-verificación headless de lo que el
// hot path de captura no pudo comprobar (`inbox drain --auto`).

use rusqlite::Connection;

use super::super::super::model::{
    Actor, CandidateAction, CandidateStatus, EventType, MemoryCandidate, MemoryEvent, Source,
    Status,
};
use super::super::super::sqlite_store as store;
use super::super::super::MemoryError;
use super::super::{MemoryService, SECRET_RISK_MARKER};
use super::{in_immediate_tx, jaccard_overlap, NEAR_DUP_JACCARD};

/// Quita un marcador de verificación-incompleta de `tags`.
fn drop_tag(tags: &mut Vec<String>, marker: &str) {
    tags.retain(|t| !t.eq_ignore_ascii_case(marker));
}

/// ¿Lleva el candidato este marcador?
fn has_tag(cand: &MemoryCandidate, marker: &str) -> bool {
    cand.proposed_tags
        .iter()
        .any(|t| t.eq_ignore_ascii_case(marker))
}

impl MemoryService {
    /// (2026-07-13, `inbox drain --auto`) Re-corre las verificaciones que
    /// quedaron incompletas en el hot path de captura (`unjudged` /
    /// `dedup-unverified`). Causa estructural: la captura corre en un one-shot
    /// del CLI con E5 frío (1.4-3.3 s) y el juez agota su budget de 4.5 s, así
    /// que el inbox se re-acumulaba aunque el auto-approve estuviera ON. El
    /// drain es headless: aquí NO hay presupuesto interactivo — juez y dedup
    /// corren síncronos y el coste E5 se paga UNA vez por lote de drain.
    ///
    /// Espeja la semántica de captura: dedup near-dup (Jaccard >= NEAR_DUP) →
    /// Merge; juez con hallazgos → supersede_disposition (state-update 1:1
    /// claro auto-supersede si el flag está ON) o Quarantine; sin hallazgos →
    /// tag fuera. Fail-closed: si la infra sigue caída, el tag se queda y el
    /// candidato sigue pending. Persiste los cambios (INSERT OR REPLACE) y
    /// devuelve el candidato actualizado; si auto-supersedió, vuelve con
    /// status Approved.
    pub fn reverify_candidate(candidate: &MemoryCandidate) -> Result<MemoryCandidate, MemoryError> {
        let conn = store::open_conn()?;
        let mut cand = candidate.clone();
        let mut changed = rerun_dedup(&conn, &mut cand);
        let (judged, supersede_target) = rerun_judge(&conn, &mut cand);
        changed |= judged;

        if changed && !Self::persist_reverified_if_pending(&conn, &cand)? {
            // Otro drain lo decidió mientras se re-verificaba: no se resucita.
            return store::get_candidate(&conn, &cand.id)?
                .ok_or_else(|| MemoryError::NotFound(format!("candidate {}", cand.id)));
        }

        // Auto-supersede (mismo orden fail-safe que captura: supersede PRIMERO,
        // solo si tiene éxito el candidato pasa a Approved).
        if let Some(old_id) = supersede_target {
            let new_item = cand.to_item(Status::Active, Source::AssistantInferred);
            drop(conn); // supersede abre su propia conexión.
            match Self::supersede(&old_id, new_item, Actor::System) {
                Ok(_) => {
                    if let Ok(c2) = store::open_conn() {
                        // Condicional: si otro drain lo decidió mientras se
                        // supersedía, no se pisa su decisión.
                        if let Ok(true) = store::set_candidate_status_if(
                            &c2,
                            &cand.id,
                            CandidateStatus::Pending,
                            CandidateStatus::Approved,
                        ) {
                            cand.status = CandidateStatus::Approved;
                        }
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[service::reverify_candidate] auto-supersede de {old_id} falló ({e}); \
                         candidato {} queda Pending",
                        cand.id
                    );
                }
            }
        }

        Ok(cand)
    }

    /// Persiste el resultado de una re-verificación SOLO si el candidato sigue
    /// pending en la base (no en el clon que trae el caller). Devuelve `false`
    /// sin escribir cuando otro proceso ya lo decidió. Fix 2026-09-03: el
    /// INSERT OR REPLACE con el clon rancio de un drain solapado devolvía a
    /// pending candidatos ya aprobados, y el siguiente drain los re-aprobaba.
    pub(crate) fn persist_reverified_if_pending(
        conn: &Connection,
        cand: &MemoryCandidate,
    ) -> Result<bool, MemoryError> {
        in_immediate_tx(conn, || {
            let still_pending = store::get_candidate(conn, &cand.id)?
                .is_some_and(|fresh| fresh.status == CandidateStatus::Pending);
            if !still_pending {
                return Ok(false);
            }
            let mut to_write = cand.clone();
            to_write.status = CandidateStatus::Pending;
            store::insert_candidate(conn, &to_write)?; // INSERT OR REPLACE = update
            let ev = MemoryEvent::new(EventType::Edited, None, Actor::System)
                .with_reason(format!("candidate {} reverified (drain --auto)", cand.id))
                .with_after(serde_json::to_string(&to_write).unwrap_or_default());
            let _ = store::insert_event(conn, &ev);
            Ok(true)
        })
    }
}

/// Re-corre el dedup near-dup del tag `dedup-unverified`. Devuelve `true` si
/// tocó el candidato. Err de FTS5/SQLite: el tag se queda (fail-closed, igual
/// que captura).
fn rerun_dedup(conn: &Connection, cand: &mut MemoryCandidate) -> bool {
    if !has_tag(cand, "dedup-unverified") {
        return false;
    }
    let summary = cand.proposed_summary.clone().unwrap_or_default();
    if summary.trim().is_empty() {
        // Sin texto no hay nada que dedupear: verificado-vacío legítimo.
        drop_tag(&mut cand.proposed_tags, "dedup-unverified");
        return true;
    }
    let Ok(similar) = store::search_items(conn, &summary, Status::Active, 3) else {
        return false;
    };
    let dups: Vec<String> = similar
        .into_iter()
        .filter(|i| {
            let hay = format!(
                "{} {}",
                i.title.as_deref().unwrap_or(""),
                i.summary.as_deref().unwrap_or("")
            );
            jaccard_overlap(&summary, &hay) >= NEAR_DUP_JACCARD
        })
        .map(|i| i.id)
        .collect();
    if !dups.is_empty() {
        cand.duplicate_candidates = dups;
        cand.recommended_action = CandidateAction::Merge;
    }
    drop_tag(&mut cand.proposed_tags, "dedup-unverified");
    true
}

/// Re-corre el juez de contradicción del tag `unjudged`. Devuelve
/// `(tocó el candidato, id a supersede)`. Infra caída: el tag se queda.
fn rerun_judge(conn: &Connection, cand: &mut MemoryCandidate) -> (bool, Option<String>) {
    if !has_tag(cand, "unjudged") {
        return (false, None);
    }
    let check_text = cand
        .proposed_summary
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            cand.proposed_content
                .as_deref()
                .filter(|s| !s.trim().is_empty())
        })
        .map(str::to_string);
    let Some(text) = check_text else {
        // Sin proposición no hay contradicción posible (limpio legítimo).
        drop_tag(&mut cand.proposed_tags, "unjudged");
        return (true, None);
    };
    let project = cand.proposed_project_id.clone().or_else(|| {
        cand.proposed_tags
            .iter()
            .find_map(|t| t.strip_prefix("project:").map(str::to_string))
    });
    let Some(findings) = super::super::super::contradiction::check(conn, &text, project.as_deref())
    else {
        return (false, None); // infra caída: tag se queda (fail-closed)
    };
    let mut supersede_target = None;
    if !findings.is_empty() {
        for f in &findings {
            if !cand.contradiction_candidates.contains(&f.conflicting_id) {
                cand.contradiction_candidates.push(f.conflicting_id.clone());
            }
        }
        match super::super::super::contradiction::supersede_disposition(
            &findings,
            super::super::super::auto_approve::auto_supersede_enabled(),
        ) {
            super::super::super::contradiction::Disposition::Supersede(old_id) => {
                supersede_target = Some(old_id);
            }
            _ => {
                // Secret tiene precedencia; no degradar su quarantine.
                if !cand.risk_level.eq_ignore_ascii_case(SECRET_RISK_MARKER) {
                    cand.recommended_action = CandidateAction::Quarantine;
                }
            }
        }
    }
    drop_tag(&mut cand.proposed_tags, "unjudged");
    (true, supersede_target)
}
