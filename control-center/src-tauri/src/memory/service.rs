// ULTRON Control Center — MemoryService: the single persistent writer (Fase A)
//
// GOVERNANCE INVARIANT: every persistent memory mutation goes through this
// service, and every mutation appends a `MemoryEvent`. Hooks and agents NEVER
// write `memory_items` directly — they propose `MemoryCandidate`s and the human
// (or an auto-approval policy) promotes them here.
//
// The service is stateless: each method opens `brain.db` (WAL) for its unit of
// work. Tauri commands / the CLL / the candidate-extraction hook all call here.

use serde::Serialize;

use super::model::{
    estimate_tokens, now_millis, Actor, CandidateAction, CandidateStatus, EventType,
    MemoryCandidate, MemoryEvent, MemoryItem, MemoryType, Scope, Source, Status,
};
use super::redaction;
use super::sqlite_store as store;
use super::MemoryError;

/// Stateless facade over the canonical memory store.
pub struct MemoryService;

/// Aggregate counts for dashboards / `memory stats`.
#[derive(Debug, Clone, Serialize)]
pub struct MemoryStats {
    pub active: i64,
    pub pending: i64,
    pub rejected: i64,
    pub deprecated: i64,
    pub stale: i64,
    pub candidates_pending: i64,
}

impl MemoryService {
    // -- candidate intake (what hooks/agents call) ---------------------------

    /// Record a proposed memory (status pending). Returns the candidate id.
    /// This is the ONLY way non-service code introduces memory.
    pub fn create_candidate(candidate: &MemoryCandidate) -> Result<String, MemoryError> {
        let conn = store::open_conn()?;
        let mut cand = candidate.clone();

        // Write-path secret guard (OLA A): redact any credential material from the
        // proposed text BEFORE it is persisted to brain.db or later embedded into
        // Qdrant. Defensive — only detected secrets are redacted; normal text is
        // left untouched. See memory/redaction.rs and CONTRACTS-2026-06-04.md.
        let mut redacted = false;
        redacted |= redaction::redact_in_place(&mut cand.proposed_title);
        redacted |= redaction::redact_in_place(&mut cand.proposed_summary);
        redacted |= redaction::redact_in_place(&mut cand.proposed_content);
        redacted |= redaction::redact_in_place(&mut cand.proposed_content_json);

        // Basic FTS dedupe: flag near-identical ACTIVE items as duplicates so the
        // inbox can merge instead of creating a redundant memory. (Semantic dedupe
        // + contradiction detection via embeddings/AI routing is Fase D — TODO below.)
        if let Some(summary) = cand.proposed_summary.clone() {
            if !summary.trim().is_empty() {
                if let Ok(similar) = store::search_items(&conn, &summary, Status::Active, 3) {
                    let dups: Vec<String> = similar.into_iter().map(|i| i.id).collect();
                    if !dups.is_empty() {
                        cand.duplicate_candidates = dups;
                        cand.recommended_action = CandidateAction::Merge;
                    }
                }
            }
        }
        // TODO(Fase D — contradiction_detector): embed proposed_summary, compare
        // against active items of the same scope/type via qdrant_index::search_dense;
        // on semantic conflict set `contradiction_candidates` +
        // recommended_action=Quarantine and NEVER auto-approve (route to inbox diff).

        store::insert_candidate(&conn, &cand)?;
        let reason = if redacted {
            format!("candidate {} proposed (secrets redacted)", cand.id)
        } else {
            format!("candidate {} proposed", cand.id)
        };
        let ev = MemoryEvent::new(EventType::Created, None, Actor::System)
            .with_reason(reason)
            .with_after(serde_json::to_string(&cand).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(cand.id.clone())
    }

    /// Edit a pending candidate's proposed fields before approval. `None` leaves
    /// a field unchanged.
    pub fn edit_candidate(
        id: &str,
        summary: Option<String>,
        content: Option<String>,
        importance: Option<f32>,
        confidence: Option<f32>,
    ) -> Result<MemoryCandidate, MemoryError> {
        let conn = store::open_conn()?;
        let mut c = store::get_candidate(&conn, id)?
            .ok_or_else(|| MemoryError::NotFound(format!("candidate {id}")))?;
        if summary.is_some() {
            c.proposed_summary = summary;
        }
        if content.is_some() {
            c.proposed_content = content;
        }
        if let Some(i) = importance {
            c.importance = i.clamp(0.0, 1.0);
        }
        if let Some(cf) = confidence {
            c.confidence = cf.clamp(0.0, 1.0);
        }
        store::insert_candidate(&conn, &c)?; // INSERT OR REPLACE
        let ev = MemoryEvent::new(EventType::Edited, None, Actor::User)
            .with_reason(format!("candidate {id} edited"))
            .with_after(serde_json::to_string(&c).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(c)
    }

    /// List candidates awaiting a human (or policy) decision.
    pub fn list_pending_candidates(limit: usize) -> Result<Vec<MemoryCandidate>, MemoryError> {
        let conn = store::open_conn()?;
        store::list_candidates(&conn, CandidateStatus::Pending, limit)
    }

    /// Approve a candidate → promote to an ACTIVE `memory_items` row.
    /// When `actor == User` the resulting item is marked validated.
    pub fn approve_candidate(id: &str, actor: Actor) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let cand = store::get_candidate(&conn, id)?
            .ok_or_else(|| MemoryError::NotFound(format!("candidate {id}")))?;

        let mut item = cand.to_item(Status::Active, Source::AssistantInferred);
        if matches!(actor, Actor::User) {
            item.validated_by_user = true;
            item.validated_at = Some(now_millis());
        }
        store::insert_item(&conn, &item)?;
        store::set_candidate_status(&conn, id, CandidateStatus::Approved)?;

        let ev = MemoryEvent::new(EventType::Approved, Some(item.id.clone()), actor)
            .with_reason(format!("candidate {id} approved"))
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(item)
    }

    /// Reject a candidate — it never becomes a memory.
    pub fn reject_candidate(
        id: &str,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<(), MemoryError> {
        let conn = store::open_conn()?;
        store::set_candidate_status(&conn, id, CandidateStatus::Rejected)?;
        let mut ev = MemoryEvent::new(EventType::Rejected, None, actor)
            .with_reason(reason.unwrap_or_else(|| format!("candidate {id} rejected")));
        ev.after_json = Some(format!("{{\"candidate_id\":\"{id}\"}}"));
        let _ = store::insert_event(&conn, &ev);
        Ok(())
    }

    // -- direct writes (migration / ETL only) --------------------------------

    /// Insert an already-formed item (used by one-shot ETL imports). Caller sets
    /// `source = Imported*` and the status (active for clear data, pending for
    /// doubtful). Emits an `imported` event.
    pub fn add_imported(item: &MemoryItem) -> Result<(), MemoryError> {
        let conn = store::open_conn()?;
        // Write-path secret guard (OLA A): redact credentials from imported text
        // (external/ETL sources are lower-trust) before persisting/indexing.
        let mut item = item.clone();
        redaction::redact_in_place(&mut item.title);
        redaction::redact_in_place(&mut item.summary);
        redaction::redact_in_place(&mut item.content);
        redaction::redact_in_place(&mut item.content_json);
        store::insert_item(&conn, &item)?;
        let ev = MemoryEvent::new(EventType::Imported, Some(item.id.clone()), Actor::Migration)
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(())
    }

    // -- reads ---------------------------------------------------------------

    pub fn get(id: &str) -> Result<Option<MemoryItem>, MemoryError> {
        let conn = store::open_conn()?;
        store::get_item(&conn, id)
    }

    /// Recall-eligible search: ACTIVE items only (governance invariant).
    pub fn search_active(query: &str, limit: usize) -> Result<Vec<MemoryItem>, MemoryError> {
        let conn = store::open_conn()?;
        store::search_items(&conn, query, Status::Active, limit)
    }

    pub fn list_by_status(status: Status, limit: usize) -> Result<Vec<MemoryItem>, MemoryError> {
        let conn = store::open_conn()?;
        store::list_items(&conn, status, limit)
    }

    pub fn history(id: &str, limit: usize) -> Result<Vec<MemoryEvent>, MemoryError> {
        let conn = store::open_conn()?;
        store::list_events_for(&conn, id, limit)
    }

    // -- mutations -----------------------------------------------------------

    /// Edit the editable fields of an item. `None` leaves a field unchanged.
    pub fn edit(
        id: &str,
        title: Option<String>,
        summary: Option<String>,
        content: Option<String>,
        importance: Option<f32>,
        confidence: Option<f32>,
        actor: Actor,
    ) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let mut item =
            store::get_item(&conn, id)?.ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        let before = serde_json::to_string(&item).unwrap_or_default();

        if title.is_some() {
            item.title = title;
        }
        if summary.is_some() {
            item.summary = summary;
        }
        if content.is_some() {
            item.content = content;
        }
        if let Some(i) = importance {
            item.importance = i.clamp(0.0, 1.0);
        }
        if let Some(c) = confidence {
            item.confidence = c.clamp(0.0, 1.0);
        }
        item.updated_at = now_millis();
        item.token_estimate = estimate_tokens(&item.searchable_text());
        store::insert_item(&conn, &item)?;

        let ev = MemoryEvent::new(EventType::Edited, Some(item.id.clone()), actor)
            .with_before(before)
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(item)
    }

    /// Transition an item to a new lifecycle status (deprecate / archive / stale…).
    pub fn set_status(
        id: &str,
        status: Status,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let mut item =
            store::get_item(&conn, id)?.ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        let before = serde_json::to_string(&item).unwrap_or_default();
        let event_type = match status {
            Status::Deprecated => EventType::Deprecated,
            Status::Rejected => EventType::Rejected,
            Status::Active => EventType::Restored,
            _ => EventType::Updated,
        };
        item.status = status;
        item.updated_at = now_millis();
        store::insert_item(&conn, &item)?;

        let mut ev = MemoryEvent::new(event_type, Some(item.id.clone()), actor)
            .with_before(before)
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        if let Some(r) = reason {
            ev = ev.with_reason(r);
        }
        let _ = store::insert_event(&conn, &ev);
        Ok(item)
    }

    /// Convenience: deprecate an item (no longer recall-eligible).
    pub fn deprecate(
        id: &str,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<MemoryItem, MemoryError> {
        Self::set_status(id, Status::Deprecated, actor, reason)
    }

    /// Pin / unpin an item (req #17). Pinned items are always surfaced.
    pub fn pin(id: &str, actor: Actor) -> Result<MemoryItem, MemoryError> {
        Self::set_pinned(id, true, actor)
    }
    pub fn unpin(id: &str, actor: Actor) -> Result<MemoryItem, MemoryError> {
        Self::set_pinned(id, false, actor)
    }
    fn set_pinned(id: &str, pinned: bool, actor: Actor) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let mut item =
            store::get_item(&conn, id)?.ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        let before = serde_json::to_string(&item).unwrap_or_default();
        item.pinned = pinned;
        item.updated_at = now_millis();
        store::insert_item(&conn, &item)?;
        let ev = MemoryEvent::new(EventType::Edited, Some(item.id.clone()), actor)
            .with_before(before)
            .with_reason(if pinned { "pinned" } else { "unpinned" })
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(item)
    }

    /// Active items pinned by the user (Session Resume / always-include).
    pub fn list_pinned(limit: usize) -> Result<Vec<MemoryItem>, MemoryError> {
        let conn = store::open_conn()?;
        store::list_pinned(&conn, limit)
    }

    /// Active items of a given type (e.g. decisions, open tasks).
    pub fn list_active_of_type(
        kind: MemoryType,
        limit: usize,
    ) -> Result<Vec<MemoryItem>, MemoryError> {
        let conn = store::open_conn()?;
        store::list_by_type_status(&conn, kind, Status::Active, limit)
    }

    /// Change an item's scope and/or type (inbox "change scope / change type").
    pub fn relabel(
        id: &str,
        scope: Option<Scope>,
        kind: Option<MemoryType>,
        actor: Actor,
    ) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let mut item =
            store::get_item(&conn, id)?.ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        let before = serde_json::to_string(&item).unwrap_or_default();
        if let Some(s) = scope {
            item.scope = s;
        }
        if let Some(k) = kind {
            item.kind = k;
        }
        item.updated_at = now_millis();
        store::insert_item(&conn, &item)?;
        let ev = MemoryEvent::new(EventType::Edited, Some(item.id.clone()), actor)
            .with_before(before)
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(item)
    }

    /// Replace `old_id` with a new active item, marking the old one deprecated
    /// and linking supersedes/superseded_by both ways.
    pub fn supersede(
        old_id: &str,
        mut new_item: MemoryItem,
        actor: Actor,
    ) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let mut old = store::get_item(&conn, old_id)?
            .ok_or_else(|| MemoryError::NotFound(old_id.to_string()))?;

        new_item.status = Status::Active;
        new_item.supersedes = Some(old_id.to_string());
        new_item.updated_at = now_millis();
        store::insert_item(&conn, &new_item)?;

        old.status = Status::Deprecated;
        old.superseded_by = Some(new_item.id.clone());
        old.updated_at = now_millis();
        store::insert_item(&conn, &old)?;

        let ev = MemoryEvent::new(EventType::Deprecated, Some(old_id.to_string()), actor)
            .with_reason(format!("superseded by {}", new_item.id));
        let _ = store::insert_event(&conn, &ev);
        let ev2 = MemoryEvent::new(EventType::Created, Some(new_item.id.clone()), actor)
            .with_reason(format!("supersedes {old_id}"));
        let _ = store::insert_event(&conn, &ev2);
        Ok(new_item)
    }

    // -- stats ---------------------------------------------------------------

    pub fn stats() -> Result<MemoryStats, MemoryError> {
        let conn = store::open_conn()?;
        Ok(MemoryStats {
            active: store::count_items_by_status(&conn, Status::Active),
            pending: store::count_items_by_status(&conn, Status::Pending),
            rejected: store::count_items_by_status(&conn, Status::Rejected),
            deprecated: store::count_items_by_status(&conn, Status::Deprecated),
            stale: store::count_items_by_status(&conn, Status::Stale),
            candidates_pending: store::count_candidates_pending(&conn),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::model::{MemoryType, Scope};
    use super::*;
    use rusqlite::Connection;

    // These tests drive the low-level store directly through an in-memory conn
    // to assert the *governance* behaviour the service guarantees, without
    // depending on the real ~/.ultron/brain.db path.

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        store::apply_schema(&conn).expect("schema");
        conn
    }

    #[test]
    fn rejected_candidate_never_becomes_active_memory() {
        let conn = mem_conn();
        let c = MemoryCandidate::new(MemoryType::Preference, Scope::User);
        store::insert_candidate(&conn, &c).unwrap();
        store::set_candidate_status(&conn, &c.id, CandidateStatus::Rejected).unwrap();

        // No active item should exist for a rejected candidate.
        let active = store::list_items(&conn, Status::Active, 100).unwrap();
        assert!(
            active.is_empty(),
            "rejecting a candidate must not create memory"
        );
    }

    #[test]
    fn pending_item_is_not_recall_eligible() {
        let conn = mem_conn();
        let mut pending = MemoryItem::new(
            MemoryType::Fact,
            Scope::Project,
            Source::AssistantInferred,
            Status::Pending,
        );
        pending.summary = Some("tentative fact about routing".into());
        store::insert_item(&conn, &pending).unwrap();

        let hits = store::search_items(&conn, "routing", Status::Active, 10).unwrap();
        assert!(
            hits.is_empty(),
            "pending memory must not be treated as truth"
        );
    }

    #[test]
    fn deprecated_item_drops_out_of_active_recall() {
        let conn = mem_conn();
        let mut item = MemoryItem::new(
            MemoryType::Decision,
            Scope::Project,
            Source::UserExplicit,
            Status::Active,
        );
        item.summary = Some("use sqlite as canonical store".into());
        store::insert_item(&conn, &item).unwrap();
        assert_eq!(
            store::search_items(&conn, "canonical", Status::Active, 10)
                .unwrap()
                .len(),
            1
        );

        // deprecate
        item.status = Status::Deprecated;
        store::insert_item(&conn, &item).unwrap();
        assert!(store::search_items(&conn, "canonical", Status::Active, 10)
            .unwrap()
            .is_empty());
    }
}
