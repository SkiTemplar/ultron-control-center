// ULTRON Control Center - Batches commands
use crate::batches::{self, BatchCleanupReport, BatchEntry, BatchRunResult};
use crate::batches_queue::{self, BatchQueueEntry};

#[tauri::command]
pub async fn list_batches() -> Result<Vec<BatchEntry>, String> {
    tauri::async_runtime::spawn_blocking(batches::list_batches_inner)
        .await
        .map_err(|e| e.to_string())?
}

/// Execute a batch script by name.
///
/// The execution is bounded by a **5-minute timeout**. If the script has not
/// exited within that window (e.g. an infinite PowerShell loop, a blocking
/// `Read-Host`, or a hung child process) the future is cancelled, an error is
/// returned to the UI, and the failure is recorded in the batch queue so it is
/// never silently dropped.
#[tauri::command]
pub async fn execute_batch(name: String) -> Result<BatchRunResult, String> {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

    let task = tauri::async_runtime::spawn_blocking({
        let name = name.clone();
        move || batches::execute_batch_inner(name)
    });

    match tokio::time::timeout(TIMEOUT, task).await {
        Ok(join_result) => join_result.map_err(|e| e.to_string())?,
        Err(_elapsed) => {
            // The blocking thread is detached (spawn_blocking cannot be
            // cancelled), but from the UI perspective the command timed out.
            // Record the failure in the queue so it is never silently lost.
            let msg = "batch execution timed out after 5 minutes".to_string();
            let path_hint = {
                let dir = batches::batches_dir().unwrap_or_default();
                dir.join(&name).to_string_lossy().to_string()
            };
            if let Err(qe) = crate::batches_queue::record_inner(
                &name,
                &path_hint,
                crate::batches_queue::BatchQueueReason::Failed,
                Some(msg.clone()),
            ) {
                eprintln!("[batches] CRITICAL: could not enqueue timed-out batch '{name}': {qe}");
            }
            Err(msg)
        }
    }
}

/// Delete a single batch script by name (user-initiated, no age filter).
/// The name must be a bare filename — path separators and `..` are rejected.
#[tauri::command]
pub async fn delete_batch_single(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || batches::delete_batch_single_inner(name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cleanup_old_batches(older_than_days: u32) -> Result<BatchCleanupReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        batches::cleanup_old_batches_inner(older_than_days)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete ALL batch scripts (user-initiated "Clear all", with confirmation in
/// the UI). card-bug-runbatch-clear.
#[tauri::command]
pub async fn clear_all_batches() -> Result<BatchCleanupReport, String> {
    tauri::async_runtime::spawn_blocking(batches::clear_all_batches_inner)
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Run Batch queue (persistent "rejected / ai_cannot_execute / failed" capture)
// ---------------------------------------------------------------------------

/// List every queued batch (rejected by a sandbox/permission prompt, unrunnable
/// by the AI, or failed at runtime). Drains the Stop-hook pending file first so
/// the UI always reflects the latest captures. Newest first.
#[tauri::command]
pub async fn batches_list_queue() -> Result<Vec<BatchQueueEntry>, String> {
    tauri::async_runtime::spawn_blocking(batches_queue::list_inner)
        .await
        .map_err(|e| e.to_string())?
}

/// Re-queue an entry by id: bumps attempts + refreshes its timestamp so it
/// surfaces as "pending retry". Does NOT auto-run — the actual run is still a
/// human click via `execute_batch` (security: a rejected command must never
/// become 1-click-auto-runnable).
#[tauri::command]
pub async fn batches_requeue(id: String) -> Result<BatchQueueEntry, String> {
    tauri::async_runtime::spawn_blocking(move || batches_queue::requeue_inner(&id))
        .await
        .map_err(|e| e.to_string())?
}

/// Remove an entry from the queue by id (user dismiss, or after a successful
/// manual run).
#[tauri::command]
pub async fn batches_dismiss_queue(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || batches_queue::dismiss_inner(&id))
        .await
        .map_err(|e| e.to_string())?
}

/// Write an ASCII-pure `.ps1` (PS 5.1 safe — no non-ASCII) into
/// `~/.ultron/batches/` AND append a queue entry pointing at it. This is how the
/// AI / UI "leaves a command in Run Batch" when it cannot run it directly.
/// `reason` is parsed leniently ("rejected" | "ai_cannot_execute" | anything →
/// "failed").
#[tauri::command]
pub async fn batches_enqueue_command(
    name: String,
    content: String,
    reason: String,
) -> Result<BatchQueueEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        batches_queue::enqueue_command_inner(&name, &content, &reason)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Enqueue a **manual** action that the AI cannot execute automatically.
/// No script is written to disk — this is purely a reminder card in Run Batch
/// UI rendered with `kind = "manual"` and no Run button.
///
/// `name`        — short label shown in the UI (e.g. "Rotar GitHub Token").
/// `description` — step-by-step instructions for the user.
/// `reason`      — parsed leniently; "ai_cannot_execute" is the typical value.
///
/// **How the AI leaves a manual reminder:**
/// ```
/// invoke("batches_enqueue_manual", {
///   name: "Rebuild app",
///   description: "Run `npm run build:app` from control-center/ after closing the app.",
///   reason: "ai_cannot_execute",
/// })
/// ```
#[tauri::command]
pub async fn batches_enqueue_manual(
    name: String,
    description: String,
    reason: String,
) -> Result<BatchQueueEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        batches_queue::enqueue_manual_inner(&name, &description, &reason)
    })
    .await
    .map_err(|e| e.to_string())?
}
