// ULTRON Control Center — Claude session history.
//
// Surfaces the JSONL transcripts Claude Code stores under
// `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`. The view we
// produce is intentionally lightweight: id, project (the cwd, recovered
// from the folder slug), first user message as preview, byte size,
// timestamps. We don't load the whole transcript — only enough lines to
// extract the preview cheaply.

use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct ClaudeSession {
    /// Bare UUID (filename without `.jsonl`).
    pub id: String,
    /// Folder name as Claude wrote it — slugified cwd.
    pub project_slug: String,
    /// Best-effort recovered cwd. We replace `--` with `/`, then split
    /// on `:` heuristically. Used purely for display + as -cwd hint.
    pub project_label: String,
    /// First user message in the transcript, trimmed to ~160 chars.
    pub preview: Option<String>,
    /// Total bytes of the JSONL (so the UI can hint size).
    pub size_bytes: u64,
    /// File mtime as ISO 8601 UTC. Sort key.
    pub last_activity: Option<String>,
    /// Best-effort line count (1 line == 1 turn for Claude transcripts).
    pub line_count: u64,
}

fn projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/projects"))
}

/// Convert mtime to ISO 8601 in UTC without pulling in chrono.
fn mtime_iso(meta: &fs::Metadata) -> Option<String> {
    let modified = meta.modified().ok()?;
    let secs = modified.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs();
    Some(format_iso(secs))
}

fn format_iso(secs: u64) -> String {
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd { break; }
        days -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month + 1, days + 1, h, m, s)
}

/// Recover a human-readable label from the slugified folder name.
/// Claude replaces path separators with `--`; we revert that and trim
/// the disk-letter prefix when it looks like `C--`.
fn unslug(slug: &str) -> String {
    let mut s = slug.replace("--", "/");
    // Convert "C/Users/..." → "C:/Users/..."
    if s.len() > 2 && s.as_bytes()[1] == b'/' && s.as_bytes()[0].is_ascii_alphabetic() {
        let head: String = s.chars().take(1).collect();
        let tail: String = s.chars().skip(1).collect();
        s = format!("{}:{}", head, tail);
    }
    s
}

/// Extract the first user message text from a transcript. We deliberately
/// keep the scan bounded — Claude transcripts can grow to many MB and we
/// only need a snippet.
fn extract_first_user_message(path: &PathBuf) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    // Bounded scan — first 200 lines is plenty to find an initial user
    // message even in a transcript that begins with system metadata.
    for line in content.lines().take(200) {
        if line.is_empty() { continue; }
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Claude transcripts look like:
        //   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
        // We tolerate a couple of shapes (string content, single-block, multi-block).
        let typ = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if typ != "user" { continue; }
        let msg = parsed.get("message").unwrap_or(&parsed);
        if let Some(s) = msg.get("content").and_then(|v| v.as_str()) {
            return Some(trim_preview(s));
        }
        if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
            for block in arr {
                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(txt) = block.get("text").and_then(|v| v.as_str()) {
                        return Some(trim_preview(txt));
                    }
                }
            }
        }
    }
    None
}

fn trim_preview(s: &str) -> String {
    let trimmed = s.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 160 {
        return trimmed.to_string();
    }
    let head: String = chars.into_iter().take(160).collect();
    format!("{}…", head)
}

/// Count newline-terminated records in the file without loading it.
fn count_lines(path: &PathBuf) -> u64 {
    let raw = match fs::read(path) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    raw.iter().filter(|b| **b == b'\n').count() as u64
}

pub fn list_claude_sessions_inner(limit: Option<usize>) -> Result<Vec<ClaudeSession>, String> {
    let dir = projects_dir().ok_or_else(|| "no HOME".to_string())?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<ClaudeSession> = Vec::new();

    for project_entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let slug = project_entry.file_name().to_string_lossy().to_string();
        let label = unslug(&slug);

        // Top-level .jsonl files inside each project folder. We skip
        // `subagents/*.jsonl` because those are not resumable sessions —
        // they're internal records of subagent turns.
        let mut files = match fs::read_dir(&project_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        while let Some(Ok(f)) = files.next() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let fname = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // UUID-ish files only — Claude session IDs are 8-4-4-4-12.
            if !fname.chars().any(|c| c == '-') {
                continue;
            }
            let id = fname.trim_end_matches(".jsonl").to_string();
            let meta = match f.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            // Skip tiny files — usually aborts.
            if meta.len() < 100 {
                continue;
            }
            out.push(ClaudeSession {
                id: id.clone(),
                project_slug: slug.clone(),
                project_label: label.clone(),
                preview: extract_first_user_message(&p),
                size_bytes: meta.len(),
                last_activity: mtime_iso(&meta),
                line_count: count_lines(&p),
            });
        }
    }

    // Newest activity first.
    out.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    if let Some(n) = limit {
        out.truncate(n);
    }
    Ok(out)
}
