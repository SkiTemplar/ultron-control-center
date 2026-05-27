// ULTRON Control Center — Session auto-tag engine.
//
// Persists a simple JSONL store at
//   ~/.ultron/cockpit/sessions-tags.jsonl
// Each line is one TagEntry. The Tauri commands exposed at the bottom are:
//
//   sessions_tags_load()         — read all entries (frontend fetch on mount)
//   sessions_auto_tag(session_id, session_path, first_prompt)
//                                — tag one session via ai_router::route("summarize")
//   sessions_bulk_auto_tag(entries)
//                                — tag multiple sessions in a loop (Auto-tag all)
//
// The AI call uses the "summarize" zone which routes through Groq (free tier)
// by default, falling back to Gemini. If NEITHER key is set the function
// returns Ok with an empty tags vec so the UI can mark the session as
// "untaggable" without crashing.
//
// Schema (sessions-tags.jsonl):
//   { "session_id": "<uuid>", "tags": ["rust", "tauri", "ui-redesign"],
//     "generated_at": "2026-05-27T10:00:00Z" }

use std::fs;
use std::io::{BufRead, BufWriter, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::ultron_root;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagEntry {
    pub session_id: String,
    pub tags: Vec<String>,
    pub generated_at: String,
}

/// Minimal descriptor passed from the frontend when requesting auto-tagging
/// for a batch of sessions. The frontend already knows the first_prompt from
/// the `ClaudeSession.preview` field — we reuse it to avoid a second disk
/// scan in the backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoTagRequest {
    pub session_id: String,
    pub first_prompt: Option<String>,
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

fn tags_path() -> Result<PathBuf, String> {
    let dir = ultron_root()?.join("cockpit");
    fs::create_dir_all(&dir).map_err(|e| format!("create cockpit dir: {}", e))?;
    Ok(dir.join("sessions-tags.jsonl"))
}

pub fn load_all_tags() -> Result<Vec<TagEntry>, String> {
    let path = tags_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file =
        fs::File::open(&path).map_err(|e| format!("open sessions-tags.jsonl: {}", e))?;
    let reader = std::io::BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines() {
        let l = line.map_err(|e| format!("read line: {}", e))?;
        if l.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<TagEntry>(&l) {
            Ok(entry) => out.push(entry),
            Err(_) => {
                // Malformed line — skip silently (resilience > crash).
            }
        }
    }
    Ok(out)
}

/// Append or upsert a tag entry. If a record with the same session_id already
/// exists it is removed from the in-memory set and the updated version is
/// appended at the end (JSONL append-only with in-memory upsert).
fn upsert_tag(entry: TagEntry) -> Result<(), String> {
    let path = tags_path()?;
    // Load existing, filter out old record for this session.
    let mut existing = load_all_tags().unwrap_or_default();
    existing.retain(|e| e.session_id != entry.session_id);
    existing.push(entry);

    // Write the full updated set back (file is small — never more than a few
    // thousand entries, one per session; full rewrite is safe and simple).
    let file =
        fs::File::create(&path).map_err(|e| format!("create sessions-tags.jsonl: {}", e))?;
    let mut writer = BufWriter::new(file);
    for e in &existing {
        let line = serde_json::to_string(e)
            .map_err(|e| format!("serialize tag entry: {}", e))?;
        writeln!(writer, "{}", line)
            .map_err(|e| format!("write sessions-tags.jsonl: {}", e))?;
    }
    writer.flush().map_err(|e| format!("flush sessions-tags.jsonl: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// ISO timestamp without external deps (mirrors the helper in claude_sessions.rs)
// ---------------------------------------------------------------------------

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Re-use the format_iso logic inline rather than exposing it from
    // claude_sessions (it's pub(crate) there but we keep this self-contained).
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

// ---------------------------------------------------------------------------
// AI tag generation
// ---------------------------------------------------------------------------

const TAG_SYSTEM_PROMPT: &str = "\
You are a session tagger. Given a brief description of an AI coding session, \
generate 3-5 short descriptive tags in kebab-case (e.g. \"rust-backend\", \
\"ui-redesign\", \"auth-bugfix\"). Output ONLY a JSON array of strings, \
nothing else. Example: [\"tauri-backend\",\"file-io\",\"sessions-redesign\"]";

fn parse_tags_from_response(response: &str) -> Vec<String> {
    // Attempt to parse as JSON array directly.
    let trimmed = response.trim();
    if let Ok(tags) = serde_json::from_str::<Vec<String>>(trimmed) {
        return tags
            .into_iter()
            .map(|t| t.trim().to_lowercase().replace(' ', "-"))
            .filter(|t| !t.is_empty())
            .take(5)
            .collect();
    }
    // Fallback: extract anything between brackets.
    if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            let slice = &trimmed[start..=end];
            if let Ok(tags) = serde_json::from_str::<Vec<String>>(slice) {
                return tags
                    .into_iter()
                    .map(|t| t.trim().to_lowercase().replace(' ', "-"))
                    .filter(|t| !t.is_empty())
                    .take(5)
                    .collect();
            }
        }
    }
    Vec::new()
}

/// Generate tags for a single session. Returns the generated tags or an empty
/// vec when the AI router has no configured provider to handle the request.
fn generate_tags(session_id: &str, first_prompt: Option<&str>) -> Result<Vec<String>, String> {
    let prompt_text = first_prompt.unwrap_or("").trim();
    if prompt_text.is_empty() {
        return Ok(Vec::new());
    }

    // Build a compact prompt for the AI — we don't send the whole transcript,
    // just the first human message which is the most descriptive signal.
    let user_prompt = format!(
        "Session ID: {}\nFirst user message: {}",
        session_id, prompt_text
    );

    // We need to inject the system prompt as part of our user call because
    // the `route()` function does not accept a separate system prompt. We
    // prepend it in a format the zone's system_prompt will merge with, or
    // just include it inline — the summarize zone has no system_prompt set,
    // so ours is the only instruction.
    let full_prompt = format!("{}\n\n{}", TAG_SYSTEM_PROMPT, user_prompt);

    // "summarize" zone uses Groq (free) → Gemini fallback. If neither key is
    // available, route() returns Err. We treat that as "no tags" rather than
    // propagating the error up to the UI, because tagging is best-effort.
    match crate::ai_router::route("summarize", &full_prompt) {
        Ok(response) => Ok(parse_tags_from_response(&response)),
        Err(_) => {
            // No keys configured or all providers offline — silently return empty.
            Ok(Vec::new())
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Load all persisted tag entries. Called on frontend mount.
#[tauri::command]
pub fn sessions_tags_load() -> Result<Vec<TagEntry>, String> {
    load_all_tags()
}

/// Auto-tag a single session. Idempotent — re-tags a previously tagged session.
#[tauri::command]
pub fn sessions_auto_tag(
    session_id: String,
    first_prompt: Option<String>,
) -> Result<TagEntry, String> {
    let tags = generate_tags(&session_id, first_prompt.as_deref())?;
    let entry = TagEntry {
        session_id: session_id.clone(),
        tags,
        generated_at: now_iso(),
    };
    upsert_tag(entry.clone())?;
    Ok(entry)
}

/// Bulk auto-tag. Iterates the request list sequentially (no parallelism —
/// avoids hammering the provider). Returns one TagEntry per request in the
/// same order. Individual failures produce an entry with empty tags rather
/// than aborting the whole batch.
#[tauri::command]
pub fn sessions_bulk_auto_tag(requests: Vec<AutoTagRequest>) -> Result<Vec<TagEntry>, String> {
    let mut results = Vec::with_capacity(requests.len());
    for req in requests {
        let tags = generate_tags(&req.session_id, req.first_prompt.as_deref())
            .unwrap_or_default();
        let entry = TagEntry {
            session_id: req.session_id.clone(),
            tags,
            generated_at: now_iso(),
        };
        // Best-effort upsert — if the file write fails we still return the entry
        // so the UI can show the tags in memory even if they weren't persisted.
        let _ = upsert_tag(entry.clone());
        results.push(entry);
    }
    Ok(results)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tags_clean_json_array() {
        let input = r#"["rust-backend","tauri","ui-redesign"]"#;
        let tags = parse_tags_from_response(input);
        assert_eq!(tags, vec!["rust-backend", "tauri", "ui-redesign"]);
    }

    #[test]
    fn parse_tags_with_surrounding_text() {
        let input = r#"Here are the tags: ["auth-bugfix","sessions","api-design"] done."#;
        let tags = parse_tags_from_response(input);
        assert_eq!(tags, vec!["auth-bugfix", "sessions", "api-design"]);
    }

    #[test]
    fn parse_tags_empty_prompt_returns_empty() {
        let input = "[]";
        let tags = parse_tags_from_response(input);
        assert!(tags.is_empty());
    }

    #[test]
    fn parse_tags_normalises_spaces_to_dashes() {
        let input = r#"["rust backend","UI redesign"]"#;
        let tags = parse_tags_from_response(input);
        assert_eq!(tags, vec!["rust-backend", "ui-redesign"]);
    }

    #[test]
    fn parse_tags_caps_at_five() {
        let input = r#"["a","b","c","d","e","f","g"]"#;
        let tags = parse_tags_from_response(input);
        assert_eq!(tags.len(), 5);
    }

    #[test]
    fn now_iso_looks_like_iso8601() {
        let ts = now_iso();
        // Minimal shape check: YYYY-MM-DDTHH:MM:SSZ
        assert_eq!(ts.len(), 20);
        assert!(ts.ends_with('Z'));
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[7..8], "-");
        assert_eq!(&ts[10..11], "T");
    }
}
