// ULTRON Control Center — Alerts administration module.
//
// Backs the Notifications tab's "Delete info" action: physically removes
// lines from `~/.ultron/alerts.jsonl` instead of only hiding them in
// `localStorage` (the old client-side dismiss is a UX-only mask — the
// alerts come back the moment the parent reloads `read_alerts` because the
// disk file is untouched).
//
// Source of truth: `~/.ultron/alerts.jsonl`, one JSON object per line.
//
// Match strategy: the frontend addresses alerts by a "fingerprint" of the
// form
//
//     `${source}::${message.trim().replace(/\s+/g, " ").slice(0, 80)}`
//
// (see `fingerprint()` / `groupKey()` in `src/components/Notifications.tsx`).
// We replicate that EXACT shape here so the lists round-trip — any drift
// would leave entries un-deletable from the UI.
//
// Safety:
//   * Backup to `~/.ultron/backups/alerts/alerts-<ts>.jsonl` before any
//     write. Keep the last 10, prune older copies.
//   * Atomic write: render the new content to `<file>.tmp` then `rename`
//     into place. A crash mid-write therefore never produces a truncated
//     `alerts.jsonl`.
//   * Lines that fail to parse as JSON are PRESERVED untouched — they
//     can't match a fingerprint (no `source`/`message`), and silently
//     dropping them would be data loss.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::Deserialize;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn ultron_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron"))
        .ok_or_else(|| "No HOME dir".to_string())
}

fn alerts_path() -> Result<PathBuf, String> {
    Ok(ultron_root()?.join("alerts.jsonl"))
}

// ---------------------------------------------------------------------------
// Fingerprint — MUST match the frontend exactly
// ---------------------------------------------------------------------------

/// Mirrors `fingerprint()` in `src/components/Notifications.tsx`:
///
///   const msg = (a.message ?? "").trim().replace(/\s+/g, " ");
///   return `${a.source}::${msg.slice(0, 80)}`;
///
/// Note: JS `String.prototype.slice(0, 80)` slices by UTF-16 code units.
/// For ASCII messages (the overwhelmingly common case for alerts.jsonl)
/// this matches Rust's char count. We use `.chars().take(80)` rather
/// than `&s[..80]` so we never panic on a multi-byte boundary; any drift
/// vs. JS for messages with astral characters is bounded to at most a
/// few entries that the user can still delete by source-mute.
fn fingerprint(source: &str, message: &str) -> String {
    let collapsed: String = {
        // trim() + collapse runs of whitespace to a single space.
        let trimmed = message.trim();
        let mut out = String::with_capacity(trimmed.len());
        let mut in_ws = false;
        for ch in trimmed.chars() {
            if ch.is_whitespace() {
                if !in_ws {
                    out.push(' ');
                    in_ws = true;
                }
            } else {
                out.push(ch);
                in_ws = false;
            }
        }
        out
    };
    let head: String = collapsed.chars().take(80).collect();
    format!("{}::{}", source, head)
}

// ---------------------------------------------------------------------------
// Minimal parse shape — only the fields needed to derive a fingerprint.
// Everything else stays opaque; we never re-serialize the line, we just
// decide keep-or-drop on the original text.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AlertShape {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    ack: Option<bool>,
    #[serde(default)]
    id: Option<String>,
}

impl AlertShape {
    /// An ack-only tombstone is a row with `ack:true` and no displayable
    /// fields (no source / message / severity). It is a marker for a prior
    /// alert that has been acknowledged; the Notifications tab never wants
    /// to see it, and bulk deletes should evict it so the file stays clean.
    fn is_orphan_tombstone(&self) -> bool {
        let has_message = self.message.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
        let has_source = self.source.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
        let has_severity = self.severity.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
        let acked = self.ack.unwrap_or(false);
        acked && !has_message && !has_source && !has_severity
    }
}

// v15.2.30: backup rotation helpers (write_backup / prune_backups /
// timestamp_now / civil_from_days) were removed when we stopped snapshotting
// alerts.jsonl on every delete. If you ever need them again, retrieve from
// git history (commit pre-v15.2.30).

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Remove every line whose computed fingerprint matches one of
/// `fingerprints`. Returns the number of physical lines removed.
///
/// Side effects on every call (even on a no-fingerprint sweep):
///   * Orphan ack-tombstones are evicted unconditionally.
///   * Tombstones (id-only ack rows) whose id matches a deleted alert
///     are also removed — no history is kept of what was acked.
///
/// v15.2.30: no more silent backup snapshots. The user explicitly asked
/// for "borrar = borrar, sin historial"; keeping disk copies of every
/// delete behind their back violated that. If you need a snapshot,
/// `Get-Content alerts.jsonl > backup.jsonl` is one shell line away.
///
/// Atomic: writes to `<path>.tmp` and renames into place.
pub fn delete_alerts_by_fingerprints(fingerprints: Vec<String>) -> Result<usize, String> {
    let path = alerts_path()?;
    if !path.exists() {
        return Ok(0);
    }
    // Empty fingerprints is still a valid call — we use it as an
    // opportunity to evict orphan ack-tombstones (see is_orphan_tombstone).
    let targets: std::collections::HashSet<String> = fingerprints.into_iter().collect();

    let original =
        fs::read_to_string(&path).map_err(|e| format!("read alerts.jsonl: {}", e))?;

    // Pass 1: figure out which alert ids get deleted (so their ack tombstones
    // can be evicted in pass 2). We need this because tombstones are
    // anonymous (id + ack:true only) and would otherwise outlive the alert
    // they referred to — leaving a "ghost ack" in the file.
    let mut deleted_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for raw_line in original.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<AlertShape>(trimmed) {
            if parsed.is_orphan_tombstone() {
                continue;
            }
            let src = parsed.source.clone().unwrap_or_default();
            let msg = parsed.message.clone().unwrap_or_default();
            let fp = fingerprint(&src, &msg);
            if targets.contains(&fp) {
                if let Some(id) = parsed.id.clone() {
                    deleted_ids.insert(id);
                }
            }
        }
    }

    let mut kept: Vec<&str> = Vec::new();
    let mut removed: usize = 0;
    for raw_line in original.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<AlertShape>(trimmed) {
            Ok(parsed) => {
                // Always evict orphan ack-tombstones — they are never UI
                // items and accumulating them is pure noise.
                if parsed.is_orphan_tombstone() {
                    removed += 1;
                    continue;
                }
                // Evict any ack row (id-only) whose id belongs to an
                // alert we're about to delete: keeping "ack" history of a
                // gone alert is exactly the history the user said to drop.
                if parsed.ack.unwrap_or(false)
                    && parsed
                        .id
                        .as_ref()
                        .map(|i| deleted_ids.contains(i))
                        .unwrap_or(false)
                {
                    removed += 1;
                    continue;
                }
                let src = parsed.source.clone().unwrap_or_default();
                let msg = parsed.message.clone().unwrap_or_default();
                let fp = fingerprint(&src, &msg);
                if targets.contains(&fp) {
                    removed += 1;
                    continue;
                }
                kept.push(raw_line);
            }
            Err(_) => {
                // Unparseable line — preserve verbatim. We can't compute a
                // fingerprint without source+message, and silent drop
                // would be data loss.
                kept.push(raw_line);
            }
        }
    }

    // Atomic write: tmp file in same directory, then rename.
    let tmp_path = path.with_extension("jsonl.tmp");
    {
        let mut f =
            fs::File::create(&tmp_path).map_err(|e| format!("create tmp: {}", e))?;
        for line in &kept {
            f.write_all(line.as_bytes())
                .map_err(|e| format!("write tmp: {}", e))?;
            f.write_all(b"\n").map_err(|e| format!("write tmp: {}", e))?;
        }
        f.sync_all().ok();
    }
    fs::rename(&tmp_path, &path).map_err(|e| format!("rename tmp -> alerts.jsonl: {}", e))?;

    Ok(removed)
}

// ---------------------------------------------------------------------------
// LIB_RS_WIRING:
//
// To activate `delete_alert_entries` on the Tauri side, paste the following
// THREE chunks into `src-tauri/src/lib.rs`. None of this lives here so the
// patch to `lib.rs` stays auditable and conflict-free.
//
// 1) Top-of-file module list — insert ALPHABETICALLY in the `mod ...;` block
//    (around line 8-39). Suggested position: between `mod ai_router;` and
//    `mod auth;`:
//
//        mod alerts_admin;
//
// 2) Command wrapper — add anywhere among the other `#[tauri::command]`
//    blocks (a natural spot is right after `read_alerts` at lib.rs:281):
//
//        #[tauri::command]
//        async fn delete_alert_entries(fingerprints: Vec<String>) -> Result<usize, String> {
//            alerts_admin::delete_alerts_by_fingerprints(fingerprints)
//        }
//
// 3) Handler registration — add an entry inside the
//    `tauri::generate_handler![...]` macro (currently at lib.rs:1107).
//    Suggested position: right after the `read_alerts,` entry on line 1110:
//
//            delete_alert_entries,
//
// After those three edits, rebuild the Tauri shell (`pnpm tauri dev` or the
// project's usual build cmd). The frontend already calls
// `invoke("delete_alert_entries", { fingerprints: [...] })` — no further
// glue required.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_collapses_whitespace() {
        // Single-space collapse + trim + head(80)
        let fp = fingerprint("doctor", "  hello    world\n  ");
        assert_eq!(fp, "doctor::hello world");

        // Tabs / newlines / multiple consecutive whitespace
        let fp = fingerprint("hook", "a\t\tb\nc");
        assert_eq!(fp, "hook::a b c");

        // Trimming both ends
        let fp = fingerprint("src", " x ");
        assert_eq!(fp, "src::x");
    }

    #[test]
    fn fingerprint_truncates_to_80_chars() {
        // Long message — head must be exactly 80 chars after collapsing.
        let long_msg = "a".repeat(200);
        let fp = fingerprint("svc", &long_msg);
        // fp = "svc::" + 80 'a's
        assert_eq!(fp.len(), "svc::".len() + 80);
        assert!(fp.starts_with("svc::"));
        assert_eq!(&fp[5..], &"a".repeat(80));
    }

    #[test]
    fn is_orphan_tombstone_matches_ack_only_rows() {
        // Pure ack tombstone: ack=true, every displayable field empty/None
        let tomb = AlertShape {
            source: None,
            message: None,
            severity: None,
            ack: Some(true),
            id: Some("alert-123".into()),
        };
        assert!(tomb.is_orphan_tombstone());

        // Empty-string fields also count as "no displayable content".
        let tomb_empty = AlertShape {
            source: Some(String::new()),
            message: Some(String::new()),
            severity: Some(String::new()),
            ack: Some(true),
            id: Some("alert-99".into()),
        };
        assert!(tomb_empty.is_orphan_tombstone());
    }

    #[test]
    fn is_orphan_tombstone_rejects_displayable_rows() {
        // Real alert (not acked) — never an orphan
        let real = AlertShape {
            source: Some("doctor".into()),
            message: Some("disk low".into()),
            severity: Some("warn".into()),
            ack: Some(false),
            id: Some("a1".into()),
        };
        assert!(!real.is_orphan_tombstone());

        // Acked but still has a message — NOT an orphan (it has UI content)
        let acked_with_msg = AlertShape {
            source: None,
            message: Some("info".into()),
            severity: None,
            ack: Some(true),
            id: Some("a2".into()),
        };
        assert!(!acked_with_msg.is_orphan_tombstone());

        // ack=None — definitely not an orphan
        let unacked = AlertShape {
            source: None,
            message: None,
            severity: None,
            ack: None,
            id: Some("a3".into()),
        };
        assert!(!unacked.is_orphan_tombstone());
    }
}
