// ULTRON Control Center — Canonical SQLite store (MEMORY KERNEL · Fase A)
//
// `~/.ultron/brain.db` is THE source of truth for governed memory. This module
// owns the schema and all low-level persistence; `MemoryService` (service.rs)
// layers the audit-event + candidate-lifecycle semantics on top.
//
// Schema (idempotent on open):
//   memory_items      — governed memories (status/confidence/importance/scope/…)
//   memory_items_fts  — FTS5 mirror of title+summary+content (sparse/keyword)
//   memory_events     — append-only audit log of every mutation
//   memory_candidates — proposals awaiting validation (the inbox)
//   kg_entities / kg_relations — tablas heredadas del KG (sin escritor desde 2026-10-23)
//
// Low-level fns take `&Connection` so they are unit-testable against a temp DB;
// thin public wrappers open `brain.db` per call (WAL = concurrent readers).
//
// Module layout:
//   schema.rs       — Connection setup, apply_schema, migrations, backfill
//   schema_columns.rs — ADD COLUMN idempotente (tolera la carrera entre procesos)
//   schema_fts.rs   — índice FTS5 + triggers (creación y rebuild atómicos)
//   row_mapping.rs  — item_from_row, candidate_from_row, ITEM_COLS, sparse_terms
//   items.rs        — CRUD + search on memory_items
//   events.rs       — Append-only memory_events
//   candidates.rs   — memory_candidates inbox
//   store_impl.rs   — SqliteStore MemoryStore impl + health (FTS5 en sync)
//   tx.rs           — in_immediate_tx (mutación + evento atómicos)

pub(crate) mod candidates;
pub(crate) mod deprecation;
pub(crate) mod events;
pub(crate) mod gc;
pub(crate) mod id_prefix;
pub(crate) mod items;
pub(crate) mod row_mapping;
pub(crate) mod schema;
mod schema_columns;
mod schema_fts;
pub(crate) mod store_impl;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_lifecycle;
#[cfg(test)]
mod tests_schema;

// ---------------------------------------------------------------------------
// Public re-exports — all callers use `crate::memory::sqlite_store::*`
// ---------------------------------------------------------------------------

mod archive;
pub use archive::{
    archive_contains, archive_item, count_archived, ensure_archive_table, ARCHIVE_TABLE,
};
pub use schema::{
    apply_schema, brain_db_overridden, brain_db_override, open_conn, BRAIN_DB_ENV,
    LATEST_USER_VERSION,
};

pub use items::{
    count_by_source, count_items_by_status, delete_item, find_active_by_content_hash,
    find_ids_by_prefix, get_item, insert_item, item_exists_by_qdrant_id,
    list_active_duplicate_groups, list_by_type_status, list_items, list_pinned, query_items,
    search_items, search_items_typed, touch_injected,
};

pub use events::{insert_event, list_events_for};

pub use id_prefix::{resolve_unique_id, MIN_ID_PREFIX_CHARS};

// Mantenimiento a 90 dias (F1.8): SQL puro. Lo orquesta `MemoryService::gc`.
pub use gc::{
    db_size_bytes, freelist_bytes, fts_integrity, fts_rebuild, prune_events,
    select_decayed_active_ids, vacuum, EventPruneCounts, FtsIntegrity,
};

// Barrido de secretos ya persistidos: SQL puro. Lo orquesta
// `MemoryService::scrub_secrets`.
mod scrub;
pub use scrub::{
    all_item_ids, checkpoint_truncate, enable_secure_delete, scrub_table, TableScrub, SCRUB_TARGETS,
};

pub use candidates::{
    count_candidates_pending, find_candidate_ids_by_prefix, get_candidate, insert_candidate,
    list_candidates, set_candidate_status, set_candidate_status_if,
};

pub use store_impl::SqliteStore;

// Transacción de escritura (mutación + evento del ledger en la misma unidad).
pub(crate) mod tx;
pub(crate) use tx::{in_immediate_tx, insert_item_with_event};

// Ledger vivo de deprecaciones (cat21.4): escritor único + helper de timestamp.
// `pub(crate)` porque solo MemoryService (mismo crate) escribe aquí.
pub(crate) use deprecation::{
    insert_deprecation_entry, millis_to_iso_utc, select_overdue_deprecation_entries,
    update_deprecation_entry_state, DeprecationEntryInput,
};
