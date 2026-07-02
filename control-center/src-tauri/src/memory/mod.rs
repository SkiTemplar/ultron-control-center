// ULTRON Control Center — MemoryStore trait (KIRKARDO 21 design doc 9/10)
//
// Introduces a unified abstraction over the active memory backends:
//   - KgStore     : local kg.jsonl        (read + write)
//
// Plus a `HybridRecall` orchestrator that fans out a query across all
// registered stores, merges results, deduplicates by id, and returns them
// sorted by descending relevance score.

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

    /// Write-path dedupe (2026-07-02): contenido exactamente identico ya cubierto
    /// por un item ACTIVO o un candidato PENDING (mismo scope+proyecto). El valor
    /// es el id existente — los callers pueden tratarlo como no-op idempotente.
    #[error("duplicate content: already covered by {0}")]
    Duplicate(String),

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
    /// Optional namespace / user scope.
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
    /// Optional namespace filter (KG entity type, scope, …).
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
    Ecc,
    Kg,
    Mock,
    Sqlite,
    Qdrant,
}

// Auto-approve policy: persisted `auto_approve` setting + the "clean candidate"
// security safeguard (never auto-approves secrets / contradictions).
pub mod auto_approve;
pub mod capture;
pub mod catalog;
pub mod doctor;
pub mod migrations;
pub mod model;
pub mod qdrant_index;
pub mod qdrant_store;
pub mod schema_v3;
// Schema v5 (2026-07-02): RETIRADA del codegraph interno (drop edges +
// unresolved_refs, user_version 4->5). El módulo conserva el nombre histórico.
pub mod schema_v4;
pub mod service;
pub mod sqlite_store;
// Fase D/E (Olas 5/7): cheap-brain LLM tasks, contradiction, evals.
pub mod ai_tasks;
pub mod contradiction;
pub mod evals;
// OLA C: pure ranking-quality metrics (precision@k/recall@k/MRR/nDCG/context-waste)
// for the golden set. No I/O — unit-testable without Qdrant. See evals.rs for the loader.
pub mod eval_metrics;
// OLA A (2026-06-04): write-path secret/PII detector. Built + tested in isolation;
// wiring into MemoryService::create_candidate is gated on confirmation.
pub mod redaction;
// OLA B (2026-06-04): stable text normalization + content hashing (dedupe/idempotency key).
pub mod texthash;

// Canonical memory kernel re-exports (Fase A).
pub use migrations::MigrationReport;
pub use model::{
    Actor, CandidateAction, CandidateStatus, EventType, MemoryCandidate, MemoryEvent, MemoryItem,
    MemoryType, Scope, Sensitivity, Source, Stability, Status,
};
pub use service::{BackfillDeprecationsResult, BulkDeprecateResult, MemoryService, MemoryStats};

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
/// All methods are **synchronous** by design so the trait stays object-safe
/// without `async_trait` overhead.
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
        let graph =
            crate::kg::search_nodes_inner(query.text.clone()).map_err(MemoryError::ParseError)?;
        let limit = query.limit.unwrap_or(50) as usize;
        let hits: Vec<MemoryHit> = graph
            .entities
            .iter()
            .take(limit)
            .map(|e| {
                let text = if e.observations.is_empty() {
                    format!("[{}] {}", e.entity_type, e.name)
                } else {
                    format!(
                        "[{}] {}: {}",
                        e.entity_type,
                        e.name,
                        e.observations.join("; ")
                    )
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
