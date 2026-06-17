// agent_orchestration/delegation_log.rs — append-only JSONL delegation log.
//
// Powers the Agents > Runs view (status badges + recent delegations list).
// File location: ~/.ultron/cockpit/delegations.jsonl

use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::types::DelegationLogEntry;

pub(super) fn delegations_path() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".ultron")
            .join("cockpit")
            .join("delegations.jsonl"),
    )
}

pub(super) fn now_secs_safe() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(super) fn truncate(s: &str, max: usize) -> String {
    // Strip control characters (incl. \r, \t, vertical-tab) — \n is already
    // collapsed below — so the JSONL line stays grep/jq-friendly even when
    // a task description was pasted from a terminal with weird escapes
    // (KIRKARDO 3 LOW). Spaces survive.
    let cleaned: String = s
        .trim()
        .chars()
        .map(|c| if c == '\n' { ' ' } else { c })
        .filter(|c| !c.is_control() || *c == ' ')
        .collect();
    // Single pass: bound iteration to `max` chars instead of allocating
    // Vec<char> (KIRKARDO 2 MED). The truncated marker '…' only appears
    // when we actually had to cut.
    let mut head = String::with_capacity(max.min(cleaned.len()) + 3);
    let mut truncated = false;
    for (count, ch) in cleaned.chars().enumerate() {
        if count >= max {
            truncated = true;
            break;
        }
        head.push(ch);
    }
    if truncated {
        head.push('…');
    }
    head
}

pub(super) fn log_delegation(entry: DelegationLogEntry) -> Result<(), String> {
    let path = delegations_path().ok_or("no home dir")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    // KIRKARDO 19 fix: single write_all so two concurrent delegations can't
    // interleave their JSON body with the newline separator and produce a
    // malformed JSONL line on Windows (where O_APPEND atomicity is weaker
    // than POSIX). Avoids the {a}{b}\n\n pattern.
    let mut buf = line.into_bytes();
    buf.push(b'\n');
    f.write_all(&buf).map_err(|e| e.to_string())?;
    Ok(())
}

/// Read up to `limit` of the most recent delegations (newest first). Tolerant
/// to malformed lines — bad records are skipped silently. Returns an empty
/// vec when the file is missing.
pub fn list_delegations_inner(limit: usize) -> Result<Vec<DelegationLogEntry>, String> {
    let cap = if limit == 0 || limit > 500 {
        100
    } else {
        limit
    };
    let Some(path) = delegations_path() else {
        return Ok(Vec::new());
    };
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut out: Vec<DelegationLogEntry> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<DelegationLogEntry>(l).ok())
        .collect();
    out.reverse();
    out.truncate(cap);
    Ok(out)
}
