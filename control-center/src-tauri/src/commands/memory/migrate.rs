// commands/memory/migrate.rs — one-shot canonical-memory ETL command (Fase A3)

/// Run the canonical-memory migration: imports the live substrates
/// (Qdrant `ultron_sessions` + kg.jsonl + decisions.jsonl + ~/.ultron-vault
/// distilled tuples) into `brain.db` (`memory_items` / `memory_candidates`).
///
/// Idempotent (per-point for sessions, per-source for the rest) and backs up
/// `brain.db` before running. Returns the `MigrationReport` as JSON.
#[tauri::command]
pub async fn memory_migrate() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let report = crate::memory::migrations::run_full_etl();
        serde_json::to_value(report).map_err(|e| format!("serialize report: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}
