// commands/memory/recall_unified/mod.rs — unified hybrid recall (MEMORY KERNEL Fase B)
//
// The single `recall` command. Fuses TWO sources with Reciprocal Rank Fusion:
//   - DENSE:  MultilingualE5Large vectors in Qdrant `ultron_memory`
//   - SPARSE: FTS5/bm25 over `memory_items` (brain.db), ACTIVE only
// Both sources filter to status=active; the result is a compact context pack of
// summaries (not full content) under a per-call token cap. Degrades to
// sparse-only when E5/Qdrant is unavailable.
//
// Replaces the old `recall_hybrid` (constant-score union, no RRF) and the
// retired `recall_semantic` (legacy 384-d path, removed 2026-06-28).
//
// Sin comandos Tauri desde el 2026-10-18: `recall_inspect` y `memory_reindex`
// solo los usaba la pestaña Memory (retirada). La traza y el reindexado siguen
// disponibles por el sidecar `ultron-memory.exe` (subcomandos recall/reindex).

pub(crate) mod engine;
pub mod hubs;
pub(crate) mod pack;
#[cfg(test)]
mod tests;
pub(crate) mod types_model;
pub(crate) mod usage;

pub use engine::{build_trace, build_trace_typed, recall_pack};
pub use types_model::{rrf_fuse, rrf_fuse_weighted};
pub use types_model::{
    DiscardedHit, FusedHit, RecallEntry, RecallPack, RecallTrace, PER_CALL_TOKEN_CAP,
};
pub use usage::{build_trace_diagnostic, recall_pack_diagnostic, RecallUse};
