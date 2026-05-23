// Control Center 2.3 — Tauri command wrappers for the ECC graph reader.

use crate::ecc_memory::{ecc_memory_read as inner_read, EccMemorySnapshot};

#[tauri::command]
pub fn ecc_memory_read() -> Result<EccMemorySnapshot, String> {
    // Synchronous file read. The ECC memory JSON is small (typically
    // <100KB) so blocking the Tauri runtime is fine; if it ever grows
    // large enough to need spawn_blocking, add `tokio` as a direct dep
    // and re-async this wrapper.
    inner_read()
}
