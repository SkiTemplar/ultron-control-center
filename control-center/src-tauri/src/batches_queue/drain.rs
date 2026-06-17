// batches_queue/drain.rs — drain the Stop-hook pending file into queue.jsonl
// (same rename→snapshot→dedup→atomic-rewrite discipline as decisions.rs).

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

use crate::batches_queue::persistence::{
    clip_error, dedup_key, new_queue_id, now_iso, queue_lock, queue_path, read_all, write_atomic,
};
use crate::batches_queue::types::{BatchKind, BatchQueueEntry, BatchQueueReason};

// ---------------------------------------------------------------------------
// Pending-file type
// ---------------------------------------------------------------------------

/// One raw line the Node Stop hook appends to `queue-pending.jsonl`. Lenient:
/// every field optional except `name`/`command`-ish, defaults filled in.
#[derive(Debug, Deserialize)]
pub(super) struct PendingQueueLine {
    #[serde(default)]
    pub(super) name: Option<String>,
    #[serde(default)]
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) reason: Option<String>,
    #[serde(default)]
    pub(super) kind: Option<String>,
    #[serde(default)]
    pub(super) description: Option<String>,
    #[serde(default)]
    pub(super) last_error: Option<String>,
}

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/// `~/.ultron/batches/queue-pending.jsonl` — append-only producer file the
/// Node hook writes without holding our lock.
pub fn pending_queue_path() -> Result<PathBuf, String> {
    let dir = crate::batches::batches_dir()?;
    Ok(dir.join("queue-pending.jsonl"))
}

// ---------------------------------------------------------------------------
// Pure parse (no I/O) — unit-testable
// ---------------------------------------------------------------------------

/// Parse pending lines into entries, deduped against `existing_keys` AND
/// within the batch. PURE (no I/O) so it is unit-testable.
pub(super) fn parse_pending_lines(
    text: &str,
    existing_keys: &HashSet<String>,
) -> Vec<BatchQueueEntry> {
    let mut seen = existing_keys.clone();
    let mut added: Vec<BatchQueueEntry> = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(p) = serde_json::from_str::<PendingQueueLine>(trimmed) else {
            continue;
        };
        let name = match p.name {
            Some(n) if !n.trim().is_empty() => n.trim().to_string(),
            _ => continue, // a queue entry without a script name is useless
        };
        let reason = BatchQueueReason::parse_lenient(p.reason.as_deref().unwrap_or("failed"));
        let key = dedup_key(&name, reason);
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);

        let kind = BatchKind::parse_lenient(p.kind.as_deref().unwrap_or("auto"));
        added.push(BatchQueueEntry {
            id: new_queue_id(),
            name: name.clone(),
            path: p.path.unwrap_or_default(),
            reason,
            kind,
            description: p.description,
            created_at: now_iso(),
            last_error: p.last_error.and_then(|e| clip_error(&e)),
            attempts: 1,
        });
    }

    added
}

// ---------------------------------------------------------------------------
// Public drain
// ---------------------------------------------------------------------------

/// Drain `queue-pending.jsonl` into `queue.jsonl`. Same rename→snapshot→
/// dedup→atomic-rewrite discipline as `decisions::drain_pending_inner`.
/// Returns the entries newly added (deduped against what was already queued).
pub fn drain_pending_inner() -> Result<Vec<BatchQueueEntry>, String> {
    let ppath = pending_queue_path()?;
    let _g = queue_lock()
        .lock()
        .map_err(|_| "batches queue lock poisoned")?;

    let draining = ppath.with_extension("draining");
    match fs::rename(&ppath, &draining) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // No pending file. Recover an orphaned `.draining` if a previous
            // drain crashed between rename and remove; otherwise nothing to do.
            if !draining.exists() {
                return Ok(Vec::new());
            }
        }
        Err(e) => return Err(format!("rename pending {}: {e}", ppath.display())),
    }

    let text = fs::read_to_string(&draining)
        .map_err(|e| format!("read draining {}: {e}", draining.display()))?;

    let mut entries = read_all()?;
    let existing: HashSet<String> = entries
        .iter()
        .map(|e| dedup_key(&e.name, e.reason))
        .collect();

    let added = parse_pending_lines(&text, &existing);

    if !added.is_empty() {
        entries.extend(added.iter().cloned());
        let path = queue_path()?;
        write_atomic(&path, &entries)?;
    }
    // Consume the snapshot even when everything was a duplicate.
    fs::remove_file(&draining).ok();

    Ok(added)
}
