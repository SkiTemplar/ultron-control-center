// ULTRON Control Center — Session recall.
//
// Lets the user pull a structured summary of the most recent Claude Code
// session for a given project (or globally) so they can paste it back as the
// first prompt of a brand new session. The frontend invokes this from the
// per-project terminal "Recall" button and from the global Control Center
// terminal.
//
// Inputs:
//   * `project_id`  — optional. When set, the project's registered `path`
//                     is resolved via `projects::list_projects_inner` and
//                     used as the cwd hint.
//   * `cwd`         — optional. Explicit absolute path; takes precedence
//                     over the project_id-derived hint.
//
// Lookup strategy:
//   1. Slugify the cwd hint using the same rule as
//      `claude_sessions::project_slug_for` and look for
//      `~/.claude/projects/<slug>/*.jsonl`.
//   2. If that fails, fall back to basename matching — any project
//      folder whose recovered cwd shares the basename of the hint. This
//      mirrors the heuristics in `~/.claude/hooks/session-start-override.js`.
//   3. If still nothing, when a cwd hint exists, query mem0 with the cwd
//      string as the search query so the user at least gets some recent
//      "what was I working on" context.
//
// Output is a `RecallResult` carrying:
//   * a markdown summary (~500 words) covering topics, files touched,
//     decisions, last activity timestamp.
//   * a `suggested_prompt` paragraph ready to paste as the first message
//     of a new session, in the user's voice ("Continuamos con X…").

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use thiserror::Error;

use crate::claude_sessions::{cwd_from_jsonl, list_workspaces_inner};

/// Typed error for recall operations — KIRKARDO 16.
#[derive(Debug, Error)]
pub enum RecallError {
    #[error("no session found: {0}")]
    NotFound(String),
    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("parse error: {0}")]
    ParseError(String),
}

const MAX_MESSAGES: usize = 50;
const MAX_TOPICS: usize = 8;
const MAX_FILES: usize = 12;
const MAX_DECISIONS: usize = 6;

#[derive(Debug, Serialize, Clone)]
pub struct RecallResult {
    /// Did we locate a real Claude session for the project?
    pub found: bool,
    /// UUID of the matched session (filename stem). None when falling back
    /// to mem0 or when nothing matched.
    pub session_id: Option<String>,
    /// ISO 8601 mtime of the matched session, when found.
    pub last_active_iso: Option<String>,
    /// Markdown blob the dialog renders in a scrollable area.
    pub summary_md: String,
    /// Paste-ready first prompt for a brand new session.
    pub suggested_prompt: String,
    /// Origin: "jsonl" | "mem0" | "none". Lets the UI hint where the data
    /// came from so the user isn't surprised by mem0-only summaries.
    pub source: String,
}

// ---------------------------------------------------------------------------
// JSONL slug helpers
// ---------------------------------------------------------------------------

/// Mirror of `claude_sessions::project_slug_for` kept inline so this module
/// doesn't have to make that helper public.
fn slug_for(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 4);
    for ch in path.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

fn projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Locate the newest JSONL inside `dir`. Returns the path + mtime.
fn newest_jsonl(dir: &Path) -> Option<(PathBuf, SystemTime)> {
    let mut best: Option<(PathBuf, SystemTime)> = None;
    let rd = fs::read_dir(dir).ok()?;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() == 0 {
            continue;
        }
        let mtime = match meta.modified() {
            Ok(t) => t,
            Err(_) => continue,
        };
        match best {
            None => best = Some((p, mtime)),
            Some((_, prev)) if mtime > prev => best = Some((p, mtime)),
            _ => {}
        }
    }
    best
}

/// Try to find the most-recent JSONL for the given cwd hint, including
/// basename fallback. Returns the path + slug used.
fn find_session_jsonl(cwd_hint: &str) -> Option<(PathBuf, String)> {
    let base = projects_dir()?;
    if !base.exists() {
        return None;
    }
    // Direct slug match first.
    let slug = slug_for(cwd_hint);
    let candidate = base.join(&slug);
    if candidate.is_dir() {
        if let Some((p, _)) = newest_jsonl(&candidate) {
            return Some((p, slug));
        }
    }

    // Strategy 2 — reuse the production workspace index. `list_workspaces_inner`
    // already does the heavy lifting (slug unescape + cwd recovery) that the
    // Sessions tab relies on; matching against it gives us the exact
    // workspace the user sees in the UI instead of re-rolling that logic.
    // Comparison normalises slashes + case so Windows hint
    // `C:\Users\USER\.ultron\control-center` matches a recovered cwd
    // written with forward slashes / different casing.
    let normalised_hint = normalise_path_for_cmp(cwd_hint);
    if let Ok(workspaces) = list_workspaces_inner() {
        let mut best: Option<(PathBuf, SystemTime, String)> = None;
        for ws in &workspaces {
            if normalise_path_for_cmp(&ws.cwd) != normalised_hint {
                continue;
            }
            let ws_slug = slug_for(&ws.cwd);
            let pdir = base.join(&ws_slug);
            if let Some((p, mtime)) = newest_jsonl(&pdir) {
                let take = match &best {
                    None => true,
                    Some((_, prev, _)) => mtime > *prev,
                };
                if take {
                    best = Some((p, mtime, ws_slug));
                }
            }
        }
        if let Some((p, _, slug)) = best {
            return Some((p, slug));
        }
    }

    // Strategy 3 — basename fallback (legacy): scan every project folder,
    // recover its cwd from a JSONL line, and accept the one whose basename
    // matches the hint. Kept for the case where the workspace index is
    // unavailable (fresh install, permissions error, …).
    let hint_base = Path::new(cwd_hint)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if hint_base.is_empty() {
        return None;
    }

    let mut best: Option<(PathBuf, SystemTime, String)> = None;
    let rd = fs::read_dir(&base).ok()?;
    for project_entry in rd.flatten() {
        let pdir = project_entry.path();
        if !pdir.is_dir() {
            continue;
        }
        let recovered = cwd_from_jsonl(&pdir);
        let folder_name = pdir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let matches = match recovered.as_deref() {
            Some(c) => Path::new(c)
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .map(|b| b == hint_base)
                .unwrap_or(false),
            None => folder_name.to_lowercase().ends_with(&hint_base),
        };
        if !matches {
            continue;
        }
        if let Some((p, mtime)) = newest_jsonl(&pdir) {
            let take = match &best {
                None => true,
                Some((_, prev, _)) => mtime > *prev,
            };
            if take {
                best = Some((p, mtime, folder_name.clone()));
            }
        }
    }
    best.map(|(p, _, slug)| (p, slug))
}

/// Canonicalise a path string for case/separator-insensitive comparison.
/// We intentionally do not call `fs::canonicalize` here — the workspace cwd
/// can refer to a folder that no longer exists on disk and we still want
/// to match it against the user-supplied hint.
fn normalise_path_for_cmp(p: &str) -> String {
    p.trim()
        .trim_end_matches(['/', '\\'])
        .replace('\\', "/")
        .to_lowercase()
}

/// Globally newest JSONL across every project folder.
fn find_global_newest_jsonl() -> Option<(PathBuf, String)> {
    let base = projects_dir()?;
    if !base.exists() {
        return None;
    }
    let mut best: Option<(PathBuf, SystemTime, String)> = None;
    let rd = fs::read_dir(&base).ok()?;
    for project_entry in rd.flatten() {
        let pdir = project_entry.path();
        if !pdir.is_dir() {
            continue;
        }
        let folder_name = pdir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if let Some((p, mtime)) = newest_jsonl(&pdir) {
            let take = match &best {
                None => true,
                Some((_, prev, _)) => mtime > *prev,
            };
            if take {
                best = Some((p, mtime, folder_name.clone()));
            }
        }
    }
    best.map(|(p, _, slug)| (p, slug))
}

// ---------------------------------------------------------------------------
// JSONL parsing — extract topics, files, decisions
// ---------------------------------------------------------------------------

/// Lightweight summary of the last N messages of a session JSONL.
#[derive(Debug, Default)]
pub struct SessionDigest {
    pub topics: Vec<String>,
    pub files: Vec<String>,
    pub decisions: Vec<String>,
    pub last_user_message: Option<String>,
    pub last_assistant_message: Option<String>,
    pub message_count: usize,
}

/// Parse the JSONL file and return a digest covering the last `MAX_MESSAGES`
/// non-empty records. Order-independent: each line is processed in isolation
/// so a malformed line never poisons the rest.
pub fn digest_jsonl(text: &str) -> SessionDigest {
    let mut digest = SessionDigest::default();
    let mut topics_seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut files_seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    // Collect parsed lines first so we can slice the tail without keeping
    // the whole transcript live.
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let total = lines.len();
    let start = total.saturating_sub(MAX_MESSAGES);
    digest.message_count = total;

    for raw in &lines[start..] {
        let v: serde_json::Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let typ = v.get("type").and_then(|x| x.as_str()).unwrap_or("");

        match typ {
            "user" => {
                if let Some(text) = first_text_block(&v) {
                    digest.last_user_message = Some(trim(&text, 220));
                    for kw in extract_topics(&text) {
                        if topics_seen.len() >= MAX_TOPICS {
                            break;
                        }
                        topics_seen.insert(kw);
                    }
                }
            }
            "assistant" => {
                if let Some(text) = first_text_block(&v) {
                    digest.last_assistant_message = Some(trim(&text, 220));
                    if looks_like_decision(&text) && digest.decisions.len() < MAX_DECISIONS {
                        digest.decisions.push(trim(&text, 160));
                    }
                }
                // Also scan tool_use blocks for Edit/Write/MultiEdit targets.
                for path in extract_tool_use_files(&v) {
                    if files_seen.len() >= MAX_FILES {
                        break;
                    }
                    files_seen.insert(path);
                }
            }
            _ => {}
        }
    }

    digest.topics = topics_seen.into_iter().collect();
    digest.files = files_seen.into_iter().collect();
    digest
}

/// Pull the first text-content block out of a message record. Supports the
/// shapes Claude Code emits: string content, single block, multi-block.
fn first_text_block(line: &serde_json::Value) -> Option<String> {
    let msg = line.get("message").unwrap_or(line);
    if let Some(s) = msg.get("content").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
        for block in arr {
            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

/// Scan assistant tool_use blocks for Edit/Write/MultiEdit/NotebookEdit calls
/// and return the file paths they touched. Falls back gracefully when the
/// block shape doesn't match.
fn extract_tool_use_files(line: &serde_json::Value) -> Vec<String> {
    let msg = line.get("message").unwrap_or(line);
    let mut out = Vec::new();
    let Some(arr) = msg.get("content").and_then(|v| v.as_array()) else {
        return out;
    };
    for block in arr {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
            continue;
        }
        let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if !matches!(
            name,
            "Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "Create"
        ) {
            continue;
        }
        let input = match block.get("input") {
            Some(v) => v,
            None => continue,
        };
        // Standard shape: { file_path: "..." }
        if let Some(p) = input.get("file_path").and_then(|v| v.as_str()) {
            out.push(short_path(p));
            continue;
        }
        if let Some(p) = input.get("path").and_then(|v| v.as_str()) {
            out.push(short_path(p));
            continue;
        }
        if let Some(p) = input.get("notebook_path").and_then(|v| v.as_str()) {
            out.push(short_path(p));
        }
    }
    out
}

/// Collapse long absolute paths to "…/parent/file" so the markdown stays
/// readable. Keeps it stable across Windows / POSIX separators.
fn short_path(p: &str) -> String {
    let norm = p.replace('\\', "/");
    let parts: Vec<&str> = norm.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 2 {
        return norm;
    }
    let tail = &parts[parts.len() - 2..];
    format!("…/{}", tail.join("/"))
}

/// Pluck 1-2 keyword topics from a free-form user message. We deliberately
/// keep this rule-based (no LLM call) — it runs inside a Tauri command and
/// must stay fast and offline-safe. Heuristic:
///   * Pick the longest 2 alphabetic words >= 5 chars that aren't stopwords.
fn extract_topics(text: &str) -> Vec<String> {
    let mut words: Vec<&str> = text
        .split(|c: char| !c.is_alphabetic())
        .filter(|w| w.chars().count() >= 5)
        .filter(|w| !is_stopword(w))
        .collect();
    words.sort_by_key(|w| std::cmp::Reverse(w.len()));
    words
        .into_iter()
        .take(2)
        .map(|w| w.to_lowercase())
        .collect()
}

fn is_stopword(w: &str) -> bool {
    matches!(
        w.to_lowercase().as_str(),
        "claude"
            | "porque"
            | "hacer"
            | "tienes"
            | "tienen"
            | "puedes"
            | "puede"
            | "quiero"
            | "necesito"
            | "deberia"
            | "ahora"
            | "después"
            | "antes"
            | "siempre"
            | "nunca"
            | "tambien"
            | "como"
            | "favor"
            | "gracias"
            | "should"
            | "could"
            | "would"
            | "please"
            | "thanks"
            | "really"
            | "actually"
    )
}

fn looks_like_decision(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("decision")
        || lower.contains("decidimos")
        || lower.starts_with("ok")
        || lower.starts_with("hecho")
        || lower.starts_with("listo")
        || lower.contains("voy a ") && lower.contains("implement")
}

fn trim(s: &str, max: usize) -> String {
    let t = s.trim();
    let chars: Vec<char> = t.chars().collect();
    if chars.len() <= max {
        return t.to_string();
    }
    let head: String = chars.into_iter().take(max).collect();
    format!("{}…", head)
}

fn mtime_iso(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let secs = modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(format_iso(secs))
}

/// Convert Unix timestamp (UTC seconds) to ISO 8601 string.
/// Delegates to `chrono` — replaces ~45 LOC hand-rolled calendar (KIRKARDO 16).
fn format_iso(secs: u64) -> String {
    use chrono::{DateTime, Utc};
    let dt = DateTime::<Utc>::from_timestamp(secs as i64, 0)
        .unwrap_or_else(|| DateTime::<Utc>::from_timestamp(0, 0).unwrap());
    dt.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

// ---------------------------------------------------------------------------
// Markdown + prompt rendering
// ---------------------------------------------------------------------------

fn render_summary_md(
    cwd_hint: Option<&str>,
    iso: Option<&str>,
    digest: &SessionDigest,
) -> String {
    let mut out = String::with_capacity(2048);
    out.push_str("## Última sesión\n\n");
    if let Some(c) = cwd_hint {
        out.push_str(&format!("- **Proyecto:** `{}`\n", c));
    }
    if let Some(t) = iso {
        out.push_str(&format!("- **Fecha:** {}\n", t));
    }
    out.push_str(&format!("- **Mensajes analizados:** {}\n", digest.message_count));

    if !digest.topics.is_empty() {
        out.push_str("- **Topics:** ");
        out.push_str(&digest.topics.join(", "));
        out.push('\n');
    }
    if !digest.files.is_empty() {
        out.push_str("- **Files modificados:**\n");
        for f in &digest.files {
            out.push_str(&format!("  - `{}`\n", f));
        }
    }
    if !digest.decisions.is_empty() {
        out.push_str("- **Decisiones:**\n");
        for d in &digest.decisions {
            out.push_str(&format!("  - {}\n", d));
        }
    }
    if let Some(u) = &digest.last_user_message {
        out.push_str("\n### Último mensaje (usuario)\n");
        out.push_str("> ");
        out.push_str(&u.replace('\n', "\n> "));
        out.push('\n');
    }
    if let Some(a) = &digest.last_assistant_message {
        out.push_str("\n### Última respuesta (assistant)\n");
        out.push_str("> ");
        out.push_str(&a.replace('\n', "\n> "));
        out.push('\n');
    }
    out
}

fn render_suggested_prompt(
    cwd_hint: Option<&str>,
    digest: &SessionDigest,
) -> String {
    let topic = digest
        .topics
        .first()
        .cloned()
        .unwrap_or_else(|| "el proyecto".to_string());
    let last_step = digest
        .last_assistant_message
        .as_deref()
        .or(digest.last_user_message.as_deref())
        .map(|s| trim(s, 180))
        .unwrap_or_else(|| "no hay nota explícita del último paso".to_string());

    let files_hint = if digest.files.is_empty() {
        String::new()
    } else {
        format!(" Archivos tocados: {}.", digest.files.join(", "))
    };
    let cwd_hint_str = cwd_hint.map(|c| format!(" ({})", c)).unwrap_or_default();
    format!(
        "Continuamos con {topic}{cwd_hint_str}. Lo último que dejamos: {last_step}.{files_hint} ¿Empezamos por el siguiente paso pendiente?"
    )
}

// ---------------------------------------------------------------------------
// mem0 fallback (optional)
// ---------------------------------------------------------------------------

async fn mem0_fallback(query: &str) -> Option<String> {
    let memories = crate::mem0::search_inner(query.to_string(), None, Some(8))
        .await
        .ok()?;
    if memories.is_empty() {
        return None;
    }
    let mut out = String::from("## Última sesión (vía mem0)\n\n");
    out.push_str("No encontramos JSONL local — esto es lo que mem0 recuerda:\n\n");
    for m in memories.iter().take(8) {
        let text = if m.memory.is_empty() {
            "(sin texto)".to_string()
        } else {
            m.memory.clone()
        };
        out.push_str(&format!("- {}\n", trim(&text, 200)));
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Public entrypoints
// ---------------------------------------------------------------------------

fn resolve_cwd_hint(project_id: Option<&str>, cwd: Option<&str>) -> Option<String> {
    if let Some(c) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(c.to_string());
    }
    let id = project_id?;
    let projects = crate::projects::list_projects_inner().ok()?;
    let p = projects.iter().find(|p| p.id == id)?;
    p.path.clone()
}

pub async fn recall_last_session_inner(
    project_id: Option<String>,
    cwd: Option<String>,
) -> Result<RecallResult, String> {
    let hint = resolve_cwd_hint(project_id.as_deref(), cwd.as_deref());

    let located = match &hint {
        Some(h) => find_session_jsonl(h),
        None => None,
    };

    if let Some((path, _slug)) = located {
        let text = fs::read_to_string(&path)
            .map_err(|e| format!("read jsonl {}: {}", path.display(), e))?;
        let digest = digest_jsonl(&text);
        let iso = mtime_iso(&path);
        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string());
        let summary_md = render_summary_md(hint.as_deref(), iso.as_deref(), &digest);
        let suggested_prompt = render_suggested_prompt(hint.as_deref(), &digest);
        return Ok(RecallResult {
            found: true,
            session_id,
            last_active_iso: iso,
            summary_md,
            suggested_prompt,
            source: "jsonl".to_string(),
        });
    }

    // mem0 fallback when we have at least a cwd hint to search by.
    if let Some(h) = &hint {
        if let Some(md) = mem0_fallback(h).await {
            let prompt = format!(
                "Continuamos con el proyecto en {}. mem0 trae estas memorias recientes; revisemos cuál era el siguiente paso pendiente.",
                h
            );
            return Ok(RecallResult {
                found: true,
                session_id: None,
                last_active_iso: None,
                summary_md: md,
                suggested_prompt: prompt,
                source: "mem0".to_string(),
            });
        }
    }

    Ok(RecallResult {
        found: false,
        session_id: None,
        last_active_iso: None,
        summary_md: "## Última sesión\n\nNo se encontró ninguna sesión previa para este proyecto.".to_string(),
        suggested_prompt: "Empecemos de cero. ¿Cuál es la tarea?".to_string(),
        source: "none".to_string(),
    })
}

pub async fn recall_last_session_global_inner() -> Result<RecallResult, String> {
    let Some((path, slug)) = find_global_newest_jsonl() else {
        return Ok(RecallResult {
            found: false,
            session_id: None,
            last_active_iso: None,
            summary_md: "## Última sesión\n\nNo hay ninguna sesión registrada en `~/.claude/projects/`.".to_string(),
            suggested_prompt: "Empecemos de cero. ¿En qué quieres trabajar?".to_string(),
            source: "none".to_string(),
        });
    };
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("read jsonl {}: {}", path.display(), e))?;
    let digest = digest_jsonl(&text);
    let iso = mtime_iso(&path);
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());

    // Best-effort recovered cwd for display.
    let parent_dir = path.parent().map(|p| p.to_path_buf());
    let cwd_hint = parent_dir
        .as_ref()
        .and_then(cwd_from_jsonl)
        .or(Some(slug));
    let summary_md = render_summary_md(cwd_hint.as_deref(), iso.as_deref(), &digest);
    let suggested_prompt = render_suggested_prompt(cwd_hint.as_deref(), &digest);
    Ok(RecallResult {
        found: true,
        session_id,
        last_active_iso: iso,
        summary_md,
        suggested_prompt,
        source: "jsonl".to_string(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // KIRKARDO 16 — format_iso via chrono

    #[test]
    fn format_iso_epoch() {
        assert_eq!(format_iso(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn format_iso_known_date() {
        // 2026-05-17 00:00:00 UTC
        assert_eq!(format_iso(1778976000), "2026-05-17T00:00:00Z");
    }

    #[test]
    fn format_iso_leap_day() {
        // 2024-02-29 00:00:00 UTC
        assert_eq!(format_iso(1709164800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn format_iso_with_time() {
        // 2026-05-17 13:45:30 UTC = 1778976000 + 49530
        assert_eq!(format_iso(1779025530), "2026-05-17T13:45:30Z");
    }

    // KIRKARDO 16 — fixture-based integration tests

    fn fixture(name: &str) -> String {
        // Delegates to the shared helper (card-test-fixtures-rust-infra).
        crate::test_support::load_fixture("recall", name)
    }

    #[test]
    fn fixture_simple_extracts_files_and_decisions() {
        let d = digest_jsonl(&fixture("session_simple.jsonl"));
        assert_eq!(d.message_count, 5);
        assert!(d.files.iter().any(|f| f.contains("oauth")),
            "expected oauth in files, got {:?}", d.files);
        assert!(!d.decisions.is_empty(), "expected a decision");
        assert!(d.last_user_message.is_some());
        assert!(d.last_assistant_message.is_some());
    }

    #[test]
    fn fixture_malformed_tolerates_bad_lines() {
        let d = digest_jsonl(&fixture("session_malformed.jsonl"));
        assert!(d.message_count <= 4);
        assert!(d.last_assistant_message.is_some(),
            "valid assistant line must still parse");
    }

    #[test]
    fn fixture_decisions_extracts_multiple() {
        let d = digest_jsonl(&fixture("session_decisions.jsonl"));
        assert!(!d.decisions.is_empty());
        assert!(d.files.iter().any(|f| f.contains("webhook")));
    }

    #[test]
    fn recall_error_not_found_message() {
        let e = RecallError::NotFound("mi-proyecto".into());
        assert!(e.to_string().contains("mi-proyecto"));
    }

    #[test]
    fn recall_error_parse_error_message() {
        let e = RecallError::ParseError("bad token at line 3".into());
        assert!(e.to_string().contains("parse error"));
        assert!(e.to_string().contains("line 3"));
    }

    fn make_jsonl() -> String {
        // Two user turns + one assistant turn with a tool_use Edit + a
        // decision-flavoured assistant message.
        let lines = [r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Necesito refactorizar el módulo de autenticación para que soporte OAuth"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"C:/proj/src/auth/oauth.rs"}}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK, hecho. Decisión: usar el flujo PKCE para el cliente desktop."}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Perfecto, ahora añade tests"}]}}"#];
        lines.join("\n")
    }

    #[test]
    fn digest_extracts_topics_files_decisions() {
        let text = make_jsonl();
        let d = digest_jsonl(&text);
        assert_eq!(d.message_count, 4);
        assert!(!d.topics.is_empty(), "expected at least one topic");
        assert!(
            d.files.iter().any(|f| f.contains("oauth.rs")),
            "expected oauth.rs in files, got {:?}",
            d.files
        );
        assert!(
            !d.decisions.is_empty(),
            "expected a decision-style message, got {:?}",
            d.decisions
        );
        assert!(d.last_user_message.is_some());
        assert!(d.last_assistant_message.is_some());
    }

    #[test]
    fn digest_ignores_malformed_lines() {
        let raw = "not json\n{\"type\":\"user\",\"message\":{\"content\":\"hola mundo de prueba largo\"}}";
        let d = digest_jsonl(raw);
        assert_eq!(d.message_count, 2);
        assert!(d.last_user_message.is_some());
    }

    #[test]
    fn slug_for_matches_claude_convention() {
        assert_eq!(
            slug_for("C:\\Users\\USER\\.ultron"),
            "C--Users-USER--ultron"
        );
        assert_eq!(slug_for("/home/foo/bar"), "home-foo-bar");
    }

    #[test]
    fn short_path_collapses_long_paths() {
        assert_eq!(short_path("C:/a/b/c/file.rs"), "…/c/file.rs");
        assert_eq!(short_path("a/b"), "a/b");
    }

    #[test]
    fn render_summary_includes_topics_when_present() {
        let mut d = SessionDigest::default();
        d.topics = vec!["oauth".into(), "tokens".into()];
        d.message_count = 3;
        let md = render_summary_md(Some("C:/proj"), Some("2026-05-26T10:00:00Z"), &d);
        assert!(md.contains("oauth"));
        assert!(md.contains("C:/proj"));
        assert!(md.contains("2026-05-26"));
    }

    #[test]
    fn suggested_prompt_uses_topic_when_available() {
        let mut d = SessionDigest::default();
        d.topics = vec!["refactor".into()];
        d.last_assistant_message = Some("Movimos el handler a auth.rs".into());
        let p = render_suggested_prompt(Some("C:/proj"), &d);
        assert!(p.starts_with("Continuamos con refactor"));
        assert!(p.contains("auth.rs"));
    }
}
