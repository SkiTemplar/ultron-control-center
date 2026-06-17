// batches_queue/persistence.rs — process-wide lock, disk I/O, dedup, upsert,
// and the public inner CRUD API for the persistent batches queue.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use super::types::{BatchKind, BatchQueueEntry, BatchQueueReason};

// ---------------------------------------------------------------------------
// Process-wide write lock
// ---------------------------------------------------------------------------

static QUEUE_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn queue_lock() -> &'static Mutex<()> {
    QUEUE_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

// ---------------------------------------------------------------------------
// Path + id helpers
// ---------------------------------------------------------------------------

/// `~/.ultron/batches/queue.jsonl`. Shares the batches dir so the queue and
/// the scripts it references live together.
pub fn queue_path() -> Result<PathBuf, String> {
    let dir = crate::batches::batches_dir()?;
    Ok(dir.join("queue.jsonl"))
}

pub(crate) fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{secs}")
}

pub(crate) fn new_queue_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    format!("bq-{t}-{n}")
}

/// Truncate an error blob so a runaway stderr can't bloat the queue file.
pub(crate) const MAX_ERROR_LEN: usize = 2000;

pub(crate) fn clip_error(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() <= MAX_ERROR_LEN {
        Some(trimmed.to_string())
    } else {
        // Respect char boundaries — `s.len()` is bytes, not chars.
        let cut: String = trimmed.chars().take(MAX_ERROR_LEN).collect();
        Some(format!(
            "{cut}\u{2026} (+{} chars)",
            trimmed.len() - cut.len()
        ))
    }
}

// ---------------------------------------------------------------------------
// Persistence: read / atomic-write all entries
// ---------------------------------------------------------------------------

pub(crate) fn read_all() -> Result<Vec<BatchQueueEntry>, String> {
    let path = queue_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<BatchQueueEntry>(trimmed) {
            Ok(r) => out.push(r),
            Err(e) => eprintln!("[batches_queue] skip malformed line {i}: {e}"),
        }
    }
    Ok(out)
}

pub(crate) fn write_atomic(path: &PathBuf, entries: &[BatchQueueEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
    for entry in entries {
        let line =
            serde_json::to_string(entry).map_err(|e| format!("serialize queue entry: {e}"))?;
        writeln!(f, "{line}").map_err(|e| format!("write tmp: {e}"))?;
    }
    f.sync_all().ok();
    fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Dedup key
// ---------------------------------------------------------------------------

/// Two queue entries are "the same script in the same state" when their name +
/// reason match. Re-enqueuing then bumps `attempts` / refreshes `last_error`
/// instead of creating a duplicate row.
pub(crate) fn dedup_key(name: &str, reason: BatchQueueReason) -> String {
    format!("{}::{}", name.trim().to_lowercase(), reason.as_str())
}

// ---------------------------------------------------------------------------
// Core upsert (pure-ish: takes the current list, returns the new list)
// ---------------------------------------------------------------------------

/// Insert a new entry for (`name`, `reason`) or, if one already exists, bump
/// its `attempts` and refresh `last_error`. Returns the resulting entry.
///
/// PURE over the input vector so it is unit-testable without disk.
pub(crate) fn upsert(
    entries: &mut Vec<BatchQueueEntry>,
    name: &str,
    path: &str,
    reason: BatchQueueReason,
    last_error: Option<String>,
) -> BatchQueueEntry {
    upsert_full(
        entries,
        name,
        path,
        reason,
        BatchKind::Auto,
        None,
        last_error,
    )
}

/// Full upsert with explicit `kind` and `description` — used by
/// `enqueue_command_inner` and `enqueue_manual_inner`.
pub(crate) fn upsert_full(
    entries: &mut Vec<BatchQueueEntry>,
    name: &str,
    path: &str,
    reason: BatchQueueReason,
    kind: BatchKind,
    description: Option<String>,
    last_error: Option<String>,
) -> BatchQueueEntry {
    let key = dedup_key(name, reason);
    if let Some(existing) = entries
        .iter_mut()
        .find(|e| dedup_key(&e.name, e.reason) == key)
    {
        existing.attempts = existing.attempts.saturating_add(1);
        if let Some(err) = last_error.and_then(|e| clip_error(&e)) {
            existing.last_error = Some(err);
        }
        // Keep path and description fresh if a caller refreshes the entry.
        if !path.is_empty() {
            existing.path = path.to_string();
        }
        if description.is_some() {
            existing.description = description;
        }
        return existing.clone();
    }

    let entry = BatchQueueEntry {
        id: new_queue_id(),
        name: name.to_string(),
        path: path.to_string(),
        reason,
        kind,
        description,
        created_at: now_iso(),
        last_error: last_error.and_then(|e| clip_error(&e)),
        attempts: 1,
    };
    entries.push(entry.clone());
    entry
}

// ---------------------------------------------------------------------------
// Public inner API (called by the Tauri command wrappers + execute_batch_inner)
// ---------------------------------------------------------------------------

/// Record that a batch could not be run (or failed). Idempotent per
/// (name, reason): repeat calls bump `attempts` instead of duplicating.
///
/// Best-effort callers (e.g. `execute_batch_inner`) should `.ok()` the result —
/// a queue write failure must never mask the original run error.
pub fn record_inner(
    name: &str,
    path: &str,
    reason: BatchQueueReason,
    last_error: Option<String>,
) -> Result<BatchQueueEntry, String> {
    let _g = queue_lock()
        .lock()
        .map_err(|_| "batches queue lock poisoned")?;
    let mut entries = read_all()?;
    let entry = upsert(&mut entries, name, path, reason, last_error);
    let path_buf = queue_path()?;
    write_atomic(&path_buf, &entries)?;
    Ok(entry)
}

/// List all queued entries, newest first.
pub fn list_inner() -> Result<Vec<BatchQueueEntry>, String> {
    // Drain any pending lines the Stop hook appended before listing, so the UI
    // always reflects the latest captures. Drain failure is non-fatal — we
    // still return whatever is already in queue.jsonl.
    let _ = super::drain::drain_pending_inner();
    let mut entries = read_all()?;
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(entries)
}

/// Remove a queued entry by id (e.g. after a successful manual run, or a user
/// dismiss). Returns Err if the id is unknown.
pub fn dismiss_inner(id: &str) -> Result<(), String> {
    let _g = queue_lock()
        .lock()
        .map_err(|_| "batches queue lock poisoned")?;
    let mut entries = read_all()?;
    let before = entries.len();
    entries.retain(|e| e.id != id);
    if entries.len() == before {
        return Err(format!("queue entry {id} not found"));
    }
    let path = queue_path()?;
    write_atomic(&path, &entries)
}

/// Re-queue an entry: reset its reason to `Failed` semantics is NOT what we
/// want — instead we bump attempts and clear the stale error so the UI shows
/// it as "pending retry". The script itself is unchanged on disk; the actual
/// run is still a human click (`execute_batch`). Returns the updated entry.
pub fn requeue_inner(id: &str) -> Result<BatchQueueEntry, String> {
    let _g = queue_lock()
        .lock()
        .map_err(|_| "batches queue lock poisoned")?;
    let mut entries = read_all()?;
    let entry = entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("queue entry {id} not found"))?;
    entry.attempts = entry.attempts.saturating_add(1);
    entry.created_at = now_iso();
    let out = entry.clone();
    let path = queue_path()?;
    write_atomic(&path, &entries)?;
    Ok(out)
}

/// Delete every entry from the queue (used by "Clear all" to wipe both the
/// scripts on disk and the queue records in one atomic operation).
pub fn clear_queue_inner() -> Result<(), String> {
    let _g = queue_lock()
        .lock()
        .map_err(|_| "batches queue lock poisoned")?;
    let path = queue_path()?;
    // Overwrite with an empty file — same atomic tmp+rename discipline.
    write_atomic(&path, &[])
}
