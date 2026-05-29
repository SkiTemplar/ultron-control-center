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
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::ultron_root;

// ---------------------------------------------------------------------------
// Process-wide write lock
// ---------------------------------------------------------------------------
//
// `upsert_tag` does a load-all → filter → push → full-rewrite. Without a lock,
// two concurrent callers (e.g. `sessions_bulk_auto_tag` looping while a
// background auto-tag fires) both read the same baseline and the second writer
// clobbers the first writer's addition — entries vanish silently. The lock is
// held across the whole read-modify-write so it is atomic from the caller's
// point of view. Same pattern as `kg::kg_write_lock` / `workdays::workday_lock`
// / `decisions::decisions_lock`. Pure reads (`sessions_tags_load`) are excluded.
static SESSIONS_TAGS_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn sessions_tags_lock() -> &'static Mutex<()> {
    SESSIONS_TAGS_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

/// Upper bound on a session_id. UUIDs are 36 chars; anything beyond this is a
/// malformed/hostile frontend input and is rejected before it can fill disk.
const MAX_SESSION_ID_LEN: usize = 256;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagEntry {
    pub session_id: String,
    pub tags: Vec<String>,
    pub generated_at: String,
    /// Project slug this session belongs to, derived from its cwd
    /// (card-vis-auto-tag-cwd, sessions-tags schema v2). Optional +
    /// skip-when-none so old entries (schema v1) read and re-serialise
    /// unchanged — the backward-compatible half of the v2.14 schema change
    /// declared in `migration.rs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
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
    load_tags_at(&path)
}

/// Read all entries from a specific JSONL path. Path-parameterised so the
/// read-modify-write logic can be exercised against a temp file in tests
/// without touching the real `~/.ultron/cockpit/sessions-tags.jsonl`.
fn load_tags_at(path: &Path) -> Result<Vec<TagEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file =
        fs::File::open(path).map_err(|e| format!("open sessions-tags.jsonl: {}", e))?;
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
    upsert_tag_at(&path, entry)
}

/// Lock-guarded read-modify-write against a specific path. The
/// `SESSIONS_TAGS_WRITE_LOCK` is held across the whole load → filter → push →
/// write so concurrent callers cannot interleave and lose entries. Writes go
/// to a temp file then `rename` over the target so a crash mid-write never
/// leaves a truncated store (atomic-replace, same as kanban/kg/decisions).
fn upsert_tag_at(path: &Path, entry: TagEntry) -> Result<(), String> {
    // Reject pathological session_id (unvalidated frontend input) before any
    // lock or disk work — guards against a disk-fill DoS via a giant id.
    if entry.session_id.len() > MAX_SESSION_ID_LEN {
        return Err(format!(
            "session_id too long: {} > {}",
            entry.session_id.len(),
            MAX_SESSION_ID_LEN
        ));
    }
    let _guard = sessions_tags_lock()
        .lock()
        .map_err(|e| format!("sessions-tags lock poisoned: {}", e))?;

    // Load existing, filter out old record for this session.
    let mut existing = load_tags_at(path).unwrap_or_default();
    existing.retain(|e| e.session_id != entry.session_id);
    existing.push(entry);

    // Serialise to a temp sibling, then atomically rename over the target.
    // File is small (one entry per session) so a full rewrite is fine.
    // SAFETY: tmp lives next to the target (same dir => same volume), so the
    // rename below is an atomic replace on Windows (MoveFileEx). Moving tmp to
    // another volume would degrade to copy+delete = non-atomic.
    let tmp = path.with_extension("jsonl.tmp");
    {
        let file = fs::File::create(&tmp)
            .map_err(|e| format!("create sessions-tags tmp: {}", e))?;
        let mut writer = BufWriter::new(file);
        for e in &existing {
            let line = serde_json::to_string(e)
                .map_err(|e| format!("serialize tag entry: {}", e))?;
            writeln!(writer, "{}", line)
                .map_err(|e| format!("write sessions-tags tmp: {}", e))?;
        }
        writer
            .flush()
            .map_err(|e| format!("flush sessions-tags tmp: {}", e))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename sessions-tags.jsonl: {}", e))?;
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
        project: None,
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
            project: None,
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

    // ---- write-lock / concurrency (card-data-sessions-tags-write-lock) -----

    /// Unique temp path per test invocation so parallel `cargo test` runs do
    /// not collide and the real cockpit store is never touched.
    fn unique_temp_tags_path() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "ultron_sessions_tags_test_{}_{}.jsonl",
            std::process::id(),
            n
        ))
    }

    #[test]
    fn upsert_tag_at_roundtrips_and_upserts_same_session() {
        let path = unique_temp_tags_path();
        let _ = fs::remove_file(&path);

        let mk = |id: &str, tag: &str| TagEntry {
            session_id: id.to_string(),
            tags: vec![tag.to_string()],
            generated_at: "2026-05-29T00:00:00Z".to_string(),
            project: None,
        };

        upsert_tag_at(&path, mk("s1", "alpha")).unwrap();
        upsert_tag_at(&path, mk("s2", "beta")).unwrap();
        // Re-tag s1 — should replace, not duplicate.
        upsert_tag_at(&path, mk("s1", "gamma")).unwrap();

        let all = load_tags_at(&path).unwrap();
        assert_eq!(all.len(), 2, "upsert must not duplicate the same session_id");
        let s1 = all.iter().find(|e| e.session_id == "s1").unwrap();
        assert_eq!(s1.tags, vec!["gamma"], "upsert must overwrite previous tags");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn schema_v1_without_project_reads_none_and_v2_preserved() {
        let path = unique_temp_tags_path();
        let _ = fs::remove_file(&path);
        let v1 = r#"{"session_id":"old","tags":["a"],"generated_at":"2026-01-01T00:00:00Z"}"#;
        let v2 = r#"{"session_id":"new","tags":["b"],"generated_at":"2026-05-29T00:00:00Z","project":"ultron"}"#;
        fs::write(&path, format!("{v1}\n{v2}\n")).unwrap();

        let all = load_tags_at(&path).unwrap();
        assert_eq!(all.len(), 2);
        let old = all.iter().find(|e| e.session_id == "old").unwrap();
        assert_eq!(old.project, None, "v1 entry (no project) -> None");
        let new = all.iter().find(|e| e.session_id == "new").unwrap();
        assert_eq!(new.project.as_deref(), Some("ultron"), "v2 project preserved");
        // None must be skipped on re-serialise so a rollback to a v1 reader
        // never trips over an unexpected null.
        let s = serde_json::to_string(old).unwrap();
        assert!(!s.contains("project"), "None project must skip serialisation");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn upsert_tag_at_preserves_all_entries_under_contention() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let path = unique_temp_tags_path();
        let _ = fs::remove_file(&path);

        // Many threads upserting distinct sessions at once. Without the write
        // lock the read-all → rewrite races and entries are lost (len < N).
        // With the lock every entry survives.
        const N: usize = 24;
        let barrier = Arc::new(Barrier::new(N));
        let mut handles = Vec::with_capacity(N);
        for i in 0..N {
            let p = path.clone();
            let b = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                b.wait();
                let entry = TagEntry {
                    session_id: format!("session-{i}"),
                    tags: vec![format!("tag-{i}")],
                    generated_at: "2026-05-29T00:00:00Z".to_string(),
                    project: None,
                };
                upsert_tag_at(&p, entry).unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let all = load_tags_at(&path).unwrap();
        assert_eq!(
            all.len(),
            N,
            "lost entries to a write race — the lock is not protecting upsert"
        );

        let _ = fs::remove_file(&path);
    }
}
