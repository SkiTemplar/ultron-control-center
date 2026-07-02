// recall_unified/types_model.rs — public types + RRF fusion.

use serde::Serialize;

/// Standard RRF damping constant.
pub(super) const RRF_K: f32 = 60.0;
/// Final entries returned per call.
pub(super) const DEFAULT_LIMIT: usize = 8;
/// Top-K pulled from each source before fusion.
pub(super) const FANOUT_K: usize = 30;

/// Relevance floor (Pilar #1 — "trae lo correcto y POCO"). A fused hit with NO
/// dense (semantic) backing whose sparse (BM25) rank is at or beyond this cutoff
/// is lexical TAIL noise: it shares a stray term with the query but E5 did not
/// rank it relevant at all. The sparse fanout is widened (×12 when dense is off)
/// to push in-project items PAST the governance gates — this floor stops that
/// same widening from injecting the BM25 tail (the "Mundial 2026 / menú de 5
/// decisiones" class of irrelevant hits). dense-backed hits (any dense rank) and
/// sparse-TOP hits (rank < cutoff) always pass. Calibrated against the golden
/// eval: must not drop recall@8 (baseline 0.868) while cutting context_waste.
pub(super) const SPARSE_TAIL_CUTOFF: usize = 15;

/// Maximum token budget for the assembled pack **per recall call** — an
/// anti-bloat ceiling for a SINGLE injection. This is NOT a cumulative
/// per-session budget: every recall receives the full cap, so the memory is
/// never silenced mid-session (the old per-session accumulator starved every
/// query after the first few). The item-count cap (`DEFAULT_LIMIT`) is the
/// primary bloat control; this token cap only bounds an oversized single item.
pub const PER_CALL_TOKEN_CAP: i64 = 1500;

/// (cat1, 2026-07-02) Clamp de tokens POR ENTRADA del pack: cada item aporta
/// como mucho esto (su summary inyectado se trunca; el contenido completo
/// sigue lazy-loadable por id). Sin clamp, los resúmenes de subagente (~565
/// tokens) comían el cap de 1500 y desalojaban relevantes mejor rankeados
/// (trace del golden set: un expect_id en fused#3 fuera por "token budget").
/// Con 180 y limit=8: 8×180=1440 ≤ 1500 — los 8 slots caben SIEMPRE.
pub const ENTRY_TOKEN_CLAMP: i64 = 180;

#[derive(Debug, Clone, Serialize)]
pub struct RecallEntry {
    pub canonical_id: String,
    pub title: Option<String>,
    pub summary: Option<String>, // compact form injected; full content is lazy-loaded
    pub scope: String,
    pub project_id: Option<String>,
    pub score: f32, // RRF fused score
    pub dense_rank: Option<usize>,
    pub sparse_rank: Option<usize>,
    pub dense_score: Option<f32>, // raw E5 cosine similarity (B1: tie-break / quality signal)
    pub reason: String,           // "why this memory" — e.g. "dense#2 + sparse#5"
    pub token_estimate: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecallPack {
    pub entries: Vec<RecallEntry>,
    pub total_tokens: i64,
    pub dense_hits: usize,
    pub sparse_hits: usize,
    /// (floor) true si el gate de abstención vació el pack: la query no tenía
    /// ninguna entrada con señal de confianza. Distingue "no hay nada que
    /// inyectar" de "no encontré nada" para los consumidores del CLI.
    pub abstained: bool,
}

/// One fused candidate with its per-source ranks (Retrieval Inspector).
#[derive(Debug, Clone, Serialize)]
pub struct FusedHit {
    pub canonical_id: String,
    pub rrf_score: f32,
    pub dense_rank: Option<usize>,
    pub sparse_rank: Option<usize>,
    pub dense_score: Option<f32>, // raw E5 cosine similarity (B1)
}

/// A candidate that was retrieved but NOT injected, with the reason why.
#[derive(Debug, Clone, Serialize)]
pub struct DiscardedHit {
    pub canonical_id: String,
    pub reason: String,
}

/// Full per-turn retrieval trace — the Retrieval Inspector / "why this memory?".
#[derive(Debug, Clone, Serialize)]
pub struct RecallTrace {
    pub query: String,
    pub project_filter: Option<String>,
    /// Per-call token cap applied by `assemble_pack` (`PER_CALL_TOKEN_CAP`).
    pub token_budget: i64,
    pub dense_ids: Vec<String>,  // E5/Qdrant order
    pub sparse_ids: Vec<String>, // FTS5 order
    pub fused: Vec<FusedHit>,    // after RRF
    pub injected: Vec<RecallEntry>,
    pub discarded: Vec<DiscardedHit>,
    pub total_tokens: i64,
    pub lazy_load_ids: Vec<String>, // canonical_ids whose full content can be loaded on demand
    pub warnings: Vec<String>,
}

/// Reciprocal Rank Fusion. Each list is canonical_ids ordered best-first.
/// `score(d) = Σ_sources 1 / (k + rank + 1)`. Returns `(id, score)` desc.
/// (cat1 ranking, 2026-07-02) RRF PONDERADO: cada lista aporta
/// `peso / (k + rank + 1)`. Con pesos 1.0 es idéntico a `rrf_fuse`. Permite
/// pesar dense (E5, la señal de calidad) sobre sparse (BM25, ruidoso con
/// stopwords) — knob `ULTRON_DENSE_W` en el engine, default 1.0.
pub fn rrf_fuse_weighted(lists: &[(Vec<String>, f32)], k: f32) -> Vec<(String, f32)> {
    use std::collections::HashMap;
    let mut scores: HashMap<String, f32> = HashMap::new();
    for (list, weight) in lists {
        for (rank, id) in list.iter().enumerate() {
            *scores.entry(id.clone()).or_insert(0.0) += weight / (k + rank as f32 + 1.0);
        }
    }
    let mut out: Vec<(String, f32)> = scores.into_iter().collect();
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

pub fn rrf_fuse(lists: &[Vec<String>], k: f32) -> Vec<(String, f32)> {
    use std::collections::HashMap;
    let mut scores: HashMap<String, f32> = HashMap::new();
    for list in lists {
        for (rank, id) in list.iter().enumerate() {
            *scores.entry(id.clone()).or_insert(0.0) += 1.0 / (k + rank as f32 + 1.0);
        }
    }
    let mut fused: Vec<(String, f32)> = scores.into_iter().collect();
    fused.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0)) // stable tie-break by id
    });
    fused
}
