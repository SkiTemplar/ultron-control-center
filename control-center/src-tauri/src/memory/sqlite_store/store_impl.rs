// sqlite_store/store_impl.rs — SqliteStore MemoryStore trait impl + KG import + code edges.

use rusqlite::params;

use crate::memory::model::{
    estimate_tokens, Actor, EventType, MemoryEvent, MemoryItem, MemoryType, Scope, Source, Status,
};
use crate::memory::{
    Capabilities, MemoryDoc, MemoryError, MemoryHit, MemoryStore, Query, StoreHealth, StoreKind,
};

use super::candidates::count_candidates_pending;
use super::events::insert_event;
use super::items::{count_items_by_status, delete_item, insert_item, search_items};
use super::schema::{fts5_available, open_conn};

// ---------------------------------------------------------------------------
// KG jsonl import (collapsed into brain.db)
// ---------------------------------------------------------------------------

/// Import entities + relations from `~/.ultron/cockpit/kg.jsonl`. Idempotent.
pub fn import_kg_jsonl(conn: &rusqlite::Connection) -> Result<(), MemoryError> {
    let graph = crate::kg::read_graph_inner()
        .map_err(|e| MemoryError::ParseError(format!("kg.jsonl read: {e}")))?;
    for ent in &graph.entities {
        let obs_json =
            serde_json::to_string(&ent.observations).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT OR REPLACE INTO kg_entities (name, entity_type, observations) VALUES (?1,?2,?3)",
            params![ent.name, ent.entity_type, obs_json],
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("kg import entity: {e}")))?;
    }
    for rel in &graph.relations {
        conn.execute(
            "INSERT OR IGNORE INTO kg_relations (from_name, to_name, relation_type) VALUES (?1,?2,?3)",
            params![rel.from, rel.to, rel.relation_type],
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("kg import relation: {e}")))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// SqliteStore — MemoryStore trait impl (back-compat for recall_hybrid/health)
// ---------------------------------------------------------------------------

/// `MemoryStore` adapter over the canonical `memory_items` table.
pub struct SqliteStore;

impl SqliteStore {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Open `brain.db`, apply the schema, and best-effort import kg.jsonl.
    /// Wired into `lib.rs` setup so the canonical DB is live at startup.
    pub fn init() -> Result<(), MemoryError> {
        let conn = open_conn()?;
        if let Err(e) = import_kg_jsonl(&conn) {
            eprintln!("[sqlite_store] kg.jsonl import skipped: {e}");
        }
        Ok(())
    }
}

impl Default for SqliteStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStore for SqliteStore {
    fn add(&self, doc: MemoryDoc) -> Result<MemoryHit, MemoryError> {
        let conn = open_conn()?;
        let mut item = MemoryItem::new(
            MemoryType::Fact,
            Scope::Global,
            Source::ManualUi,
            Status::Active,
        );
        item.summary = Some(doc.text.clone());
        item.content = Some(doc.text.clone());
        item.project_id = doc.namespace.clone();
        item.token_estimate = estimate_tokens(&doc.text);
        insert_item(&conn, &item)?;
        let ev = MemoryEvent::new(EventType::Created, Some(item.id.clone()), Actor::System);
        let _ = insert_event(&conn, &ev);
        Ok(MemoryHit {
            id: item.id,
            text: doc.text,
            score: 1.0,
            source: StoreKind::Sqlite,
            namespace: doc.namespace,
        })
    }

    fn search(&self, query: Query) -> Result<Vec<MemoryHit>, MemoryError> {
        let conn = open_conn()?;
        let limit = query.limit.unwrap_or(20) as usize;
        // Only ACTIVE items are recall-eligible (governance invariant).
        let items = search_items(&conn, &query.text, Status::Active, limit)?;
        Ok(items
            .into_iter()
            .map(|it| MemoryHit {
                text: it
                    .summary
                    .clone()
                    .or(it.content.clone())
                    .unwrap_or_default(),
                id: it.id,
                // Pilar 1 fix: blend confidence into score so high-quality codebase_fact
                // (confidence 0.6–0.95) outranks imported_vault bulk imports (confidence 0.5).
                // Formula: importance anchors the magnitude; confidence provides the signal.
                // Both in [0,1], result clamped to [0,1].
                score: (it.importance * (0.5 + 0.5 * it.confidence)).clamp(0.0, 1.0),
                source: StoreKind::Sqlite,
                namespace: it.project_id,
            })
            .collect())
    }

    fn delete(&self, id: &str) -> Result<(), MemoryError> {
        let conn = open_conn()?;
        delete_item(&conn, id)?;
        let ev = MemoryEvent::new(EventType::Deprecated, Some(id.to_string()), Actor::System)
            .with_reason("hard delete via MemoryStore::delete");
        let _ = insert_event(&conn, &ev);
        Ok(())
    }

    fn health(&self) -> Result<StoreHealth, MemoryError> {
        let conn = open_conn()?;
        let active = count_items_by_status(&conn, Status::Active);
        let pending = count_candidates_pending(&conn);
        let kg: i64 = conn
            .query_row("SELECT COUNT(*) FROM kg_entities", [], |r| r.get(0))
            .unwrap_or(0);
        Ok(StoreHealth {
            healthy: true,
            message: format!(
                "brain.db OK — {active} active, {pending} pending candidates, {kg} kg_entities, fts5={}",
                fts5_available(&conn)
            ),
            latency_ms: None,
        })
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            writable: true,
            semantic_search: false,
            persistent: true,
            kind: StoreKind::Sqlite,
        }
    }
}
