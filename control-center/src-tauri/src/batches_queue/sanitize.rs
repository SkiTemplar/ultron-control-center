// batches_queue/sanitize.rs — enqueue-manual public inner API.
//
// Higiene 2026-08-12 (audit 08-09 #41, decidido por el usuario): fuera
// sanitize_ps1_ascii + safe_script_name + enqueue_command_inner — solo
// servian al comando batches_enqueue_command, nunca expuesto en la UI.
// Git los conserva si la via de encolar comandos ad-hoc vuelve.

use crate::batches_queue::persistence::{
    queue_lock, queue_path, read_all, upsert_full, write_atomic,
};
use crate::batches_queue::types::{BatchKind, BatchQueueEntry, BatchQueueReason};

/// Enqueue a **manual** action — one that the AI cannot perform automatically
/// (e.g. "rebuild the app", "rotate the GitHub token", "log in to X"). No
/// script is written to disk; this is purely a reminder in the Run Batch UI.
///
/// `name`        — short identifier for the action (used as the entry title).
/// `description` — human-readable instructions for the user.
/// `reason`      — parsed leniently; usually "ai_cannot_execute".
///
/// Returns the created (or bumped) queue entry.
/// The `batches_enqueue_manual` Tauri command was removed in cat10 (2026-06-19).
#[allow(dead_code)]
pub fn enqueue_manual_inner(
    name: &str,
    description: &str,
    reason: &str,
) -> Result<BatchQueueEntry, String> {
    let _g = queue_lock()
        .lock()
        .map_err(|_| "batches queue lock poisoned")?;

    let mut entries = read_all()?;
    let entry = upsert_full(
        &mut entries,
        name.trim(),
        "", // no script path — manual action
        BatchQueueReason::parse_lenient(reason),
        BatchKind::Manual,
        if description.trim().is_empty() {
            None
        } else {
            Some(description.trim().to_string())
        },
        None,
    );
    let path_buf = queue_path()?;
    write_atomic(&path_buf, &entries)?;
    Ok(entry)
}
