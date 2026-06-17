// memory/service/mutations.rs — direct writes, mutations, reads, and stats
//
// Covers: add_imported, get, search_active, list_by_status, history, edit,
//         set_status, deprecate, deprecate_by_type, pin/unpin/set_pinned,
//         list_pinned, list_active_of_type, query_items, relabel, supersede,
//         forget, stats.

use super::super::model::{
    estimate_tokens, now_millis, Actor, EventType, MemoryEvent, MemoryItem, MemoryType, Scope,
    Status,
};
use super::super::MemoryError;
use super::super::{redaction, sqlite_store as store};
use super::{
    raised_sensitivity, redact_tags, sync_index, BulkDeprecateResult, MemoryService, MemoryStats,
};

impl MemoryService {
    // -- direct writes (migration / ETL only) --------------------------------

    /// Insert an already-formed item (used by one-shot ETL imports). Caller sets
    /// `source = Imported*` and the status (active for clear data, pending for
    /// doubtful). Emits an `imported` event.
    pub fn add_imported(item: &MemoryItem) -> Result<(), MemoryError> {
        let conn = store::open_conn()?;
        // Write-path secret guard (OLA A): redact credentials from imported text
        // (external/ETL sources are lower-trust) before persisting/indexing.
        let mut item = item.clone();
        let mut secret = false;
        secret |= redaction::redact_in_place(&mut item.title);
        secret |= redaction::redact_in_place(&mut item.summary);
        secret |= redaction::redact_in_place(&mut item.content);
        secret |= redaction::redact_in_place(&mut item.content_json);
        secret |= redact_tags(&mut item.tags);
        // H2: mark imported item Secret if any credential was detected (never downgrade).
        item.sensitivity = raised_sensitivity(item.sensitivity, secret);
        store::insert_item(&conn, &item)?;
        sync_index(&item); // W4: index active imports (bulk ETL still runs reindex_all)
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
        // Write-path secret guard (H2 / review P1): an edit can introduce a
        // credential, and W4 now indexes edited items into Qdrant — redact +
        // escalate sensitivity BEFORE persisting/indexing.
        let mut secret = redaction::redact_in_place(&mut item.title);
        secret |= redaction::redact_in_place(&mut item.summary);
        secret |= redaction::redact_in_place(&mut item.content);
        secret |= redaction::redact_in_place(&mut item.content_json);
        secret |= redact_tags(&mut item.tags);
        item.sensitivity = raised_sensitivity(item.sensitivity, secret);
        item.updated_at = now_millis();
        item.token_estimate = estimate_tokens(&item.searchable_text());
        store::insert_item(&conn, &item)?;
        sync_index(&item); // W4: re-embed/refresh the dense index after an edit

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
        sync_index(&item); // W4: Active -> (re)index ; non-active -> remove from index

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

    /// Bulk-deprecate every ACTIVE item of `kind` (optionally scoped to one
    /// `project`). Reuses the single-item [`Self::set_status`] path per id, so
    /// FTS5 triggers + Qdrant (`sync_index`) + the append-only event log all stay
    /// consistent — no bespoke sync logic. `dry_run` only counts (mutates nothing).
    /// A per-item failure is collected in `failed` and does NOT abort the batch.
    pub fn deprecate_by_type(
        kind: MemoryType,
        dry_run: bool,
        project: Option<&str>,
        reason: Option<String>,
        actor: Actor,
    ) -> Result<BulkDeprecateResult, MemoryError> {
        let kind_label: &'static str = kind.as_str();
        // 100_000 is an effective "all" bound (the active set is ~1.9k items).
        let items = Self::list_active_of_type(kind, 100_000)?;
        let items: Vec<MemoryItem> = match project {
            Some(p) => items
                .into_iter()
                .filter(|it| it.project_id.as_deref() == Some(p))
                .collect(),
            None => items,
        };
        let matched = items.len();
        let proj_owned = project.map(str::to_string);
        if dry_run {
            return Ok(BulkDeprecateResult {
                kind: kind_label.to_string(),
                matched,
                deprecated: 0,
                dry_run: true,
                project: proj_owned,
                failed: Vec::new(),
            });
        }
        let reason = reason.unwrap_or_else(|| format!("bulk-deprecate type={kind_label}"));
        let mut deprecated = 0usize;
        let mut failed: Vec<(String, String)> = Vec::new();
        for it in items {
            match Self::set_status(&it.id, Status::Deprecated, actor, Some(reason.clone())) {
                Ok(_) => deprecated += 1,
                Err(e) => failed.push((it.id, e.to_string())),
            }
        }
        Ok(BulkDeprecateResult {
            kind: kind_label.to_string(),
            matched,
            deprecated,
            dry_run: false,
            project: proj_owned,
            failed,
        })
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

    /// Memory Browser — paginated/filterable read-only listing over `memory_items`.
    /// Every filter is optional and AND-combined; returns `(page, total)` so the UI
    /// can paginate. Read-only: opens its own connection, appends no event.
    #[allow(clippy::too_many_arguments)]
    pub fn query_items(
        status: Option<Status>,
        kind: Option<MemoryType>,
        search: Option<String>,
        pinned_only: bool,
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<MemoryItem>, i64), MemoryError> {
        let conn = store::open_conn()?;
        store::query_items(
            &conn,
            status,
            kind,
            search.as_deref(),
            pinned_only,
            offset,
            limit,
        )
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
        sync_index(&item); // W4: refresh the dense index payload (scope/type) after relabel
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
        // Temporal resolver: the new assertion becomes vigente NOW. (valid_to
        // stays None until it is itself superseded.)
        let supersede_at = now_millis();
        if new_item.valid_from.is_none() {
            new_item.valid_from = Some(supersede_at);
        }
        // Write-path secret guard (H2 / review P1): supersede writes a NEW active
        // item that W4 indexes — redact + escalate sensitivity before persisting.
        let mut secret = redaction::redact_in_place(&mut new_item.title);
        secret |= redaction::redact_in_place(&mut new_item.summary);
        secret |= redaction::redact_in_place(&mut new_item.content);
        secret |= redaction::redact_in_place(&mut new_item.content_json);
        secret |= redact_tags(&mut new_item.tags);
        new_item.sensitivity = raised_sensitivity(new_item.sensitivity, secret);
        new_item.updated_at = now_millis();
        store::insert_item(&conn, &new_item)?;
        sync_index(&new_item); // W4: index the new active item

        old.status = Status::Deprecated;
        old.superseded_by = Some(new_item.id.clone());
        // Temporal resolver: the OLD assertion stopped being vigente at the moment
        // it was superseded. Recall prefers items with valid_to NULL/future, so
        // this keeps the historical row queryable but out of "current truth".
        old.valid_to = Some(supersede_at);
        old.updated_at = supersede_at;
        store::insert_item(&conn, &old)?;
        sync_index(&old); // W4: drop the superseded (now deprecated) item from the index

        let ev = MemoryEvent::new(EventType::Deprecated, Some(old_id.to_string()), actor)
            .with_reason(format!("superseded by {}", new_item.id));
        let _ = store::insert_event(&conn, &ev);
        let ev2 = MemoryEvent::new(EventType::Created, Some(new_item.id.clone()), actor)
            .with_reason(format!("supersedes {old_id}"));
        let _ = store::insert_event(&conn, &ev2);
        Ok(new_item)
    }

    // -- hard delete (H4: verifiable forget) ---------------------------------

    /// Permanently and irreversibly delete an item (H4 — verifiable forget).
    ///
    /// Unlike [`Self::deprecate`] / `set_status(Rejected|Quarantined)` (which keep
    /// the row but make it non-recall-eligible), `forget` removes the row from the
    /// SoT (`brain.db`) entirely. This is an EXPLICIT, INTENTIONAL erasure (right
    /// to be forgotten / leaked-secret purge), never an automatic lifecycle move.
    ///
    /// Order: get_item (NotFound if absent) -> snapshot `before` for audit ->
    /// `store::delete_item` (SQLite SoT) -> `qdrant_index::remove_item` (best-effort,
    /// keeps reconcile clean) -> append a `MemoryEvent` (`Updated` + reason
    /// `forgotten`, `before` = item_json — the only surviving record of the item).
    pub fn forget(id: &str, actor: Actor, reason: Option<String>) -> Result<(), MemoryError> {
        let conn = store::open_conn()?;
        let item =
            store::get_item(&conn, id)?.ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        let before = serde_json::to_string(&item).unwrap_or_default();
        // Remove from the SoT (SQLite). Propagate any error — the delete MUST land.
        store::delete_item(&conn, id)?;
        // Best-effort: drop the derived dense point so recall can't resurface it.
        let _ = super::super::qdrant_index::remove_item(id);
        let reason = reason.unwrap_or_else(|| "forgotten".to_string());
        let ev = MemoryEvent::new(EventType::Updated, Some(id.to_string()), actor)
            .with_reason(reason)
            .with_before(before);
        let _ = store::insert_event(&conn, &ev);
        Ok(())
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
