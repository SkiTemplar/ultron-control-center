// memory/service/mutations.rs — direct writes, mutations, reads, and stats
//
// Covers: add_imported, get, search_active, list_by_status, history, edit,
//         set_status, deprecate, pin/unpin/set_pinned,
//         list_pinned, list_active_of_type, query_items, relabel, supersede,
//         forget, backfill_deprecations, stats. Bulk maintenance lives in
//         `maintenance.rs`.

use super::super::model::{
    estimate_tokens, now_millis, Actor, EventType, MemoryEvent, MemoryItem, MemoryType, Scope,
    Status,
};
use super::super::MemoryError;
use super::super::{redaction, sqlite_store as store};
use super::{
    raised_sensitivity, redact_item_in_place, redact_tags, sync_index, BackfillDeprecationsResult,
    MemoryService, MemoryStats,
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
        let ev = MemoryEvent::new(EventType::Imported, Some(item.id.clone()), Actor::Migration)
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        store::insert_item_with_event(&conn, &item, &ev)?;
        sync_index(&item); // W4: index active imports (bulk ETL still runs reindex_all)
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

    /// Como [`Self::search_active`] restringido a un tipo (F1.3: solo `lesson`).
    pub fn search_active_of_type(
        query: &str,
        kind: MemoryType,
        limit: usize,
    ) -> Result<Vec<MemoryItem>, MemoryError> {
        let conn = store::open_conn()?;
        store::search_items_typed(&conn, query, Status::Active, Some(kind.as_str()), limit)
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
        let ev = MemoryEvent::new(EventType::Edited, Some(item.id.clone()), actor)
            .with_before(before)
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        store::insert_item_with_event(&conn, &item, &ev)?;
        sync_index(&item); // W4: re-embed/refresh the dense index after an edit
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
        let item = Self::set_status_on(&conn, id, status, actor, reason)?;
        sync_index(&item); // W4: Active -> (re)index ; non-active -> remove from index
        Ok(item)
    }

    /// [`Self::set_status`] sobre una conexión dada y sin tocar Qdrant. El
    /// item, la entrada del ledger de deprecaciones y el evento van en una sola
    /// transacción: si el evento no se puede registrar, el status no cambia.
    pub(crate) fn set_status_on(
        conn: &rusqlite::Connection,
        id: &str,
        status: Status,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<MemoryItem, MemoryError> {
        let mut item =
            store::get_item(conn, id)?.ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        let before = serde_json::to_string(&item).unwrap_or_default();
        let event_type = match status {
            Status::Deprecated => EventType::Deprecated,
            Status::Rejected => EventType::Rejected,
            Status::Active => EventType::Restored,
            _ => EventType::Updated,
        };
        item.status = status;
        item.updated_at = now_millis();

        // Ledger vivo (cat21.4): registrar la deprecación en deprecation_entries.
        // INSERT OR IGNORE con id "dep:{item_id}" => idempotente por diseño.
        // Solo cuando el status destino es Deprecated (las demás transiciones —
        // Rejected, Stale… — no registran en el ledger).
        let entry = matches!(status, Status::Deprecated).then(|| {
            deprecation_entry(
                &item,
                reason.clone().unwrap_or_else(|| "deprecated".to_string()),
                item.superseded_by.clone(),
            )
        });
        let mut ev = MemoryEvent::new(event_type, Some(item.id.clone()), actor)
            .with_before(before)
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        if let Some(r) = reason {
            ev = ev.with_reason(r);
        }
        store::in_immediate_tx(conn, || {
            store::insert_item(conn, &item)?;
            if let Some(entry) = &entry {
                store::insert_deprecation_entry(conn, entry)?;
            }
            store::insert_event(conn, &ev)
        })?;
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
        let ev = MemoryEvent::new(EventType::Edited, Some(item.id.clone()), actor)
            .with_before(before)
            .with_reason(if pinned { "pinned" } else { "unpinned" })
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        store::insert_item_with_event(&conn, &item, &ev)?;
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
        let ev = MemoryEvent::new(EventType::Edited, Some(item.id.clone()), actor)
            .with_before(before)
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        store::insert_item_with_event(&conn, &item, &ev)?;
        sync_index(&item); // W4: refresh the dense index payload (scope/type) after relabel
        Ok(item)
    }

    /// Replace `old_id` with a new active item, marking the old one deprecated
    /// and linking supersedes/superseded_by both ways.
    pub fn supersede(
        old_id: &str,
        new_item: MemoryItem,
        actor: Actor,
    ) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let (new_item, old) = Self::supersede_on(&conn, old_id, new_item, actor)?;
        sync_index(&new_item); // W4: index the new active item
        sync_index(&old); // W4: drop the superseded (now deprecated) item from the index
        Ok(new_item)
    }

    /// [`Self::supersede`] sobre una conexión dada y sin tocar Qdrant. Devuelve
    /// `(nuevo, viejo)`. Los dos items, la entrada del ledger de deprecaciones y
    /// los dos eventos van en una sola transacción.
    pub(crate) fn supersede_on(
        conn: &rusqlite::Connection,
        old_id: &str,
        mut new_item: MemoryItem,
        actor: Actor,
    ) -> Result<(MemoryItem, MemoryItem), MemoryError> {
        let mut old = store::get_item(conn, old_id)?
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
        redact_item_in_place(&mut new_item);
        new_item.updated_at = supersede_at;

        old.status = Status::Deprecated;
        old.superseded_by = Some(new_item.id.clone());
        // Temporal resolver: the OLD assertion stopped being vigente at the moment
        // it was superseded. Recall prefers items with valid_to NULL/future, so
        // this keeps the historical row queryable but out of "current truth".
        old.valid_to = Some(supersede_at);
        old.updated_at = supersede_at;

        let ev = MemoryEvent::new(EventType::Deprecated, Some(old_id.to_string()), actor)
            .with_reason(format!("superseded by {}", new_item.id));
        // Ledger vivo (cat21.4): la supersesión es una deprecación del viejo.
        // El `supersede` no pasa por `set_status`, así que el ledger se escribe
        // aquí. INSERT OR IGNORE = idempotente.
        let entry = deprecation_entry(
            &old,
            format!("superseded by {}", new_item.id),
            Some(new_item.id.clone()),
        );
        let ev2 = MemoryEvent::new(EventType::Created, Some(new_item.id.clone()), actor)
            .with_reason(format!("supersedes {old_id}"));
        store::in_immediate_tx(conn, || {
            store::insert_item(conn, &new_item)?;
            store::insert_item(conn, &old)?;
            store::insert_event(conn, &ev)?;
            store::insert_deprecation_entry(conn, &entry)?;
            store::insert_event(conn, &ev2)
        })?;
        Ok((new_item, old))
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
    /// `store::delete_item` + a `MemoryEvent` (`Updated` + reason `forgotten`,
    /// `before` = item_json — the only surviving record of the item) in ONE
    /// transaction -> `qdrant_index::remove_item` (best-effort, keeps reconcile
    /// clean). Without the event the row is not deleted.
    pub fn forget(id: &str, actor: Actor, reason: Option<String>) -> Result<(), MemoryError> {
        let conn = store::open_conn()?;
        Self::forget_on(&conn, id, actor, reason)?;
        // Best-effort: drop the derived dense point so recall can't resurface it.
        let _ = super::super::qdrant_index::remove_item(id);
        Ok(())
    }

    /// [`Self::forget`] sobre una conexión dada y sin tocar Qdrant.
    pub(crate) fn forget_on(
        conn: &rusqlite::Connection,
        id: &str,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<(), MemoryError> {
        let item =
            store::get_item(conn, id)?.ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        let ev = MemoryEvent::new(EventType::Updated, Some(id.to_string()), actor)
            .with_reason(reason.unwrap_or_else(|| "forgotten".to_string()))
            .with_before(serde_json::to_string(&item).unwrap_or_default());
        store::in_immediate_tx(conn, || {
            store::delete_item(conn, id)?;
            store::insert_event(conn, &ev)
        })
    }

    // -- backfill del ledger de deprecaciones (cat21.4) ----------------------

    /// Rellena one-shot `deprecation_entries` con las deprecaciones históricas
    /// que ya existen en `memory_events` pero aún no tienen entrada en el ledger.
    ///
    /// Recorre `memory_events WHERE event_type='deprecated'`, hace LEFT JOIN con
    /// `memory_items` para obtener `kind` y `superseded_by`, y llama a
    /// `insert_deprecation_entry` (INSERT OR IGNORE) por cada fila.
    ///
    /// `created_at` en `memory_events` es epoch-millis (INTEGER); se convierte a
    /// ISO-8601 UTC con `millis_to_iso_utc`. El deadline se fija a
    /// `created_at + 90 días`, que siempre cae en el futuro porque el brain.db
    /// tiene menos de 6 semanas.
    ///
    /// Idempotente: se puede ejecutar varias veces sin duplicar filas.
    pub fn backfill_deprecations() -> Result<BackfillDeprecationsResult, MemoryError> {
        let conn = store::open_conn()?;

        // Columna de referencia al item: `memory_id` (schema base).
        // `created_at` es INTEGER epoch-millis.
        // LEFT JOIN con memory_items para kind/superseded_by (NULL si el item
        // fue borrado vía `forget` — en ese caso kind queda como "unknown").
        let mut stmt = conn
            .prepare(
                "SELECT me.memory_id,
                        me.created_at,
                        me.reason,
                        mi.type,
                        mi.superseded_by
                 FROM memory_events me
                 LEFT JOIN memory_items mi ON mi.id = me.memory_id
                 WHERE me.event_type = 'deprecated'
                   AND me.memory_id IS NOT NULL
                 ORDER BY me.created_at ASC",
            )
            .map_err(|e| {
                MemoryError::RemoteUnavailable(format!("backfill_deprecations prepare: {e}"))
            })?;
        // (memory_id, created_at, reason, type, superseded_by) por evento 'deprecated'
        type DeprecationRow = (String, i64, Option<String>, Option<String>, Option<String>);
        let rows: Vec<DeprecationRow> = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| {
                MemoryError::RemoteUnavailable(format!("backfill_deprecations query: {e}"))
            })?
            .flatten()
            .collect();

        let scanned = rows.len();
        let mut inserted = 0usize;
        let mut skipped = 0usize;

        for (memory_id, created_at_ms, reason, kind_opt, superseded_by) in rows {
            let entry = deprecation_entry_for(
                &memory_id,
                kind_opt.unwrap_or_else(|| "unknown".to_string()),
                reason.unwrap_or_else(|| "deprecated".to_string()),
                superseded_by,
                created_at_ms,
            );
            match store::insert_deprecation_entry(&conn, &entry) {
                Ok(true) => inserted += 1,
                Ok(false) => skipped += 1,
                Err(_) => skipped += 1, // error no fatal: continuar con el resto
            }
        }

        Ok(BackfillDeprecationsResult {
            scanned,
            inserted,
            skipped,
        })
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

/// Entrada del ledger de deprecaciones (cat21.4) para un item que se depreca
/// ahora (`item.updated_at`).
fn deprecation_entry(
    item: &MemoryItem,
    reason: String,
    replacement: Option<String>,
) -> store::DeprecationEntryInput {
    deprecation_entry_for(
        &item.id,
        item.kind.as_str().to_string(),
        reason,
        replacement,
        item.updated_at,
    )
}

/// Entrada del ledger con id `dep:{id}` (INSERT OR IGNORE = idempotente) y
/// deadline a 90 días de `at_ms`.
fn deprecation_entry_for(
    id: &str,
    kind: String,
    reason: String,
    replacement: Option<String>,
    at_ms: i64,
) -> store::DeprecationEntryInput {
    let ts = store::millis_to_iso_utc(at_ms);
    store::DeprecationEntryInput {
        id: format!("dep:{id}"),
        artifact: id.to_string(),
        domain: "memory".to_string(),
        kind,
        owner: None,
        path: format!("memory://{id}"),
        reason,
        replacement,
        state: "deprecated".to_string(),
        risk: "low".to_string(),
        regenerable: 0,
        size_bytes: None,
        cleanup_action: "purge".to_string(),
        rollback_action: "restore".to_string(),
        first_seen: ts.clone(),
        last_seen: ts,
        deadline: store::millis_to_iso_utc(at_ms + 90 * 24 * 3_600 * 1_000_i64),
        retention_class: "memory-90d".to_string(),
        evidence_json: None,
        confirmed_by: None,
        schema_version: 3,
    }
}
