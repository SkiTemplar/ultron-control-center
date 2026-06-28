// ULTRON Control Center — QdrantStore adapter (MEMORY CORE D4)
//
// Wraps the existing `crate::qdrant` functions (HTTP REST, no gRPC) and
// exposes them through the `MemoryStore` trait.
//
// The `ultron_sessions` collection (384-d BGE) was retired 2026-06-20 and the
// 384-d embedding path was removed 2026-06-28. `add()` and `search()` now return
// `RemoteUnavailable` immediately. The only LIVE method is `health()`, which
// calls `qdrant_ping` (no collection query) and is used by `memory_health`.

use super::{
    Capabilities, MemoryDoc, MemoryError, MemoryHit, MemoryStore, Query, StoreHealth, StoreKind,
};

const COLLECTION: &str = "ultron_sessions";

/// `MemoryStore` implementation backed by the local Qdrant instance.
///
/// `add` and `search` are retired (384-d BGE path removed 2026-06-28). Only
/// `health` (Qdrant ping) and `delete` remain functional.
pub struct QdrantStore;

impl QdrantStore {
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

impl Default for QdrantStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStore for QdrantStore {
    fn add(&self, _doc: MemoryDoc) -> Result<MemoryHit, MemoryError> {
        // 384-d BGE store retired 2026-06-28. Write path is dead.
        Err(MemoryError::RemoteUnavailable(
            "384d store retired 2026-06-28".into(),
        ))
    }

    fn search(&self, _query: Query) -> Result<Vec<MemoryHit>, MemoryError> {
        // 384-d BGE store retired 2026-06-28. Search path is dead.
        Err(MemoryError::RemoteUnavailable(
            "384d store retired 2026-06-28".into(),
        ))
    }

    fn delete(&self, id: &str) -> Result<(), MemoryError> {
        // Strip the "qdrant::" prefix if present, then attempt deletion via
        // the REST API directly.
        let point_id = id.strip_prefix("qdrant::").unwrap_or(id);
        let base =
            std::env::var("QDRANT_URL").unwrap_or_else(|_| "http://localhost:6333".to_string());
        let url = format!("{base}/collections/{COLLECTION}/points/delete");

        // Build the id value — numeric or string.
        let id_value: serde_json::Value = if let Ok(n) = point_id.parse::<u64>() {
            serde_json::json!({ "points": [n] })
        } else {
            serde_json::json!({ "points": [point_id] })
        };

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| MemoryError::RemoteUnavailable(format!("http client: {e}")))?;

        let resp = client
            .post(&url)
            .json(&id_value)
            .send()
            .map_err(|e| MemoryError::RemoteUnavailable(format!("qdrant delete: {e}")))?;

        if resp.status().as_u16() == 404 {
            return Err(MemoryError::NotFound(id.to_string()));
        }
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().unwrap_or_default();
            return Err(MemoryError::RemoteUnavailable(format!(
                "qdrant delete {status}: {body}"
            )));
        }
        Ok(())
    }

    fn health(&self) -> Result<StoreHealth, MemoryError> {
        let t0 = std::time::Instant::now();
        match crate::qdrant::qdrant_ping() {
            Ok(version) => Ok(StoreHealth {
                healthy: true,
                message: format!("Qdrant OK — version {version}"),
                latency_ms: Some(t0.elapsed().as_millis() as u64),
            }),
            Err(e) => Ok(StoreHealth {
                healthy: false,
                message: format!("Qdrant unavailable: {e}"),
                latency_ms: Some(t0.elapsed().as_millis() as u64),
            }),
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            writable: true,
            semantic_search: true,
            persistent: true,
            kind: StoreKind::Qdrant,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qdrant_store_capabilities() {
        let store = QdrantStore::new();
        let caps = store.capabilities();
        assert!(caps.semantic_search);
        assert!(caps.persistent);
        assert_eq!(caps.kind, StoreKind::Qdrant);
    }
}
