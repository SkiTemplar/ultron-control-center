// batches_queue/sanitize.rs — PS1 ASCII sanitization, safe filename building,
// and the enqueue-command / enqueue-manual public inner API.

use std::fs;

use crate::batches_queue::persistence::{
    queue_lock, queue_path, read_all, upsert_full, write_atomic,
};
use crate::batches_queue::types::{BatchKind, BatchQueueEntry, BatchQueueReason};

// ---------------------------------------------------------------------------
// PS1 sanitisation (PS 5.1 gotcha)
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
/// and anything that isn't `[A-Za-z0-9._-]`, guarantees a `.ps1` extension,
/// and caps the length. Always returns a name that is safe to `dir.join`.
pub(super) fn safe_script_name(name: &str) -> String {
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

// ---------------------------------------------------------------------------
// Enqueue helpers
// ---------------------------------------------------------------------------

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
/// `description` — human-readable instructions for the user.
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
