// ULTRON Control Center - Batches Queue
//
// A PERSISTENT queue of batch scripts that could not be run automatically:
//   - "rejected"           — a sandbox / permission prompt denied the command
//   - "ai_cannot_execute"  — the AI session itself could not execute it
//   - "failed"             — the script ran but exited non-zero (or spawn Err)
//
// The queue is the "never silently dropped" guarantee the user asked for:
// whenever a command cannot be executed, it is LEFT in Run Batch (this queue)
// and surfaces in the UI for a one-click (human-gated) re-run.
//
// Persistence model is copied EXACTLY from `decisions.rs`'s drain discipline:
//   - queue file: ~/.ultron/batches/queue.jsonl (one JSON object per line)
//   - producers (the Node Stop hook) `appendFileSync` raw lines without a lock
//   - this module reconciles by renaming the pending file to a `.draining`
//     snapshot BEFORE reading, deduping, then doing an atomic tmp+rename
//     rewrite. Any line a producer appends between our snapshot and rewrite
//     lands in a fresh file instead of being lost.
//
// A process-wide `OnceLock<Mutex<()>>` serialises every read-modify-write path
// inside this process (same as `decisions_lock`).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// Process-wide write lock
// ---------------------------------------------------------------------------

static QUEUE_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn queue_lock() -> &'static Mutex<()> {
    QUEUE_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/// Why a batch entry is sitting in the queue instead of having run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchQueueReason {
    /// A sandbox / permission prompt denied the command (human said no, or
    /// the deny-list blocked it). The script is preserved for a manual run.
    Rejected,
    /// The AI session itself could not execute the command (no tool, sandbox
    /// limitation, interactive prompt the agent cannot answer, etc.).
    AiCannotExecute,
    /// The script ran but exited non-zero (or the spawn itself errored).
    Failed,
}

impl BatchQueueReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            BatchQueueReason::Rejected => "rejected",
            BatchQueueReason::AiCannotExecute => "ai_cannot_execute",
            BatchQueueReason::Failed => "failed",
        }
    }

    /// Parse a free-form reason string (from the UI / hook). Unknown values
    /// fall back to `Failed` rather than erroring — the queue must never reject
    /// a legitimate "this didn't run" signal on a typo.
    pub fn parse_lenient(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "rejected" | "denied" | "permission-denied" | "permission_denied" => {
                BatchQueueReason::Rejected
            }
            "ai_cannot_execute" | "ai-cannot-execute" | "ai_cannot" | "cannot_execute" => {
                BatchQueueReason::AiCannotExecute
            }
            _ => BatchQueueReason::Failed,
        }
    }
}

/// Whether a queue entry is automatically runnable by clicking "Run" or
/// requires a human to perform an out-of-band action first.
///
/// `"auto"` — standard script that USER can execute with one click.
/// `"manual"` — the AI left this as a reminder of an action it CANNOT perform
///              (e.g. rebuild, token rotation, GUI login). The Run Batch UI
///              renders these with a distinct badge and no "Run" button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BatchKind {
    #[default]
    Auto,
    Manual,
}

impl BatchKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            BatchKind::Auto => "auto",
            BatchKind::Manual => "manual",
        }
    }

    pub fn parse_lenient(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "manual" | "human" | "requires_human" | "requires-human" => BatchKind::Manual,
            _ => BatchKind::Auto,
        }
    }
}

/// One queued batch. Serialised one-per-line into `queue.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchQueueEntry {
    /// `bq-<microtime>-<counter>` — stable identity for requeue/dismiss.
    pub id: String,
    /// Bare filename of the script in `~/.ultron/batches/` (no path separators).
    /// For `kind = manual` entries this may be empty — there is no script to run.
    pub name: String,
    /// Absolute path to the script on disk (best-effort; may not exist yet).
    pub path: String,
    pub reason: BatchQueueReason,
    /// Whether this entry can be executed with the Run button (`auto`) or
    /// requires a human out-of-band action (`manual`).
    #[serde(default)]
    pub kind: BatchKind,
    /// Human-readable description of the action needed. Especially useful for
    /// `manual` entries where there is no script body to inspect.
    #[serde(default)]
    pub description: Option<String>,
    /// "epoch:<secs>" — when this entry was first enqueued.
    pub created_at: String,
    /// Last error / stderr captured for this entry (truncated). `None` when the
    /// reason carries no error text (e.g. a plain rejection).
    #[serde(default)]
    pub last_error: Option<String>,
    /// How many times a run of this entry has failed / been re-queued.
    #[serde(default)]
    pub attempts: u32,
}

// ---------------------------------------------------------------------------
// Path + id helpers
// ---------------------------------------------------------------------------

/// `~/.ultron/batches/queue.jsonl`. Shares the batches dir so the queue and the
/// scripts it references live together.
pub fn queue_path() -> Result<PathBuf, String> {
    let dir = crate::batches::batches_dir()?;
    Ok(dir.join("queue.jsonl"))
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{secs}")
}

fn new_queue_id() -> String {
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
const MAX_ERROR_LEN: usize = 2000;

fn clip_error(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() <= MAX_ERROR_LEN {
        Some(trimmed.to_string())
    } else {
        // Respect char boundaries — `s.len()` is bytes, not chars.
        let cut: String = trimmed.chars().take(MAX_ERROR_LEN).collect();
        Some(format!("{cut}… (+{} chars)", trimmed.len() - cut.len()))
    }
}

// ---------------------------------------------------------------------------
// Persistence: read / atomic-write all entries
// ---------------------------------------------------------------------------

fn read_all() -> Result<Vec<BatchQueueEntry>, String> {
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

fn write_atomic(path: &PathBuf, entries: &[BatchQueueEntry]) -> Result<(), String> {
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
fn dedup_key(name: &str, reason: BatchQueueReason) -> String {
    format!("{}::{}", name.trim().to_lowercase(), reason.as_str())
}

// ---------------------------------------------------------------------------
// Core upsert (pure-ish: takes the current list, returns the new list)
// ---------------------------------------------------------------------------

/// Insert a new entry for (`name`, `reason`) or, if one already exists, bump
/// its `attempts` and refresh `last_error`. Returns the resulting entry.
///
/// PURE over the input vector so it is unit-testable without disk.
fn upsert(
    entries: &mut Vec<BatchQueueEntry>,
    name: &str,
    path: &str,
    reason: BatchQueueReason,
    last_error: Option<String>,
) -> BatchQueueEntry {
    upsert_full(entries, name, path, reason, BatchKind::Auto, None, last_error)
}

/// Full upsert with explicit `kind` and `description` — used by
/// `enqueue_command_inner` and `enqueue_manual_inner`.
fn upsert_full(
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
    let _ = drain_pending_inner();
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
/// want — instead we bump attempts and clear the stale error so the UI shows it
/// as "pending retry". The script itself is unchanged on disk; the actual run
/// is still a human click (`execute_batch`). Returns the updated entry.
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

// ---------------------------------------------------------------------------
// Sanitize → write an ASCII-PURE .ps1 + enqueue (PS 5.1 gotcha)
// ---------------------------------------------------------------------------

/// Strip every non-ASCII byte and normalise control characters so the written
/// .ps1 is parseable by Windows PowerShell 5.1 (which reads em-dashes / smart
/// quotes as ANSI and chokes). Modelled on `ai_router::sanitize_for_cmd` but
/// kept here so this module has no cross-dependency on ai_router internals.
///
/// - Shell metacharacters that the cmd.exe layer would mangle are NOT replaced
///   here (this is a full script body, not a single cmd argument) — only
///   non-ASCII and raw control chars (other than \r\n\t) are scrubbed.
pub fn sanitize_ps1_ascii(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\r' | '\n' | '\t' => out.push(ch),
            c if c.is_ascii() && (c as u32) >= 0x20 => out.push(c),
            // Non-ASCII (em-dash, smart quotes, ñ, accents…) or other control
            // chars become a plain space — never emit them into a 5.1 script.
            _ => out.push(' '),
        }
    }
    out
}

/// Build a safe bare filename for an enqueued command. Strips path separators
/// and anything that isn't `[A-Za-z0-9._-]`, guarantees a `.ps1` extension, and
/// caps the length. Always returns a name that is safe to `dir.join`.
fn safe_script_name(name: &str) -> String {
    let stem: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Drop leading/trailing dots (hidden-file / traversal) and collapse any
    // INTERNAL ".." sequence too (path-traversal hardening) before capping.
    let stem = stem.trim_matches('.').to_string();
    let stem = stem.replace("..", "_");
    let stem = if stem.is_empty() {
        "queued-command".to_string()
    } else {
        stem.chars().take(80).collect::<String>()
    };
    if stem.to_ascii_lowercase().ends_with(".ps1") {
        stem
    } else {
        // Strip any other allowed extension fragment to avoid `name.bat.ps1`
        // confusion only when it's a known script ext; otherwise just append.
        format!("{stem}.ps1")
    }
}

/// Write an ASCII-pure `.ps1` into `~/.ultron/batches/` AND append a queue
/// entry pointing at it. This is the path the AI / UI uses to "leave a command
/// in Run Batch" when it cannot run it directly.
///
/// Returns the created queue entry (whose `path` is the written script).
pub fn enqueue_command_inner(
    name: &str,
    content: &str,
    reason: &str,
) -> Result<BatchQueueEntry, String> {
    let dir = crate::batches::batches_dir()?;
    let filename = safe_script_name(name);
    let target = dir.join(&filename);

    // ASCII-pure body — PS 5.1 gotcha (em-dash / smart quotes break the parser).
    let body = sanitize_ps1_ascii(content);

    // Serialise the write under the same lock as the queue mutation so a
    // concurrent drain can't observe a half-written pair.
    let _g = queue_lock()
        .lock()
        .map_err(|_| "batches queue lock poisoned")?;

    // Atomic-ish write: tmp + rename so a reader never sees a partial script.
    let tmp = target.with_extension("ps1.tmp");
    fs::write(&tmp, body.as_bytes()).map_err(|e| format!("write script: {e}"))?;
    fs::rename(&tmp, &target).map_err(|e| format!("rename script: {e}"))?;

    let mut entries = read_all()?;
    let entry = upsert_full(
        &mut entries,
        &filename,
        &target.to_string_lossy(),
        BatchQueueReason::parse_lenient(reason),
        BatchKind::Auto,
        None,
        None,
    );
    let path_buf = queue_path()?;
    write_atomic(&path_buf, &entries)?;
    Ok(entry)
}

/// Enqueue a **manual** action — one that the AI cannot perform automatically
/// (e.g. "rebuild the app", "rotate the GitHub token", "log in to X"). No
/// script is written to disk; this is purely a reminder in the Run Batch UI.
///
/// `name`        — short identifier for the action (used as the entry title).
/// `description` — human-readable instructions for USER.
/// `reason`      — parsed leniently; usually "ai_cannot_execute".
///
/// Returns the created (or bumped) queue entry.
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

// ---------------------------------------------------------------------------
// Drain the Stop-hook pending file into queue.jsonl (decisions.rs discipline)
// ---------------------------------------------------------------------------

/// One raw line the Node Stop hook appends to `queue-pending.jsonl`. Lenient:
/// every field optional except `name`/`command`-ish, defaults filled in.
#[derive(Debug, Deserialize)]
struct PendingQueueLine {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    last_error: Option<String>,
}

/// `~/.ultron/batches/queue-pending.jsonl` — append-only producer file the Node
/// hook writes without holding our lock.
pub fn pending_queue_path() -> Result<PathBuf, String> {
    let dir = crate::batches::batches_dir()?;
    Ok(dir.join("queue-pending.jsonl"))
}

/// Parse pending lines into entries, deduped against `existing_keys` AND within
/// the batch. PURE (no I/O) so it is unit-testable.
fn parse_pending_lines(text: &str, existing_keys: &HashSet<String>) -> Vec<BatchQueueEntry> {
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

/// Drain `queue-pending.jsonl` into `queue.jsonl`. Same rename→snapshot→dedup→
/// atomic-rewrite discipline as `decisions::drain_pending_inner`. Returns the
/// entries newly added (deduped against what was already queued).
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn no_existing() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn reason_round_trips_and_parses_lenient() {
        assert_eq!(BatchQueueReason::Rejected.as_str(), "rejected");
        assert_eq!(BatchQueueReason::Failed.as_str(), "failed");
        assert_eq!(
            BatchQueueReason::AiCannotExecute.as_str(),
            "ai_cannot_execute"
        );
        assert_eq!(
            BatchQueueReason::parse_lenient("REJECTED"),
            BatchQueueReason::Rejected
        );
        assert_eq!(
            BatchQueueReason::parse_lenient("permission-denied"),
            BatchQueueReason::Rejected
        );
        assert_eq!(
            BatchQueueReason::parse_lenient("ai-cannot-execute"),
            BatchQueueReason::AiCannotExecute
        );
        // Unknown → Failed (never panics).
        assert_eq!(
            BatchQueueReason::parse_lenient("garbage"),
            BatchQueueReason::Failed
        );
    }

    #[test]
    fn queue_id_is_unique_and_prefixed() {
        let a = new_queue_id();
        let b = new_queue_id();
        assert_ne!(a, b);
        assert!(a.starts_with("bq-"));
    }

    #[test]
    fn sanitize_ps1_strips_non_ascii_keeps_newlines() {
        let dirty = "Write-Host \"hola — señor\"\r\nGet-Date\t# café";
        let clean = sanitize_ps1_ascii(dirty);
        // Newlines / tabs preserved.
        assert!(clean.contains("\r\n"));
        assert!(clean.contains('\t'));
        // Every byte is ASCII now.
        assert!(
            clean.is_ascii(),
            "sanitized script must be pure ASCII: {clean:?}"
        );
        // The em-dash and ñ / é became spaces, not removed length.
        assert!(!clean.contains('—'));
        assert!(!clean.contains('ñ'));
    }

    #[test]
    fn safe_script_name_forces_ps1_and_strips_separators() {
        assert_eq!(safe_script_name("foo"), "foo.ps1");
        assert_eq!(safe_script_name("foo.ps1"), "foo.ps1");
        // Spaces and other disallowed chars become underscores; .ps1 appended.
        assert_eq!(safe_script_name("my script"), "my_script.ps1");
    }

    #[test]
    fn safe_script_name_rejects_path_traversal_chars() {
        let n = safe_script_name("../../etc/passwd");
        assert!(!n.contains('/'));
        assert!(!n.contains('\\'));
        assert!(!n.contains(".."));
        assert!(n.ends_with(".ps1"));
    }

    #[test]
    fn safe_script_name_empty_becomes_default() {
        assert_eq!(safe_script_name("   "), "queued-command.ps1");
        assert_eq!(safe_script_name("..."), "queued-command.ps1");
    }

    #[test]
    fn upsert_inserts_then_bumps_attempts() {
        let mut entries: Vec<BatchQueueEntry> = Vec::new();
        let first = upsert(
            &mut entries,
            "fix.ps1",
            "/p/fix.ps1",
            BatchQueueReason::Failed,
            Some("boom".into()),
        );
        assert_eq!(first.attempts, 1);
        assert_eq!(entries.len(), 1);

        let second = upsert(
            &mut entries,
            "fix.ps1",
            "/p/fix.ps1",
            BatchQueueReason::Failed,
            Some("boom2".into()),
        );
        assert_eq!(
            second.attempts, 2,
            "same name+reason must bump, not duplicate"
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(second.last_error.as_deref(), Some("boom2"));
        assert_eq!(second.id, first.id, "id is stable across re-enqueue");
    }

    #[test]
    fn upsert_different_reason_is_a_new_row() {
        let mut entries: Vec<BatchQueueEntry> = Vec::new();
        upsert(&mut entries, "x.ps1", "", BatchQueueReason::Failed, None);
        upsert(&mut entries, "x.ps1", "", BatchQueueReason::Rejected, None);
        assert_eq!(
            entries.len(),
            2,
            "same name, different reason → distinct rows"
        );
    }

    #[test]
    fn clip_error_truncates_long_blobs_on_char_boundary() {
        let long = "é".repeat(MAX_ERROR_LEN + 50); // multibyte to stress boundary
        let clipped = clip_error(&long).unwrap();
        assert!(clipped.contains("chars)"));
        // Must not panic and must remain valid UTF-8 (guaranteed by String).
        assert!(clipped.len() < long.len() + 64);
    }

    #[test]
    fn clip_error_empty_is_none() {
        assert!(clip_error("   ").is_none());
    }

    #[test]
    fn parse_pending_skips_lines_without_name() {
        let text = r#"{"reason":"failed"}
{"name":"","reason":"failed"}
{"name":"good.ps1","reason":"rejected","last_error":"nope"}"#;
        let out = parse_pending_lines(text, &no_existing());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "good.ps1");
        assert_eq!(out[0].reason, BatchQueueReason::Rejected);
        assert_eq!(out[0].last_error.as_deref(), Some("nope"));
    }

    #[test]
    fn parse_pending_dedups_within_batch_and_against_existing() {
        let mut existing = HashSet::new();
        existing.insert(dedup_key("already.ps1", BatchQueueReason::Failed));
        let text = r#"{"name":"already.ps1","reason":"failed"}
{"name":"new.ps1","reason":"failed"}
{"name":"new.ps1","reason":"failed"}"#;
        let out = parse_pending_lines(text, &existing);
        assert_eq!(out.len(), 1, "existing + intra-batch dup both filtered");
        assert_eq!(out[0].name, "new.ps1");
    }

    #[test]
    fn parse_pending_skips_malformed_json_without_aborting() {
        let text = "not json\n{\"name\":\"ok.ps1\"}\n{bad";
        let out = parse_pending_lines(text, &no_existing());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "ok.ps1");
        // default reason when omitted is failed
        assert_eq!(out[0].reason, BatchQueueReason::Failed);
    }

    #[test]
    fn write_then_read_round_trips() {
        use std::env;
        let dir = env::temp_dir().join(format!("ultron-bq-{}", new_queue_id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("queue.jsonl");
        let entries = vec![BatchQueueEntry {
            id: "bq-1".into(),
            name: "x.ps1".into(),
            path: "/p/x.ps1".into(),
            reason: BatchQueueReason::Rejected,
            kind: BatchKind::Auto,
            description: None,
            created_at: "epoch:0".into(),
            last_error: Some("denied".into()),
            attempts: 3,
        }];
        write_atomic(&path, &entries).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let parsed: BatchQueueEntry = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(parsed.id, "bq-1");
        assert_eq!(parsed.reason, BatchQueueReason::Rejected);
        assert_eq!(parsed.attempts, 3);
        // No lingering tmp.
        assert!(!path.with_extension("jsonl.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
