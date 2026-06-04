// ULTRON Control Center — recall_hybrid + memory_health commands (MEMORY CORE D5)
//
// recall_hybrid: fan-out query across QdrantStore, SqliteStore, EccStore, and
//   optionally Mem0Store (skipped when MEM0_API_KEY is absent so offline recall
//   stays fast).
//
// memory_health: per-store health check + embeddings_real flag.

use crate::memory::{
    qdrant_store::QdrantStore, sqlite_store::SqliteStore, EccStore, HybridRecall, KgStore,
    MemoryHit, MemoryStore, Query,
};

/// Fan-out semantic + keyword recall across all registered memory stores.
///
/// Store priority (highest score wins after merge):
///   1. QdrantStore  — cosine similarity via BGE-small-EN-v1.5
///   2. SqliteStore  — FTS5 ranked / LIKE fallback + kg_entities
///   3. EccStore     — ECC JSONL substring search
///   4. KgStore      — kg.jsonl substring search
///   5. Mem0Store    — cloud recall (skipped when MEM0_API_KEY not configured)
#[tauri::command]
pub async fn recall_hybrid(query: String, limit: Option<u32>) -> Result<Vec<MemoryHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut stores: Vec<Box<dyn crate::memory::MemoryStore>> = Vec::new();

        // Qdrant — always included; if offline it contributes 0 hits.
        stores.push(Box::new(QdrantStore::new()));

        // SQLite — always included.
        stores.push(Box::new(SqliteStore::new()));

        // ECC read-only snapshot.
        stores.push(Box::new(EccStore::new()));

        // Local KG.
        stores.push(Box::new(KgStore::new()));

        // Mem0 — only when a real API key is configured.
        if mem0_key_is_configured() {
            stores.push(Box::new(crate::memory::Mem0Store::new(Some(
                "USER".into(),
            ))));
        }

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
            ("ecc", Box::new(EccStore::new())),
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

        // Mem0 health — only attempted when key is configured.
        let mem0_entry = if mem0_key_is_configured() {
            let store: Box<dyn MemoryStore> =
                Box::new(crate::memory::Mem0Store::new(Some("USER".into())));
            match store.health() {
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
            }
        } else {
            serde_json::json!({
                "healthy": false,
                "message": "MEM0_API_KEY not configured",
                "latency_ms": null,
            })
        };
        statuses.insert("mem0".to_string(), mem0_entry);

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

/// Returns `true` when a non-placeholder MEM0_API_KEY is present in the
/// environment (reuses the same heuristic as `crate::mem0`).
fn mem0_key_is_configured() -> bool {
    match std::env::var("MEM0_API_KEY") {
        Ok(k) => {
            let k = k.trim().to_string();
            !k.is_empty()
                && !k.starts_with("REEMPLAZAR")
                && !k.eq_ignore_ascii_case("your-key-here")
        }
        Err(_) => false,
    }
}

/// Probe whether `crate::qdrant::embed` is returning real (non-zero) vectors.
fn probe_embeddings_real() -> bool {
    match crate::qdrant::embed("ultron memory probe") {
        Ok(v) => v.iter().any(|&x| x != 0.0),
        Err(_) => false,
    }
}
