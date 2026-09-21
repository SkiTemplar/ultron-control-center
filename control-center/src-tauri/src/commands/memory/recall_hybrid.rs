// ULTRON Control Center — memory_health command (MEMORY CORE D5)
//
// recall_hybrid (deprecated wrapper) was removed 2026-06-28 — it had no live
// callers (verified 2026-06-06) and only re-delegated to
// recall_unified::recall_pack, which is the canonical recall path. Call that
// directly.
//
// memory_health: per-store health check + embeddings_real flag.


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
