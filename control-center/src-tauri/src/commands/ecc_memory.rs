// Control Center 2.3 — Tauri command wrappers for the ECC graph reader.

use crate::ecc_memory::{
    bootstrap_ecc_memory_inner, ecc_memory_read as inner_read, EccMemorySnapshot,
};

#[tauri::command]
pub fn ecc_memory_read() -> Result<EccMemorySnapshot, String> {
    // Synchronous file read. The ECC memory JSON is small (typically
    // <100KB) so blocking the Tauri runtime is fine; if it ever grows
    // large enough to need spawn_blocking, add `tokio` as a direct dep
    // and re-async this wrapper.
    inner_read()
}

/// v2.6.2 — create `~/.claude/memory.jsonl` with a seed entity so the
/// Memory tab can stop showing the "not detected" state. Idempotent.
#[tauri::command]
pub fn bootstrap_ecc_memory() -> Result<String, String> {
    bootstrap_ecc_memory_inner()
}
