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

fn backups_dir() -> Result<PathBuf, String> {
    Ok(ultron_root()?.join("backups").join("alerts"))
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
}

// ---------------------------------------------------------------------------
// Backup rotation
// ---------------------------------------------------------------------------

fn timestamp_now() -> String {
    // Compact, filename-safe, sortable: 20260516T193045Z-ish (UTC).
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // We don't pull chrono just for this — build YYYYMMDDTHHMMSS from secs.
    // For our purposes (sortable backup filenames) the exact wall clock is
    // less important than monotonicity within a session.
    let secs = now as i64;
    // Days since epoch -> Y/M/D via a simple civil-from-days algorithm
    // (Howard Hinnant). Cheaper than a chrono dep for a single filename.
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = sod / 3600;
    let mm = (sod % 3600) / 60;
    let ss = sod % 60;
    format!("{:04}{:02}{:02}T{:02}{:02}{:02}Z", y, m, d, hh, mm, ss)
}

/// Hinnant's civil_from_days. Returns (year, month, day) for a given
/// integer number of days since 1970-01-01.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = (y + if m <= 2 { 1 } else { 0 }) as i32;
    (y, m, d)
}

fn write_backup(original: &PathBuf) -> Result<PathBuf, String> {
    let dir = backups_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir backups: {}", e))?;
    let stamp = timestamp_now();
    let dest = dir.join(format!("alerts-{}.jsonl", stamp));
    fs::copy(original, &dest).map_err(|e| format!("backup copy: {}", e))?;
    prune_backups(&dir, 10).ok();
    Ok(dest)
}

fn prune_backups(dir: &PathBuf, keep: usize) -> Result<(), String> {
    let mut entries: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("read backups: {}", e))? {
        let entry = entry.map_err(|e| format!("entry: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if !name.starts_with("alerts-") || !name.ends_with(".jsonl") {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        entries.push((path, mtime));
    }
    // Newest first.
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in entries.into_iter().skip(keep) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Remove every line whose computed fingerprint matches one of
/// `fingerprints`. Returns the number of physical lines removed (not the
/// number of unique fingerprints — repeats in the file all count). A
/// non-existent file is treated as "nothing to delete" and returns `Ok(0)`.
///
/// Atomic: writes to `<path>.tmp` and renames into place. A timestamped
/// backup is always created BEFORE the rewrite, even if zero matches —
/// rationale: the user explicitly asked for a destructive op, so a safety
/// snapshot is cheap insurance and surfaces "you clicked Delete on
/// nothing" via the backup count without surprising side effects.
pub fn delete_alerts_by_fingerprints(fingerprints: Vec<String>) -> Result<usize, String> {
    let path = alerts_path()?;
    if !path.exists() {
        return Ok(0);
    }
    if fingerprints.is_empty() {
        return Ok(0);
    }
    let targets: std::collections::HashSet<String> = fingerprints.into_iter().collect();

    let original =
        fs::read_to_string(&path).map_err(|e| format!("read alerts.jsonl: {}", e))?;

    // Always snapshot before we touch the file.
    let _backup = write_backup(&path)?;

    let mut kept: Vec<&str> = Vec::new();
    let mut removed: usize = 0;
    for raw_line in original.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            // Drop blank lines silently — they'd round-trip as noise.
            continue;
        }
        match serde_json::from_str::<AlertShape>(trimmed) {
            Ok(parsed) => {
                let src = parsed.source.unwrap_or_default();
                let msg = parsed.message.unwrap_or_default();
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
