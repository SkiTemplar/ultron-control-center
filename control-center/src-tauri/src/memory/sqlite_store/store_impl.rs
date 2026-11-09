// sqlite_store/store_impl.rs — SqliteStore MemoryStore trait impl + health.

use rusqlite::Connection;

use crate::memory::model::{
    estimate_tokens, Actor, EventType, MemoryEvent, MemoryItem, MemoryType, Scope, Source, Status,
};
use crate::memory::{
    Capabilities, MemoryDoc, MemoryError, MemoryHit, MemoryStore, Query, StoreHealth, StoreKind,
};

use super::candidates::count_candidates_pending;
use super::events::insert_event;
use super::gc::fts_integrity;
use super::items::{count_items_by_status, delete_item, insert_item, search_items};
use super::schema::open_conn;
use super::tx::in_immediate_tx;

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

    /// Open `brain.db` and apply the schema. Wired into `lib.rs` setup so the
    /// canonical DB is live at startup.
    pub fn init() -> Result<(), MemoryError> {
        open_conn().map(|_| ())
    }
}

impl Default for SqliteStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Salud de `brain.db` sobre una conexión ya abierta. `healthy` sale del mismo
/// criterio que el check `fts` del doctor ([`super::FtsIntegrity::in_sync`]:
/// integridad FTS5 en verde y tantas filas en el índice como items). Antes era
/// `true` fijo y la tarjeta de memoria seguía en verde con el índice roto
/// (auditoría 2026-10-23). `details` lleva el estado del FTS5 para la UI.
pub(crate) fn health_on(conn: &Connection) -> Result<StoreHealth, MemoryError> {
    let active = count_items_by_status(conn, Status::Active);
    let pending = count_candidates_pending(conn);
    let fts = fts_integrity(conn)?;
    let in_sync = fts.in_sync();
    let message = if in_sync {
        format!(
            "brain.db OK — {active} active, {pending} pending candidates, FTS5 en sync ({} filas)",
            fts.fts_rows
        )
    } else {
        let detail = fts
            .error
            .as_deref()
            .map(|e| format!(" (integrity-check: {e})"))
            .unwrap_or_default();
        format!(
            "FTS5 desincronizado: {} filas en el índice frente a {} items{detail}; ejecuta `ultron-memory fts-rebuild`",
            fts.fts_rows, fts.item_rows
        )
    };
    Ok(StoreHealth {
        healthy: in_sync,
        message,
        latency_ms: None,
        details: Some(serde_json::json!({
            "fts_rows": fts.fts_rows,
            "item_rows": fts.item_rows,
            "integrity_ok": fts.integrity_ok,
            "in_sync": in_sync,
            "error": fts.error,
        })),
    })
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
        let ev = MemoryEvent::new(EventType::Created, Some(item.id.clone()), Actor::System);
        in_immediate_tx(&conn, || {
            insert_item(&conn, &item)?;
            insert_event(&conn, &ev)
        })?;
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
        let ev = MemoryEvent::new(EventType::Deprecated, Some(id.to_string()), Actor::System)
            .with_reason("hard delete via MemoryStore::delete");
        in_immediate_tx(&conn, || {
            delete_item(&conn, id)?;
            insert_event(&conn, &ev)
        })
    }

    fn health(&self) -> Result<StoreHealth, MemoryError> {
        health_on(&open_conn()?)
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

#[cfg(test)]
mod health_tests {
    use super::*;
    use crate::memory::sqlite_store::apply_schema;

    fn conn_con_items(ids: &[&str]) -> Connection {
        let c = Connection::open_in_memory().expect("open");
        apply_schema(&c).expect("schema");
        for id in ids {
            let mut it = MemoryItem::new(
                MemoryType::Fact,
                Scope::Project,
                Source::AssistantInferred,
                Status::Active,
            );
            it.id = (*id).to_string();
            it.title = Some(format!("item {id}"));
            insert_item(&c, &it).expect("insert");
        }
        c
    }

    #[test]
    fn health_en_verde_con_el_fts_en_sync() {
        let c = conn_con_items(&["a", "b"]);
        let h = health_on(&c).unwrap();
        assert!(h.healthy, "{}", h.message);
        let d = h.details.expect("details del FTS5");
        assert_eq!(d["fts_rows"], 2);
        assert_eq!(d["item_rows"], 2);
        assert_eq!(d["in_sync"], true);
    }

    // Caso negativo: antes `healthy` era `true` fijo. Un borrado sin trigger deja
    // una fila huérfana en el índice: la salud debe ponerse en rojo con las
    // mismas cifras que el check `fts` del doctor.
    #[test]
    fn health_en_rojo_con_el_fts_desincronizado() {
        let c = conn_con_items(&["a", "huerfano"]);
        c.execute_batch(
            "DROP TRIGGER memory_items_ad; DELETE FROM memory_items WHERE id = 'huerfano';",
        )
        .expect("borrado sin trigger");
        let h = health_on(&c).unwrap();
        assert!(!h.healthy, "un FTS desincronizado no puede dar healthy");
        assert!(h.message.contains("desincronizado"), "{}", h.message);
        let d = h.details.expect("details del FTS5");
        assert_eq!(
            (d["fts_rows"].as_i64(), d["item_rows"].as_i64()),
            (Some(2), Some(1))
        );
        assert_eq!(d["in_sync"], false);
    }
}
