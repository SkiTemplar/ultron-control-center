// commands/memory/recall_unified/mod.rs — recall unificado (MEMORY KERNEL Fase B)
//
// The single `recall` path: FTS5/bm25 over `memory_items` (brain.db), ACTIVE
// only, scored with RRF + quality factors and filtered by the governance gates;
// the result is a compact context pack of summaries (not full content) under a
// per-call token cap. La fuente densa (vectores E5 en un índice vectorial) se
// retiró el 2026-11-14; estaba apagada desde el 2026-09-28.
//
// Sin comandos Tauri desde el 2026-10-18: `recall_inspect` solo lo usaba la
// pestaña Memory (retirada). La traza sigue disponible por el sidecar
// `ultron-memory.exe` (subcomandos recall/trace).

pub(crate) mod engine;
pub mod hubs;
pub(crate) mod pack;
#[cfg(test)]
mod tests;
pub(crate) mod types_model;
pub(crate) mod usage;

pub use engine::{build_trace, build_trace_typed, recall_pack};
pub use types_model::rrf_fuse;
pub use types_model::{
    DiscardedHit, FusedHit, RecallEntry, RecallPack, RecallTrace, PER_CALL_TOKEN_CAP,
};
pub use usage::{build_trace_diagnostic, recall_pack_diagnostic, RecallUse};
