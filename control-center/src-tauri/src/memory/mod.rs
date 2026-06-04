// ULTRON Control Center — MemoryStore trait (KIRKARDO 21 design doc 9/10)
//
// Introduces a unified abstraction over the four memory backends:
//   - Mem0Store   : Mem0 cloud REST API  (read + write)
//   - EccStore    : ECC JSONL snapshot    (read-only)
//   - KgStore     : local kg.jsonl        (read + write)
//
// Plus a `HybridRecall` orchestrator that fans out a query across all
// registered stores, merges results, deduplicates by id, and returns them
// sorted by descending relevance score.
//
// The `hybrid_recall` Cargo feature (default = off) is required to use
// `HybridRecall`; the individual adapters compile unconditionally so that
// existing callers are not affected.
//
// Backward compat: all `*_inner` functions in `crate::mem0`, `crate::kg`,
// and `crate::ecc_memory` continue to work.  They are marked `#[deprecated]`
// where an equivalent trait-based path exists; this is a soft deprecation
// only — the warnings appear in developer builds to steer new code toward
// the trait, but existing call-sites compile without change.

use serde::{Deserialize, Serialize};
use thiserror::Error;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors that any `MemoryStore` implementation may return.
#[derive(Debug, Error)]
pub enum MemoryError {
    /// A document or entity with the given id was not found.
    #[error("not found: {0}")]
    NotFound(String),

    /// An I/O error occurred while accessing the backing store.
    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),

    /// The response or stored data could not be parsed.
    #[error("parse error: {0}")]
    ParseError(String),

    /// The remote backend is unavailable (network error, bad auth, …).
    #[error("remote unavailable: {0}")]
    RemoteUnavailable(String),

    /// The operation is not supported by this store (e.g. writes on a
    /// read-only store).
    #[error("unsupported: {0}")]
    Unsupported(String),
}

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

/// A document to be written into a memory store.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryDoc {
    /// The text body of the memory.
    pub text: String,
    /// Optional namespace / user scope (maps to Mem0's `user_id` concept).
    pub namespace: Option<String>,
    /// Arbitrary key-value tags attached to this document.
    pub tags: Vec<(String, String)>,
}

impl MemoryDoc {
    /// Construct a minimal `MemoryDoc` from a plain text string.
    ///
    /// # Examples
    ///
    /// ```
    /// # use control_center_lib::memory::MemoryDoc;
    /// let doc = MemoryDoc::from_text("session summary for project ultron");
    /// assert_eq!(doc.text, "session summary for project ultron");
    /// assert!(doc.namespace.is_none());
    /// assert!(doc.tags.is_empty());
    /// ```
    #[must_use]
    pub fn from_text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            namespace: None,
            tags: Vec::new(),
        }
    }
}

/// A record returned from a `MemoryStore` after a successful `add` or
/// `search` operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryHit {
    /// Stable identifier within the originating store.
    pub id: String,
    /// The text content of the stored memory.
    pub text: String,
    /// Relevance score in the range `[0.0, 1.0]`.  Stores that do not
    /// produce a score SHOULD return `1.0` for add results and `0.5` for
    /// list-only results so that score-based sorting remains meaningful.
    pub score: f32,
    /// The backend that produced this hit.  Set by each adapter.
    pub source: StoreKind,
    /// Namespace / user scope, if applicable.
    pub namespace: Option<String>,
}

/// A search query sent to one or more `MemoryStore` implementations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Query {
    /// Full-text or semantic search query string.
    pub text: String,
    /// Optional namespace filter (Mem0 `user_id`, KG entity type, …).
    pub namespace: Option<String>,
    /// Maximum number of results to return per store.
    pub limit: Option<u32>,
}

impl Query {
    /// Construct a `Query` with only the required text field set.
    ///
    /// # Examples
    ///
    /// ```
    /// # use control_center_lib::memory::Query;
    /// let q = Query::new("last session ultron");
    /// assert_eq!(q.text, "last session ultron");
    /// assert_eq!(q.limit, None);
    /// ```
    #[must_use]
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            namespace: None,
            limit: None,
        }
    }
}

/// Describes which backend produced a given `MemoryHit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoreKind {
    Mem0,
    Ecc,
    Kg,
    Mock,
    Sqlite,
    Qdrant,
}

pub mod model;
pub mod sqlite_store;
pub mod qdrant_store;
pub mod qdrant_index;
pub mod catalog;
pub mod service;
pub mod migrations;
// Fase D/E (Olas 5/7): cheap-brain LLM tasks, contradiction, reflection, evals.
pub mod ai_tasks;
pub mod contradiction;
pub mod reflection;
pub mod evals;
// OLA A (2026-06-04): write-path secret/PII detector. Built + tested in isolation;
// wiring into MemoryService::create_candidate is gated on confirmation.
pub mod redaction;
// OLA B (2026-06-04): stable text normalization + content hashing (dedupe/idempotency key).
pub mod texthash;

// Canonical memory kernel re-exports (Fase A).
pub use model::{
    Actor, CandidateAction, CandidateStatus, EventType, MemoryCandidate, MemoryEvent, MemoryItem,
    MemoryType, Scope, Sensitivity, Source, Stability, Status,
};
pub use service::{MemoryService, MemoryStats};
pub use migrations::MigrationReport;

/// Health status returned by `MemoryStore::health`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreHealth {
    pub healthy: bool,
    /// Human-readable description of the current state.
    pub message: String,
    /// Milliseconds taken to perform the health check, if applicable.
    pub latency_ms: Option<u64>,
}

/// Capability flags for a store — drives the UI and routing decisions in
/// `HybridRecall`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Capabilities {
    /// The store supports `add` (writes).
    pub writable: bool,
    /// The store supports semantic / vector search (not just substring).
    pub semantic_search: bool,
    /// The store persists data across process restarts.
    pub persistent: bool,
    /// Which kind of backend this describes.
    pub kind: StoreKind,
}

// ---------------------------------------------------------------------------
// MemoryStore trait
// ---------------------------------------------------------------------------

/// Unified interface for every memory backend.
///
/// Implementations MUST be `Send + Sync` so they can be stored in
/// `Arc<dyn MemoryStore>` and shared across Tokio tasks.
///
/// All methods are **synchronous** by design.  Async backends (Mem0 REST)
/// wrap their blocking calls with `reqwest::blocking` or `std::thread::block_on`
/// so the trait stays object-safe without `async_trait` overhead.
pub trait MemoryStore: Send + Sync {
    /// Write a new document to the store and return the stored record with
    /// its assigned `id` and `score = 1.0`.
    ///
    /// # Errors
    ///
    /// Returns [`MemoryError::Unsupported`] on read-only stores.
    /// Returns [`MemoryError::RemoteUnavailable`] when the backing service
    /// cannot be reached.
    fn add(&self, doc: MemoryDoc) -> Result<MemoryHit, MemoryError>;

    /// Search the store with `query` and return matching hits sorted by
    /// descending score.
    ///
    /// # Errors
    ///
    /// Returns [`MemoryError::RemoteUnavailable`] when the backing service
    /// is offline.
    fn search(&self, query: Query) -> Result<Vec<MemoryHit>, MemoryError>;

    /// Delete the document identified by `id`.
    ///
    /// # Errors
    ///
    /// Returns [`MemoryError::NotFound`] when no document with that id
    /// exists.  Returns [`MemoryError::Unsupported`] on read-only stores.
    fn delete(&self, id: &str) -> Result<(), MemoryError>;

    /// Perform a lightweight connectivity / sanity check and return the
    /// current health of the store.
    fn health(&self) -> Result<StoreHealth, MemoryError>;

    /// Return the static capability flags for this store.
    fn capabilities(&self) -> Capabilities;
}

// ---------------------------------------------------------------------------
// Mem0Store adapter
// ---------------------------------------------------------------------------

/// Synchronous adapter that wraps the async `crate::mem0::*_inner` functions
/// using `reqwest::blocking`.
///
/// Prefer using `Mem0Store` through the `MemoryStore` trait for new code.
/// The free functions `crate::mem0::search_inner`, `crate::mem0::add_inner`,
/// `crate::mem0::delete_inner`, and `crate::mem0::status_inner` still work
/// and are retained for backward compatibility.
pub struct Mem0Store {
    /// Optional default namespace (Mem0 `user_id`).
    default_namespace: Option<String>,
}

impl Mem0Store {
    /// Create a new `Mem0Store`.
    ///
    /// `default_namespace` maps to Mem0's `user_id` concept and is used when
    /// a `Query` or `MemoryDoc` does not supply its own namespace.
    #[must_use]
    pub fn new(default_namespace: Option<String>) -> Self {
        Self { default_namespace }
    }

    fn effective_namespace<'a>(&'a self, from_doc: Option<&'a str>) -> &'a str {
        from_doc
            .or(self.default_namespace.as_deref())
            .unwrap_or("global")
    }

    /// Run an async future to completion by spawning a blocking thread with
    /// its own `tauri::async_runtime` handle.
    ///
    /// Tauri embeds a Tokio runtime but does not expose `block_on` directly.
    /// We bridge by spawning a dedicated OS thread, running the future there
    /// via `tauri::async_runtime::block_on`, and collecting the result over a
    /// `std::sync::mpsc` channel.  This keeps the public `MemoryStore` trait
    /// synchronous (no `async_trait` overhead, object-safe) while still
    /// reaching async Mem0 functions.
    fn block_on<F, T>(fut: F) -> Result<T, MemoryError>
    where
        F: std::future::Future<Output = Result<T, String>> + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel::<Result<T, String>>();
        std::thread::spawn(move || {
            let result = tauri::async_runtime::block_on(fut);
            let _ = tx.send(result);
        });
        rx.recv()
            .map_err(|e| MemoryError::RemoteUnavailable(format!("thread recv: {e}")))?
            .map_err(MemoryError::RemoteUnavailable)
    }
}

impl MemoryStore for Mem0Store {
    fn add(&self, doc: MemoryDoc) -> Result<MemoryHit, MemoryError> {
        let ns = self.effective_namespace(doc.namespace.as_deref()).to_string();
        let text = doc.text.clone();
        let ns_clone = ns.clone();
        let mem = Self::block_on(async move {
            crate::mem0::add_inner(text, ns_clone, None).await
        })?;
        Ok(MemoryHit {
            id: mem.id.clone(),
            text: if mem.memory.is_empty() {
                doc.text
            } else {
                mem.memory
            },
            score: 1.0,
            source: StoreKind::Mem0,
            namespace: Some(ns),
        })
    }

    fn search(&self, query: Query) -> Result<Vec<MemoryHit>, MemoryError> {
        let ns = self
            .effective_namespace(query.namespace.as_deref())
            .to_string();
        let ns_clone = ns.clone();
        let text = query.text.clone();
        let limit = query.limit;
        let results = Self::block_on(async move {
            crate::mem0::search_inner(text, Some(ns_clone), limit).await
        })?;
        Ok(results
            .into_iter()
            .map(|m| MemoryHit {
                id: m.id.clone(),
                text: m.memory.clone(),
                // Mem0 does not surface a float score in the current API —
                // assign a fixed high score so results rank above KG hits by
                // default.
                score: 0.9,
                source: StoreKind::Mem0,
                namespace: Some(ns.clone()),
            })
            .collect())
    }

    fn delete(&self, id: &str) -> Result<(), MemoryError> {
        let id = id.to_string();
        Self::block_on(async move { crate::mem0::delete_inner(id).await })
    }

    fn health(&self) -> Result<StoreHealth, MemoryError> {
        let status =
            Self::block_on(async { crate::mem0::status_inner().await })?;
        Ok(StoreHealth {
            healthy: status.connected,
            message: status
                .error
                .unwrap_or_else(|| "Mem0 connected".to_string()),
            latency_ms: status.latency_ms,
        })
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            writable: true,
            semantic_search: true,
            persistent: true,
            kind: StoreKind::Mem0,
        }
    }
}

// ---------------------------------------------------------------------------
// EccStore adapter  (read-only)
// ---------------------------------------------------------------------------

/// Read-only adapter over the ECC plugin's JSONL knowledge graph.
///
/// Writes return [`MemoryError::Unsupported`].  Search is substring-based
/// (no embedding model).
pub struct EccStore;

impl EccStore {
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

impl Default for EccStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStore for EccStore {
    fn add(&self, _doc: MemoryDoc) -> Result<MemoryHit, MemoryError> {
        Err(MemoryError::Unsupported(
            "EccStore is read-only; the ECC JSONL is managed by the MCP server".to_string(),
        ))
    }

    fn search(&self, query: Query) -> Result<Vec<MemoryHit>, MemoryError> {
        let snap = crate::ecc_memory::ecc_memory_read().map_err(MemoryError::ParseError)?;
        let needle = query.text.to_lowercase();
        let limit = query.limit.unwrap_or(50) as usize;
        let hits: Vec<MemoryHit> = snap
            .entities
            .iter()
            .filter(|e| {
                e.name.to_lowercase().contains(&needle)
                    || e.entity_type.to_lowercase().contains(&needle)
                    || e.observations
                        .iter()
                        .any(|o| o.to_lowercase().contains(&needle))
            })
            .take(limit)
            .map(|e| {
                let text = if e.observations.is_empty() {
                    format!("[{}] {}", e.entity_type, e.name)
                } else {
                    format!("[{}] {}: {}", e.entity_type, e.name, e.observations.join("; "))
                };
                MemoryHit {
                    id: format!("ecc::{}", e.name),
                    text,
                    score: 0.6,
                    source: StoreKind::Ecc,
                    namespace: None,
                }
            })
            .collect();
        Ok(hits)
    }

    fn delete(&self, _id: &str) -> Result<(), MemoryError> {
        Err(MemoryError::Unsupported(
            "EccStore is read-only".to_string(),
        ))
    }

    fn health(&self) -> Result<StoreHealth, MemoryError> {
        let path = crate::ecc_memory::ecc_memory_path();
        Ok(StoreHealth {
            healthy: path.is_some(),
            message: match path {
                Some(p) => format!("ECC JSONL found at {}", p.display()),
                None => "ECC JSONL not found on disk".to_string(),
            },
            latency_ms: None,
        })
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            writable: false,
            semantic_search: false,
            persistent: true,
            kind: StoreKind::Ecc,
        }
    }
}

// ---------------------------------------------------------------------------
// KgStore adapter  (read + write)
// ---------------------------------------------------------------------------

/// Read-write adapter over the Control-Center-owned `kg.jsonl` knowledge
/// graph stored at `~/.ultron/cockpit/kg.jsonl`.
pub struct KgStore;

impl KgStore {
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

impl Default for KgStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStore for KgStore {
    fn add(&self, doc: MemoryDoc) -> Result<MemoryHit, MemoryError> {
        let name = doc
            .tags
            .iter()
            .find(|(k, _)| k == "name")
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| {
                // Use first 60 chars of text as entity name when no explicit
                // `name` tag is provided.
                doc.text
                    .chars()
                    .take(60)
                    .collect::<String>()
                    .trim()
                    .to_string()
            });
        let entity_type = doc
            .tags
            .iter()
            .find(|(k, _)| k == "type")
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| "memory".to_string());
        let entity = crate::kg::KgEntity {
            name: name.clone(),
            entity_type,
            observations: vec![doc.text.clone()],
        };
        crate::kg::create_entities_inner(vec![entity]).map_err(MemoryError::ParseError)?;
        Ok(MemoryHit {
            id: format!("kg::{name}"),
            text: doc.text,
            score: 1.0,
            source: StoreKind::Kg,
            namespace: None,
        })
    }

    fn search(&self, query: Query) -> Result<Vec<MemoryHit>, MemoryError> {
        let graph = crate::kg::search_nodes_inner(query.text.clone())
            .map_err(MemoryError::ParseError)?;
        let limit = query.limit.unwrap_or(50) as usize;
        let hits: Vec<MemoryHit> = graph
            .entities
            .iter()
            .take(limit)
            .map(|e| {
                let text = if e.observations.is_empty() {
                    format!("[{}] {}", e.entity_type, e.name)
                } else {
                    format!("[{}] {}: {}", e.entity_type, e.name, e.observations.join("; "))
                };
                MemoryHit {
                    id: format!("kg::{}", e.name),
                    text,
                    score: 0.7,
                    source: StoreKind::Kg,
                    namespace: None,
                }
            })
            .collect();
        Ok(hits)
    }

    fn delete(&self, id: &str) -> Result<(), MemoryError> {
        // Strip the "kg::" prefix that `add` inserts.
        let name = id.strip_prefix("kg::").unwrap_or(id).to_string();
        crate::kg::delete_entity_inner(name.clone())
            .map(|_| ())
            .map_err(|e| {
                if e.contains("not found") {
                    MemoryError::NotFound(name)
                } else {
                    MemoryError::ParseError(e)
                }
            })
    }

    fn health(&self) -> Result<StoreHealth, MemoryError> {
        match crate::kg::read_graph_inner() {
            Ok(g) => Ok(StoreHealth {
                healthy: true,
                message: format!(
                    "KG OK — {} entities, {} relations",
                    g.entities.len(),
                    g.relations.len()
                ),
                latency_ms: None,
            }),
            Err(e) => Ok(StoreHealth {
                healthy: false,
                message: format!("KG read error: {e}"),
                latency_ms: None,
            }),
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            writable: true,
            semantic_search: false,
            persistent: true,
            kind: StoreKind::Kg,
        }
    }
}

// ---------------------------------------------------------------------------
// HybridRecall orchestrator — feature-gated
// ---------------------------------------------------------------------------

/// Fan-out recall across multiple `MemoryStore` implementations.
///
/// # Examples
///
/// ```rust,ignore
/// use control_center_lib::memory::{HybridRecall, KgStore, Query};
///
/// let recall = HybridRecall::new(vec![Box::new(KgStore::new())]);
/// let hits = recall.search_all(Query::new("oauth refactor"));
/// println!("found {} hits", hits.len());
/// ```
pub struct HybridRecall {
    stores: Vec<Box<dyn MemoryStore>>,
}

impl HybridRecall {
    /// Create a new `HybridRecall` with the given list of stores.
    ///
    /// Stores are queried in order; results are merged, deduplicated by `id`,
    /// and sorted by descending `score`.
    #[must_use]
    pub fn new(stores: Vec<Box<dyn MemoryStore>>) -> Self {
        Self { stores }
    }

    /// Add an additional store to the orchestrator.
    pub fn push_store(&mut self, store: Box<dyn MemoryStore>) {
        self.stores.push(store);
    }

    /// Fan out `query` across all registered stores, merge hits, deduplicate
    /// by `id`, and return sorted by descending score.
    ///
    /// Errors from individual stores are silently swallowed; a store that is
    /// offline will contribute zero hits rather than failing the entire call.
    #[must_use]
    pub fn search_all(&self, query: Query) -> Vec<MemoryHit> {
        let mut seen_ids = std::collections::HashSet::new();
        let mut merged: Vec<MemoryHit> = Vec::new();

        for store in &self.stores {
            match store.search(query.clone()) {
                Ok(hits) => {
                    for hit in hits {
                        if seen_ids.insert(hit.id.clone()) {
                            merged.push(hit);
                        }
                    }
                }
                Err(e) => {
                    // Log but do not propagate — degraded multi-store recall
                    // is better than a hard failure.
                    eprintln!("[HybridRecall] store error (skipped): {e}");
                }
            }
        }

        // Sort descending by score, then alphabetically by id for stability.
        merged.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });

        merged
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // MockMemoryStore — minimal hand-written mock (no mockall dependency
    // needed for these deterministic contract tests).
    // ------------------------------------------------------------------

    struct MockMemoryStore {
        kind: StoreKind,
        hits: Vec<MemoryHit>,
        writable: bool,
        healthy: bool,
    }

    impl MockMemoryStore {
        fn readable(kind: StoreKind, hits: Vec<MemoryHit>) -> Self {
            Self {
                kind,
                hits,
                writable: false,
                healthy: true,
            }
        }

        fn writable_healthy(kind: StoreKind) -> Self {
            Self {
                kind,
                hits: Vec::new(),
                writable: true,
                healthy: true,
            }
        }

        fn unhealthy(kind: StoreKind) -> Self {
            Self {
                kind,
                hits: Vec::new(),
                writable: false,
                healthy: false,
            }
        }
    }

    impl MemoryStore for MockMemoryStore {
        fn add(&self, doc: MemoryDoc) -> Result<MemoryHit, MemoryError> {
            if self.writable {
                Ok(MemoryHit {
                    id: format!("mock::{}", doc.text.len()),
                    text: doc.text,
                    score: 1.0,
                    source: StoreKind::Mock,
                    namespace: None,
                })
            } else {
                Err(MemoryError::Unsupported("read-only mock".into()))
            }
        }

        fn search(&self, _query: Query) -> Result<Vec<MemoryHit>, MemoryError> {
            if self.healthy {
                Ok(self.hits.clone())
            } else {
                Err(MemoryError::RemoteUnavailable("mock offline".into()))
            }
        }

        fn delete(&self, id: &str) -> Result<(), MemoryError> {
            if self.writable {
                let _id = id;
                Ok(())
            } else {
                Err(MemoryError::Unsupported("read-only mock".into()))
            }
        }

        fn health(&self) -> Result<StoreHealth, MemoryError> {
            Ok(StoreHealth {
                healthy: self.healthy,
                message: if self.healthy {
                    "mock healthy".into()
                } else {
                    "mock offline".into()
                },
                latency_ms: Some(0),
            })
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities {
                writable: self.writable,
                semantic_search: false,
                persistent: false,
                kind: self.kind,
            }
        }
    }

    // ------------------------------------------------------------------
    // Contract tests: every MemoryStore impl must satisfy these invariants
    // ------------------------------------------------------------------

    fn make_hit(id: &str, score: f32, source: StoreKind) -> MemoryHit {
        MemoryHit {
            id: id.to_string(),
            text: format!("text for {id}"),
            score,
            source,
            namespace: None,
        }
    }

    #[test]
    fn read_only_store_add_returns_unsupported() {
        let store = MockMemoryStore::readable(StoreKind::Mock, vec![]);
        let result = store.add(MemoryDoc::from_text("test"));
        assert!(
            matches!(result, Err(MemoryError::Unsupported(_))),
            "read-only store must return Unsupported on add"
        );
    }

    #[test]
    fn read_only_store_delete_returns_unsupported() {
        let store = MockMemoryStore::readable(StoreKind::Mock, vec![]);
        let result = store.delete("any-id");
        assert!(
            matches!(result, Err(MemoryError::Unsupported(_))),
            "read-only store must return Unsupported on delete"
        );
    }

    #[test]
    fn writable_store_add_returns_hit_with_score_one() {
        let store = MockMemoryStore::writable_healthy(StoreKind::Mock);
        let hit = store
            .add(MemoryDoc::from_text("hello"))
            .expect("add should succeed");
        assert_eq!(hit.score, 1.0, "add result must carry score=1.0");
    }

    #[test]
    fn search_returns_hits_from_store() {
        let expected = vec![make_hit("id-1", 0.9, StoreKind::Mock)];
        let store = MockMemoryStore::readable(StoreKind::Mock, expected.clone());
        let hits = store.search(Query::new("anything")).expect("search ok");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "id-1");
    }

    #[test]
    fn health_check_reflects_store_state() {
        let healthy = MockMemoryStore::writable_healthy(StoreKind::Mock);
        let status = healthy.health().expect("health ok");
        assert!(status.healthy, "healthy store must report healthy=true");

        let dead = MockMemoryStore::unhealthy(StoreKind::Mock);
        let status = dead.health().expect("health call ok even for dead store");
        assert!(!status.healthy);
    }

    #[test]
    fn capabilities_writable_flag_matches_add_behaviour() {
        let ro = MockMemoryStore::readable(StoreKind::Mock, vec![]);
        assert!(!ro.capabilities().writable);
        let rw = MockMemoryStore::writable_healthy(StoreKind::Mock);
        assert!(rw.capabilities().writable);
    }

    #[test]
    fn memory_doc_from_text_sets_fields_correctly() {
        let doc = MemoryDoc::from_text("oauth session");
        assert_eq!(doc.text, "oauth session");
        assert!(doc.namespace.is_none());
        assert!(doc.tags.is_empty());
    }

    #[test]
    fn query_new_sets_text_and_leaves_optionals_none() {
        let q = Query::new("oauth session");
        assert_eq!(q.text, "oauth session");
        assert!(q.namespace.is_none());
        assert!(q.limit.is_none());
    }

    // ------------------------------------------------------------------
    // HybridRecall tests
    // ------------------------------------------------------------------

    mod hybrid {
        use super::*;

        #[test]
        fn search_all_merges_and_deduplicates_hits() {
            // Two stores that both return the same id — only one copy should
            // appear in the output.
            let hits_a = vec![
                make_hit("shared-id", 0.8, StoreKind::Mock),
                make_hit("only-a", 0.7, StoreKind::Mock),
            ];
            let hits_b = vec![
                make_hit("shared-id", 0.6, StoreKind::Mock),
                make_hit("only-b", 0.5, StoreKind::Mock),
            ];
            let recall = HybridRecall::new(vec![
                Box::new(MockMemoryStore::readable(StoreKind::Mock, hits_a)),
                Box::new(MockMemoryStore::readable(StoreKind::Mock, hits_b)),
            ]);
            let merged = recall.search_all(Query::new("test"));
            // shared-id appears once, only-a and only-b each appear once → 3
            assert_eq!(merged.len(), 3, "dedup should leave 3 unique hits");
            assert_eq!(merged[0].id, "shared-id", "highest score first");
        }

        #[test]
        fn search_all_sorts_descending_by_score() {
            let hits = vec![
                make_hit("low", 0.3, StoreKind::Mock),
                make_hit("high", 0.9, StoreKind::Mock),
                make_hit("mid", 0.6, StoreKind::Mock),
            ];
            let recall = HybridRecall::new(vec![Box::new(MockMemoryStore::readable(
                StoreKind::Mock,
                hits,
            ))]);
            let merged = recall.search_all(Query::new("test"));
            assert_eq!(merged[0].id, "high");
            assert_eq!(merged[1].id, "mid");
            assert_eq!(merged[2].id, "low");
        }

        #[test]
        fn search_all_swallows_errors_from_offline_stores() {
            let good_hits = vec![make_hit("good", 0.8, StoreKind::Mock)];
            let recall = HybridRecall::new(vec![
                Box::new(MockMemoryStore::unhealthy(StoreKind::Mock)),
                Box::new(MockMemoryStore::readable(StoreKind::Mock, good_hits)),
            ]);
            let merged = recall.search_all(Query::new("test"));
            // Offline store contributes 0 hits but does not fail the call.
            assert_eq!(merged.len(), 1);
            assert_eq!(merged[0].id, "good");
        }

        #[test]
        fn empty_stores_list_returns_empty_vec() {
            let recall = HybridRecall::new(vec![]);
            let merged = recall.search_all(Query::new("anything"));
            assert!(merged.is_empty());
        }
    }
}
