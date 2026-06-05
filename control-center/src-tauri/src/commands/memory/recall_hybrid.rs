// ULTRON Control Center — recall_hybrid + memory_health commands (MEMORY CORE D5)
//
// recall_hybrid: fan-out query across QdrantStore, SqliteStore, and KgStore.
//   EccStore and Mem0Store retired (wave2-mem0-ecc, 2026-06-06).
//
// memory_health: per-store health check + embeddings_real flag.

use crate::memory::{
    qdrant_store::QdrantStore, sqlite_store::SqliteStore, HybridRecall, KgStore, MemoryHit, Query,
};

/// Fan-out semantic + keyword recall across all registered memory stores.
///
/// Store priority (highest score wins after merge):
///   1. QdrantStore  — cosine similarity via BGE-small-EN-v1.5
///   2. SqliteStore  — FTS5 ranked / LIKE fallback + kg_entities
///   3. KgStore      — kg.jsonl substring search
#[tauri::command]
pub async fn recall_hybrid(query: String, limit: Option<u32>) -> Result<Vec<MemoryHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stores: Vec<Box<dyn crate::memory::MemoryStore>> = vec![
            Box::new(QdrantStore::new()),
            Box::new(SqliteStore::new()),
            Box::new(KgStore::new()),
        ];

        let recall = HybridRecall::new(stores);
        let q = Query {
            text: query,
            namespace: None,
            limit,
        };
        Ok(recall.search_all(q))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Per-store health summary + `embeddings_real` flag.
///
/// `embeddings_real` is `true` when `crate::qdrant::embed` returns a non-zero
/// vector for a known probe string (i.e. the real fastembed model is active).
#[tauri::command]
pub async fn memory_health() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let embeddings_real = probe_embeddings_real();

        let stores: Vec<(&str, Box<dyn crate::memory::MemoryStore>)> = vec![
            ("qdrant", Box::new(QdrantStore::new())),
            ("sqlite", Box::new(SqliteStore::new())),
            ("kg", Box::new(KgStore::new())),
        ];

        let mut statuses = serde_json::Map::new();
        for (name, store) in stores {
            let entry = match store.health() {
                Ok(h) => serde_json::json!({
                    "healthy": h.healthy,
                    "message": h.message,
                    "latency_ms": h.latency_ms,
                }),
                Err(e) => serde_json::json!({
                    "healthy": false,
                    "message": e.to_string(),
                    "latency_ms": null,
                }),
            };
            statuses.insert(name.to_string(), entry);
        }

        Ok(serde_json::json!({
            "stores": statuses,
            "embeddings_real": embeddings_real,
        }))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Probe whether `crate::qdrant::embed` is returning real (non-zero) vectors.
fn probe_embeddings_real() -> bool {
    match crate::qdrant::embed("ultron memory probe") {
        Ok(v) => v.iter().any(|&x| x != 0.0),
        Err(_) => false,
    }
}
