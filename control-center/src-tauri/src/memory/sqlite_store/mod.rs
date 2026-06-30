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
//   kg_entities / kg_relations — KG collapsed in from kg.jsonl
//
// Low-level fns take `&Connection` so they are unit-testable against a temp DB;
// thin public wrappers open `brain.db` per call (WAL = concurrent readers).
//
// Module layout:
//   schema.rs       — Connection setup, apply_schema, migrations, backfill
//   row_mapping.rs  — item_from_row, candidate_from_row, ITEM_COLS, sparse_terms
//   items.rs        — CRUD + search on memory_items
//   events.rs       — Append-only memory_events
//   candidates.rs   — memory_candidates inbox
//   store_impl.rs   — SqliteStore MemoryStore impl + KG import + code edges

pub(crate) mod candidates;
pub(crate) mod deprecation;
pub(crate) mod events;
pub(crate) mod items;
pub(crate) mod row_mapping;
pub(crate) mod schema;
pub(crate) mod store_impl;
#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Public re-exports — all callers use `crate::memory::sqlite_store::*`
// ---------------------------------------------------------------------------

pub use schema::{apply_schema, open_conn};

pub use items::{
    count_by_source, count_items_by_status, delete_item, find_active_by_content_hash,
    find_ids_by_prefix, get_item, insert_item, item_exists_by_qdrant_id, list_by_type_status,
    list_items, list_pinned, query_items, search_items,
};

pub use events::{insert_event, list_events_for};

pub use candidates::{
    count_candidates_pending, get_candidate, insert_candidate, list_candidates,
    set_candidate_status,
};

pub use store_impl::{import_kg_jsonl, insert_code_edge, SqliteStore};

// Ledger vivo de deprecaciones (cat21.4): escritor único + helper de timestamp.
// `pub(crate)` porque solo MemoryService (mismo crate) escribe aquí.
pub(crate) use deprecation::{insert_deprecation_entry, millis_to_iso_utc, DeprecationEntryInput};
