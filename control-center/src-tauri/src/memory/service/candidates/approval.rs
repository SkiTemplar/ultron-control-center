// memory/service/candidates/approval.rs — decisión final sobre un candidato:
// aprobar (promoción a `memory_items` ACTIVE) o rechazar.

use rusqlite::Connection;

use super::super::super::model::{
    Actor, CandidateStatus, EventType, MemoryEvent, MemoryItem, Source, Status,
};
use super::super::super::sqlite_store as store;
use super::super::super::MemoryError;
use super::super::{raised_sensitivity, sync_index, MemoryService, SECRET_RISK_MARKER};
use super::{find_near_dup_active, in_immediate_tx};

impl MemoryService {
    /// Approve a candidate → promote to an ACTIVE `memory_items` row.
    /// When `actor == User` the resulting item is marked validated.
    pub fn approve_candidate(id: &str, actor: Actor) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let item = Self::approve_candidate_on(&conn, id, actor)?;
        sync_index(&item); // W4: keep the dense index in sync with the approval
        Ok(item)
    }

    /// Cuerpo de [`Self::approve_candidate`] sobre una conexión dada (testable
    /// contra una base en memoria). No toca el índice denso: eso lo hace el
    /// wrapper tras el commit.
    ///
    /// Orden (2026-09-03): estado pending → gate exacto por `content_hash`
    /// (índice, no depende de FTS) → gate near-dup (FTS + Jaccard) → escritura
    /// en una transacción IMMEDIATE que reclama el candidato con una transición
    /// condicional pending→approved. Dos drains con la misma lista rancia ya no
    /// pueden aprobar dos veces: el segundo recibe `AlreadyDecided`.
    pub(crate) fn approve_candidate_on(
        conn: &Connection,
        id: &str,
        actor: Actor,
    ) -> Result<MemoryItem, MemoryError> {
        use super::super::super::model::now_millis;
        let cand = store::get_candidate(conn, id)?
            .ok_or_else(|| MemoryError::NotFound(format!("candidate {id}")))?;
        if cand.status != CandidateStatus::Pending {
            return Err(MemoryError::AlreadyDecided(format!(
                "{id} ({})",
                cand.status.as_str()
            )));
        }

        // GATE EXACTO (2026-09-03): mismo texto normalizado, mismo scope y
        // proyecto, ya ACTIVE → el candidato se rechaza. Va por índice, así que
        // no depende de FTS5 ni de que el summary exista (el near-dup de abajo
        // se salta candidatos sin summary y falla en abierto ante FTS caído).
        let preview = cand.to_item(Status::Active, Source::AssistantInferred);
        let normalized = super::super::super::texthash::normalize_text(&preview.searchable_text());
        let hash = super::super::super::texthash::content_hash(&normalized);
        if let Ok(Some(existing)) = store::find_active_by_content_hash(
            conn,
            &hash,
            preview.scope,
            preview.project_id.as_deref(),
        ) {
            return Self::reject_as_duplicate_on(conn, id, &existing.id, actor, "exacto");
        }

        // GATE ANTI-DUP (2026-08-10; audit 08-09: 105 filas duplicadas entraron
        // por approve/approve-all — el near-dup de captura puede no haber
        // corrido o haber fallado). Última línea de defensa: re-chequea contra
        // ACTIVE en el MOMENTO del approve. Con near-dup confirmado el candidato
        // se RECHAZA conservando el ACTIVE existente y el caller recibe
        // `Duplicate(id_existente)` (mismo contrato que el dedupe exacto del
        // write-path). Err de FTS5 = fail-open: infra caída no bloquea approve.
        let gate_text = cand.proposed_summary.clone().unwrap_or_default();
        if !gate_text.trim().is_empty() {
            if let Ok(similar) = store::search_items(conn, &gate_text, Status::Active, 3) {
                if let Some(existing_id) = find_near_dup_active(&gate_text, &similar) {
                    return Self::reject_as_duplicate_on(conn, id, &existing_id, actor, "near-dup");
                }
            }
        }

        let mut item = preview;
        // H2: carry the write-path secret marker to the item so the recall
        // Secret-gate (recall_unified) excludes it. Monotonic — never downgrades.
        item.sensitivity =
            raised_sensitivity(item.sensitivity, cand.risk_level == SECRET_RISK_MARKER);
        if matches!(actor, Actor::User) {
            item.validated_by_user = true;
            item.validated_at = Some(now_millis());
        }
        in_immediate_tx(conn, || {
            let claimed = store::set_candidate_status_if(
                conn,
                id,
                CandidateStatus::Pending,
                CandidateStatus::Approved,
            )?;
            if !claimed {
                return Err(MemoryError::AlreadyDecided(format!(
                    "{id} (claimed by another writer)"
                )));
            }
            store::insert_item(conn, &item)?;
            let ev = MemoryEvent::new(EventType::Approved, Some(item.id.clone()), actor)
                .with_reason(format!("candidate {id} approved"))
                .with_after(serde_json::to_string(&item).unwrap_or_default());
            let _ = store::insert_event(conn, &ev);
            Ok(())
        })?;
        Ok(item)
    }

    /// Rechazo por duplicado desde el gate del approve: el candidato pasa a
    /// Rejected (solo si sigue pending), queda el evento con el ACTIVE que lo
    /// cubre y el caller recibe `Duplicate(id_existente)` (mismo contrato que el
    /// dedupe exacto del write-path).
    fn reject_as_duplicate_on(
        conn: &Connection,
        id: &str,
        existing_id: &str,
        actor: Actor,
        gate: &str,
    ) -> Result<MemoryItem, MemoryError> {
        let _ = store::set_candidate_status_if(
            conn,
            id,
            CandidateStatus::Pending,
            CandidateStatus::Rejected,
        )?;
        let mut ev = MemoryEvent::new(EventType::Rejected, Some(existing_id.to_string()), actor)
            .with_reason(format!(
                "candidate {id} rejected: {gate} de {existing_id} (anti-dup gate en approve)"
            ));
        ev.after_json = Some(format!("{{\"candidate_id\":\"{id}\"}}"));
        let _ = store::insert_event(conn, &ev);
        Err(MemoryError::Duplicate(existing_id.to_string()))
    }

    /// Reject a candidate — it never becomes a memory.
    pub fn reject_candidate(
        id: &str,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<(), MemoryError> {
        let conn = store::open_conn()?;
        Self::reject_candidate_on(&conn, id, actor, reason)
    }

    /// Cuerpo de [`Self::reject_candidate`] sobre una conexión dada. Solo un
    /// candidato PENDING se rechaza; uno ya decidido devuelve `AlreadyDecided`.
    pub(crate) fn reject_candidate_on(
        conn: &Connection,
        id: &str,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<(), MemoryError> {
        let claimed = store::set_candidate_status_if(
            conn,
            id,
            CandidateStatus::Pending,
            CandidateStatus::Rejected,
        )?;
        if !claimed {
            return Err(match store::get_candidate(conn, id)? {
                None => MemoryError::NotFound(id.to_string()),
                Some(c) => MemoryError::AlreadyDecided(format!("{id} ({})", c.status.as_str())),
            });
        }
        let mut ev = MemoryEvent::new(EventType::Rejected, None, actor)
            .with_reason(reason.unwrap_or_else(|| format!("candidate {id} rejected")));
        ev.after_json = Some(format!("{{\"candidate_id\":\"{id}\"}}"));
        let _ = store::insert_event(conn, &ev);
        Ok(())
    }
}
