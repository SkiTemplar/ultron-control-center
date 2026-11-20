// recall_unified/types_model.rs — public types + RRF scoring.

use serde::Serialize;

/// Standard RRF damping constant.
pub(super) const RRF_K: f32 = 60.0;
/// Top-K FTS candidates per recall before widening (see `SPARSE_WIDEN_FACTOR`).
pub(super) const FANOUT_K: usize = 30;
/// Ensanche del pool sparse: se piden `FANOUT_K * SPARSE_WIDEN_FACTOR`
/// candidatos BM25 para que, bajo un filtro de proyecto, los items del
/// proyecto lleguen a los gates de `assemble_pack` aunque el vault global y
/// otros proyectos dominen el top-30.
pub(super) const SPARSE_WIDEN_FACTOR: usize = 12;

/// Relevance floor (Pilar #1 — "trae lo correcto y POCO"). A hit whose sparse
/// (BM25) rank is at or beyond this cutoff is lexical TAIL noise: it shares a
/// stray term with the query. The sparse fanout is widened
/// (`SPARSE_WIDEN_FACTOR`) to push in-project items PAST the governance gates;
/// this floor stops that same widening from injecting the BM25 tail (the
/// "Mundial 2026 / menú de 5 decisiones" class of irrelevant hits).
///
/// 15 -> 3 (2026-09-07, decidido por el usuario tras medir): con el cutoff en
/// 15 el 52 % de lo inyectado en 40 prompts reales eran hits de cola léxica.
/// Solo pasan los 3 primeros de BM25 (coincidencia léxica fuerte). Un pack más
/// corto es el objetivo, no un efecto secundario.
pub(super) const SPARSE_TAIL_CUTOFF: usize = 3;

/// Down-rank de items AMBIENTE (project_id=NULL) bajo filtro de proyecto
/// (2026-07-13). La regla ambiente (pack.rs) mantiene el corpus NULL VISIBLE en
/// todos los proyectos, pero 3567/~4400 items son legado sin estampar y muchos
/// pertenecen de facto a UN proyecto: sin contrapeso llenan el pack de sesiones
/// ajenas (terreno procedural en Tortunabo). Multiplicador del rrf_score, NO un
/// filtro: con memorias locales compitiendo, las del proyecto ganan; sin señal
/// local, el corpus NULL sigue emergiendo. Tuneable via ULTRON_AMBIENT_PENALTY.
pub(super) const AMBIENT_PENALTY: f32 = 0.5;

/// Maximum token budget for the assembled pack **per recall call** — an
/// anti-bloat ceiling for a SINGLE injection. This is NOT a cumulative
/// per-session budget: every recall receives the full cap, so the memory is
/// never silenced mid-session (the old per-session accumulator starved every
/// query after the first few). The item-count cap (the caller's `limit`, 8 in the hot path) is the
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
    /// Tipo del item (`decision`, `lesson`, ...). Lo consume el orquestador para
    /// separar las lecciones cross-project del resto (ULTRON 4 F1.3).
    #[serde(default)]
    pub kind: String,
    pub score: f32, // RRF score after the quality factors
    pub sparse_rank: Option<usize>,
    pub reason: String, // "why this memory" — e.g. "sparse#2"
    pub token_estimate: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecallPack {
    pub entries: Vec<RecallEntry>,
    pub total_tokens: i64,
    pub sparse_hits: usize,
    /// true si el trust gate vació el pack: la query traía términos que el
    /// corpus no conoce. Distingue "no hay nada que inyectar" de "no encontré
    /// nada" para los consumidores del CLI.
    pub abstained: bool,
}

/// One scored candidate with its BM25 rank (Retrieval Inspector).
#[derive(Debug, Clone, Serialize)]
pub struct FusedHit {
    pub canonical_id: String,
    pub rrf_score: f32,
    pub sparse_rank: Option<usize>,
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
    pub sparse_ids: Vec<String>, // FTS5 order
    pub fused: Vec<FusedHit>,    // after RRF scoring + quality factors
    pub injected: Vec<RecallEntry>,
    pub discarded: Vec<DiscardedHit>,
    pub total_tokens: i64,
    pub lazy_load_ids: Vec<String>, // canonical_ids whose full content can be loaded on demand
    pub warnings: Vec<String>,
}

/// Reciprocal Rank Fusion. Each list is canonical_ids ordered best-first.
/// `score(d) = Σ_sources 1 / (k + rank + 1)`. Returns `(id, score)` desc, with
/// a stable tie-break by id. El recall la usa con una sola lista (la de BM25).
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
