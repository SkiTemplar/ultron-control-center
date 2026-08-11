// batches_queue — persistent queue of batch scripts that could not be run
// automatically.
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
// A process-wide `OnceLock<Mutex<()>>` serialises every read-modify-write
// path inside this process (same as `decisions_lock`).

pub(crate) mod drain;
pub(crate) mod persistence;
pub(crate) mod sanitize;
pub(crate) mod types;

// Re-export the public surface so callers using `crate::batches_queue::Foo`
// continue to resolve without change.
pub use persistence::{clear_queue_inner, dismiss_inner, list_inner, record_inner, requeue_inner};
pub use types::{BatchQueueEntry, BatchQueueReason};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs;

    use super::drain::parse_pending_lines;
    use super::persistence::{
        clip_error, dedup_key, new_queue_id, upsert, write_atomic, MAX_ERROR_LEN,
    };
    use super::types::{BatchKind, BatchQueueEntry, BatchQueueReason};

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

    // Higiene 2026-08-12 (audit 08-09 #41): los tests de sanitize_ps1_ascii y
    // safe_script_name se borraron junto a sus funciones.

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
            "same name, different reason \u{2192} distinct rows"
        );
    }

    #[test]
    fn clip_error_truncates_long_blobs_on_char_boundary() {
        let long = "\u{00e9}".repeat(MAX_ERROR_LEN + 50); // multibyte to stress boundary
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
        let text = "{\"reason\":\"failed\"}\n{\"name\":\"\",\"reason\":\"failed\"}\n\
                    {\"name\":\"good.ps1\",\"reason\":\"rejected\",\"last_error\":\"nope\"}";
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
        let text = "{\"name\":\"already.ps1\",\"reason\":\"failed\"}\n\
                    {\"name\":\"new.ps1\",\"reason\":\"failed\"}\n\
                    {\"name\":\"new.ps1\",\"reason\":\"failed\"}";
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
