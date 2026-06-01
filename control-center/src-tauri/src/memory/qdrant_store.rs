// ULTRON Control Center — QdrantStore adapter (MEMORY CORE D4)
//
// Wraps the existing `crate::qdrant` functions (HTTP REST, no gRPC) and
// exposes them through the `MemoryStore` trait.
//
// Search is the important path: embed the query text, run k-NN against the
// `ultron_sessions` collection, and map `QdrantHit` -> `MemoryHit`.
//
// `add` and `delete` are delegated to the existing upsert/delete REST calls
// where they exist; otherwise `MemoryError::Unsupported` is returned — the
// frontend ingest path writes to Qdrant via the dedicated session-recall-inject
// sidecar binary, not through this adapter.

use super::{Capabilities, MemoryDoc, MemoryError, MemoryHit, MemoryStore, Query, StoreHealth, StoreKind};

const COLLECTION: &str = "ultron_sessions";
const DEFAULT_K: u32 = 10;

/// `MemoryStore` implementation backed by the local Qdrant instance.
///
/// Search embeds the query text with BGE-small-EN-v1.5 (via the existing
/// `crate::qdrant::embed` function) and performs a cosine k-NN search.
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
    fn add(&self, doc: MemoryDoc) -> Result<MemoryHit, MemoryError> {
        // Generate an id and embed the text.
        let id = format!(
            "qdrant::{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        let vector = crate::qdrant::embed(&doc.text)
            .map_err(|e| MemoryError::RemoteUnavailable(format!("embed: {e}")))?;

        let mut payload = std::collections::HashMap::new();
        payload.insert("text".to_string(), serde_json::json!(doc.text));
        if let Some(ref ns) = doc.namespace {
            payload.insert("namespace".to_string(), serde_json::json!(ns));
        }

        crate::qdrant::upsert_point(COLLECTION, &id, vector, payload)
            .map_err(|e| MemoryError::RemoteUnavailable(format!("upsert: {e}")))?;

        Ok(MemoryHit {
            id,
            text: doc.text,
            score: 1.0,
            source: StoreKind::Qdrant,
            namespace: doc.namespace,
        })
    }

    fn search(&self, query: Query) -> Result<Vec<MemoryHit>, MemoryError> {
        let k = query.limit.unwrap_or(DEFAULT_K).min(20);

        let hits = crate::qdrant::search(COLLECTION, &query.text, k)
            .map_err(|e| MemoryError::RemoteUnavailable(format!("qdrant search: {e}")))?;

        let memory_hits = hits
            .into_iter()
            .map(|h| {
                // Extract a human-readable text from the payload if available.
                let text = h
                    .payload
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("[qdrant point {}]", h.id));
                let namespace = h
                    .payload
                    .get("namespace")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                MemoryHit {
                    id: h.id,
                    text,
                    score: h.score,
                    source: StoreKind::Qdrant,
                    namespace,
                }
            })
            .collect();

        Ok(memory_hits)
    }

    fn delete(&self, id: &str) -> Result<(), MemoryError> {
        // Strip the "qdrant::" prefix if present, then attempt deletion via
        // the REST API directly.
        let point_id = id.strip_prefix("qdrant::").unwrap_or(id);
        let base = std::env::var("QDRANT_URL")
            .unwrap_or_else(|_| "http://localhost:6333".to_string());
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
