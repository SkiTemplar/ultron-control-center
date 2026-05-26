// ULTRON Control Center — Quick Capture Inbox
//
// Append-only JSONL store at ~/.ultron/cockpit/inbox.jsonl.
// One line per note, atomic append via OpenOptions::append (POSIX/Win32
// guarantees small writes are atomic for append mode under the
// filesystem's block size — JSONL lines stay well under that).
//
// No external lock library: we rely on the append-mode contract instead.
// The file is read-only-ish during list (tail read) so concurrent
// append + list is safe.

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const MAX_TEXT_LEN: usize = 4000;
const MIN_TEXT_LEN: usize = 1;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InboxEntry {
    pub ts: String,
    pub text: String,
    pub source: String,
}

fn inbox_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron/cockpit/inbox.jsonl"))
        .ok_or_else(|| "No HOME dir".to_string())
}

// ISO-8601 UTC stamp. Same minimal formatter used in lib.rs::record_ui_alert
// so we don't pull chrono just for this.
fn iso_now_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd {
            break;
        }
        days -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month + 1,
        days + 1,
        h,
        m,
        s
    )
}

pub fn append_inbox_inner(text: &str) -> Result<(), String> {
    let trimmed = text.trim();
    let n = trimmed.chars().count();
    if n < MIN_TEXT_LEN {
        return Err("empty note".into());
    }
    if n > MAX_TEXT_LEN {
        return Err(format!("note too long ({} chars, max {})", n, MAX_TEXT_LEN));
    }

    let path = inbox_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {:?}: {}", parent, e))?;
    }

    let entry = InboxEntry {
        ts: iso_now_utc(),
        text: trimmed.to_string(),
        source: "quick_capture".to_string(),
    };
    let line = serde_json::to_string(&entry).map_err(|e| format!("encode: {}", e))?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {:?}: {}", path, e))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("write: {}", e))?;
    file.write_all(b"\n").map_err(|e| format!("write nl: {}", e))?;
    Ok(())
}

pub fn list_inbox_inner(limit: usize) -> Result<Vec<InboxEntry>, String> {
    let path = inbox_path()?;
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return Ok(Vec::new()),
    };
    let reader = BufReader::new(file);
    let mut lines: Vec<String> = Vec::new();
    for line in reader.lines().flatten() {
        if !line.trim().is_empty() {
            lines.push(line);
        }
    }
    let cap = limit.clamp(1, 5000);
    let n = lines.len();
    let start = n.saturating_sub(cap);
    let mut out: Vec<InboxEntry> = Vec::with_capacity(n - start);
    // Newest first
    for l in lines[start..].iter().rev() {
        if let Ok(e) = serde_json::from_str::<InboxEntry>(l) {
            out.push(e);
        }
    }
    Ok(out)
}
