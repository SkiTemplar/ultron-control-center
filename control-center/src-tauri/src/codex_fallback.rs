// ULTRON Control Center — Codex fallback orchestration.
//
// Purpose: when Claude hits a rate limit mid-task, the user wants a single
// click that spawns a Codex session pre-loaded with enough ULTRON context
// for Codex to continue without re-explanation. This module does NOT spawn
// terminals itself — it only assembles the prompt and delegates the actual
// launch to `crate::sessions::spawn_session_inner`, which owns the wt.exe /
// PowerShell wrapper plumbing.
//
// Context sources (all best-effort, missing files = field is None):
//   - ~/.ultron/.tmp/current-session.json    -> latest session id
//   - ~/.ultron/.tmp/active-task.txt         -> first uncompleted task line
//   - ~/.ultron/.tmp/context.md              -> skill marker + L0 pinned digest
//   - ~/.ultron/.tmp/token-usage.jsonl       -> recent token signals
//   - ~/.ultron/.tmp/doctor-fix-log.jsonl    -> recent doctor signals
//   - %USERPROFILE%\.claude\projects\C--Users-<user>--ultron\*.jsonl
//                                            -> last 20 user/assistant turns
//                                               from the most-recently-touched
//                                               transcript
//
// Token/size budget: prompts are emitted in chars, not tokens. We hard-cap
// each field independently AND apply a global ceiling (PROMPT_GLOBAL_CAP)
// so we don't blow past Codex's effective prompt size even when every
// individual source is at its own limit. Conservative ~50K char cap
// (~12.5K tokens at avg 4 chars/tok) stays well under any Codex CLI
// argument cap and under any reasonable model context budget.

use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Caps (chars, not tokens)
// ---------------------------------------------------------------------------

/// Cap for the conversation tail block. The block is composed of the LAST N
/// messages joined with `---`. We keep the tail (most recent) and truncate
/// the front because the most recent turns matter most for continuation.
const CONVERSATION_TAIL_CAP: usize = 8_000;

/// Cap for the L0 pinned digest extracted from context.md.
/// ~4000 chars approx. matches the "first 400 tokens" instruction in CLAUDE.md.
const L0_PINNED_CAP: usize = 4_000;

/// Cap on the active task line — it's meant to be a one-liner, but defensive.
const ACTIVE_TASK_CAP: usize = 500;

/// Cap on the active skill name — short identifier.
const ACTIVE_SKILL_CAP: usize = 120;

/// How many JSONL lines to read from the tail of each signal file before
/// merging and de-duplicating.
const SIGNAL_TAIL_LINES: usize = 100;

/// Final cap on the conversation_tail block AFTER it's assembled. Mirrors
/// CONVERSATION_TAIL_CAP — kept as a constant so the cap site is obvious.
const CONVERSATION_TAIL_GLOBAL: usize = CONVERSATION_TAIL_CAP;

/// Global ceiling on the final assembled prompt (chars). If the composed
/// prompt exceeds this, we truncate the conversation tail block from the
/// front (keeping the most recent turns) until the total fits. This is the
/// safety net: a runaway transcript shouldn't break Codex's CLI handoff.
const PROMPT_GLOBAL_CAP: usize = 50_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone, Default)]
pub struct FallbackContext {
    /// Latest session id from `~/.ultron/.tmp/current-session.json`.
    pub current_session_id: Option<String>,
    /// First uncompleted task line from `~/.ultron/.tmp/active-task.txt`.
    pub current_task: Option<String>,
    /// Active skill name parsed from `skill=<name>` in context.md.
    pub active_skill: Option<String>,
    /// Top 3 deduped signals (by source) merged from token-usage.jsonl
    /// and doctor-fix-log.jsonl tails.
    pub recent_signals: Vec<String>,
    /// First ~4000 chars of context.md — the L0 pinned digest.
    pub l0_pinned: Option<String>,
    /// Joined tail of user/assistant message bodies from the most recent
    /// Claude transcript. Capped at 8000 chars (tail-preserved).
    pub conversation_tail: Option<String>,
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn ultron_tmp() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron").join(".tmp"))
        .ok_or_else(|| "no HOME".to_string())
}

fn claude_projects_dir() -> Result<PathBuf, String> {
    // Hard-coded project slug — this is the Claude CLI's well-known mangling
    // of `~/.ultron` (the install root). If the user reorganises the ULTRON root
    // we'll need to compute this dynamically, but for now this matches the
    // path the rest of the cockpit assumes (see SYSTEM-MAP.md).
    dirs::home_dir()
        .map(|h| {
            h.join(".claude")
                .join("projects")
                .join("C--Users-<user>--ultron")
        })
        .ok_or_else(|| "no HOME".to_string())
}

// ---------------------------------------------------------------------------
// Individual extractors — each is fault-tolerant.
//
// Convention: every helper returns `Option<T>`, never `Result`. A missing
// file, a permission error, or a malformed entry all collapse to `None`
// so the fallback context still assembles. Errors only bubble up when the
// HOME directory itself is undiscoverable, which is treated as fatal.
// ---------------------------------------------------------------------------

fn read_current_session_id() -> Option<String> {
    let tmp = ultron_tmp().ok()?;
    let path = tmp.join("current-session.json");
    let raw = fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    // The file is a PowerShell-emitted object; the session id lives under
    // "SessionId". Accept "sessionId" as a fallback for any future renames.
    value
        .get("SessionId")
        .or_else(|| value.get("sessionId"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn read_active_task() -> Option<String> {
    let tmp = ultron_tmp().ok()?;
    let path = tmp.join("active-task.txt");
    let raw = fs::read_to_string(&path).ok()?;
    // Pick the first non-empty, non-checked line. Convention: a leading
    // `- [x]` or `[x]` marks a completed task; we skip those. Trim a
    // leading `- [ ]` to recover the task body.
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let lower = t.to_ascii_lowercase();
        if lower.starts_with("- [x]") || lower.starts_with("[x]") || lower.starts_with("x ") {
            continue;
        }
        // Strip common checklist prefixes so the surfaced task reads cleanly
        // inside the Codex prompt.
        let cleaned = t
            .trim_start_matches("- [ ]")
            .trim_start_matches("[ ]")
            .trim_start_matches("- ")
            .trim();
        if cleaned.is_empty() {
            continue;
        }
        return Some(cap_chars(cleaned, ACTIVE_TASK_CAP));
    }
    None
}

fn read_active_skill_from_context_md(context_md: &str) -> Option<String> {
    // Spec: look for a line matching `skill=<name>`. We accept it anywhere
    // on the line (in case it's embedded in a frontmatter-style header)
    // and stop at the first whitespace or comma after the value.
    for line in context_md.lines() {
        if let Some(idx) = line.to_ascii_lowercase().find("skill=") {
            let after = &line[idx + "skill=".len()..];
            let value: String = after
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != ',' && *c != ';')
                .collect();
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
            if !value.is_empty() {
                return Some(cap_chars(value, ACTIVE_SKILL_CAP));
            }
        }
    }
    None
}

fn read_context_md() -> Option<String> {
    let tmp = ultron_tmp().ok()?;
    let path = tmp.join("context.md");
    fs::read_to_string(&path).ok()
}

fn extract_l0_pinned(context_md: &str) -> Option<String> {
    let trimmed = context_md.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(cap_chars(trimmed, L0_PINNED_CAP))
}

/// Read up to `tail_lines` lines from the end of a JSONL file. Returns
/// owned strings; malformed UTF-8 chunks are silently skipped at the
/// per-line `from_utf8_lossy` boundary so a single garbled byte sequence
/// doesn't kill the whole tail.
fn read_jsonl_tail_lines(path: &Path, tail_lines: usize) -> Vec<String> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
    let n = lines.len();
    let start = n.saturating_sub(tail_lines);
    lines[start..].iter().map(|s| s.to_string()).collect()
}

/// Build the top-3 recent signals. We merge tail of token-usage.jsonl
/// with tail of doctor-fix-log.jsonl, sort by timestamp (DESC), and
/// keep the top-3 deduped by "source". A signal's source is:
///   - token-usage: layer (L0/L1/L2)
///   - doctor-fix-log: finding_id
///
/// The shape of each emitted string is intentionally Spanish/short so
/// it embeds well in the Codex prompt block.
fn collect_recent_signals() -> Vec<String> {
    let tmp = match ultron_tmp() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    #[derive(Debug)]
    struct Signal {
        ts: String,
        source: String,
        rendered: String,
    }

    let mut signals: Vec<Signal> = Vec::new();

    // token-usage.jsonl entries look like:
    //   {"ts":"2026-05-15T23:25:52Z","layer":"L0","tokens":32,"limit":200}
    let token_path = tmp.join("token-usage.jsonl");
    for line in read_jsonl_tail_lines(&token_path, SIGNAL_TAIL_LINES) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            let ts = v
                .get("ts")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let layer = v
                .get("layer")
                .and_then(|x| x.as_str())
                .unwrap_or("?")
                .to_string();
            let tokens = v.get("tokens").and_then(|x| x.as_i64()).unwrap_or(0);
            let limit = v.get("limit").and_then(|x| x.as_i64()).unwrap_or(0);
            let rendered = format!("[{}] token-usage {}: {}/{}", ts, layer, tokens, limit);
            signals.push(Signal {
                ts,
                source: format!("token-usage:{}", layer),
                rendered,
            });
        }
    }

    // doctor-fix-log.jsonl entries look like:
    //   {"ts":"...","finding_id":"mcp:gemini:degraded","fix_action":"...","exit_code":0}
    let doctor_path = tmp.join("doctor-fix-log.jsonl");
    for line in read_jsonl_tail_lines(&doctor_path, SIGNAL_TAIL_LINES) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            let ts = v
                .get("ts")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let finding = v
                .get("finding_id")
                .and_then(|x| x.as_str())
                .unwrap_or("?")
                .to_string();
            let action = v
                .get("fix_action")
                .and_then(|x| x.as_str())
                .unwrap_or("?")
                .to_string();
            let exit = v.get("exit_code").and_then(|x| x.as_i64()).unwrap_or(-1);
            let rendered = format!("[{}] doctor {} ({}, exit={})", ts, finding, action, exit);
            signals.push(Signal {
                ts,
                source: format!("doctor:{}", finding),
                rendered,
            });
        }
    }

    // Newest first.
    signals.sort_by(|a, b| match b.ts.cmp(&a.ts) {
        Ordering::Equal => a.source.cmp(&b.source),
        ord => ord,
    });

    // Dedup by source, keep top 3.
    let mut seen: Vec<String> = Vec::new();
    let mut top: Vec<String> = Vec::new();
    for s in signals.into_iter() {
        if seen.iter().any(|x| x == &s.source) {
            continue;
        }
        seen.push(s.source);
        top.push(s.rendered);
        if top.len() >= 3 {
            break;
        }
    }
    top
}

/// Find the .jsonl file with the most recent mtime in the Claude project
/// directory. We do not assume directory order — `fs::read_dir` is filesystem
/// dependent on Windows, so we sort explicitly by mtime DESC.
fn find_latest_transcript() -> Option<PathBuf> {
    let dir = claude_projects_dir().ok()?;
    let entries = fs::read_dir(&dir).ok()?;
    let mut candidates: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        candidates.push((path, mtime));
    }
    candidates.sort_by_key(|b| std::cmp::Reverse(b.1));
    candidates.into_iter().next().map(|(p, _)| p)
}

/// Extract a plain-text body from a parsed JSONL message. The transcript
/// format mixes a few shapes:
///   - user messages: `{"type":"user","message":{"role":"user","content":"..."}}`
///     where content can be a string OR an array of content blocks (tool
///     results, text parts).
///   - assistant messages: `{"type":"assistant","message":{"role":"assistant",
///     "content":[{"type":"text","text":"..."},
///                {"type":"thinking","thinking":"..."},
///                {"type":"tool_use",...}]}}`
///
/// We only surface `text` and `thinking` fragments (skipping tool calls and
/// tool results) so the Codex prompt stays narrative and doesn't drown in
/// tool-call JSON. Returns None when no narrative text is present (e.g.
/// pure tool-use turns).
fn extract_message_text(v: &serde_json::Value) -> Option<String> {
    let msg = v.get("message")?;
    let content = msg.get("content")?;
    if let Some(s) = content.as_str() {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        return Some(t.to_string());
    }
    if let Some(arr) = content.as_array() {
        let mut parts: Vec<String> = Vec::new();
        for block in arr {
            let btype = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
            match btype {
                "text" => {
                    if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                        let t = t.trim();
                        if !t.is_empty() {
                            parts.push(t.to_string());
                        }
                    }
                }
                // Thinking blocks are noisy and largely redacted; we skip
                // them to keep the handoff prompt focused on visible
                // output the user/Claude actually exchanged.
                "thinking" => {}
                // tool_use, tool_result, image, etc. — skip.
                _ => {}
            }
        }
        if parts.is_empty() {
            return None;
        }
        return Some(parts.join("\n"));
    }
    None
}

fn read_conversation_tail() -> Option<String> {
    let path = find_latest_transcript()?;
    let raw = fs::read_to_string(&path).ok()?;
    // Each JSONL line is a single event; we want the LAST 20 user/assistant
    // turns that have actual text content. We scan from the end of the file
    // backwards so very long transcripts don't force us to parse every line.
    let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
    let mut picked: Vec<String> = Vec::new();
    for line in lines.iter().rev() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(x) => x,
            Err(_) => continue,
        };
        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        if let Some(body) = extract_message_text(&v) {
            let role = kind;
            picked.push(format!("[{}] {}", role, body));
            if picked.len() >= 20 {
                break;
            }
        }
    }
    if picked.is_empty() {
        return None;
    }
    // We collected in reverse-chronological order; flip so the prompt reads
    // oldest -> newest, mirroring how a conversation log looks.
    picked.reverse();
    let joined = picked.join("\n---\n");
    Some(cap_chars_keep_tail(&joined, CONVERSATION_TAIL_GLOBAL))
}

// ---------------------------------------------------------------------------
// String cap helpers
// ---------------------------------------------------------------------------

/// Truncate to at most `cap` chars from the FRONT, keeping the head.
/// Used for fields where the start matters (skill name, L0 pinned digest).
fn cap_chars(s: &str, cap: usize) -> String {
    let count = s.chars().count();
    if count <= cap {
        return s.to_string();
    }
    s.chars().take(cap).collect()
}

/// Truncate keeping the LAST `cap` chars. Used for the conversation tail
/// where the most recent messages matter most.
fn cap_chars_keep_tail(s: &str, cap: usize) -> String {
    let count = s.chars().count();
    if count <= cap {
        return s.to_string();
    }
    let skip = count - cap;
    let mut out: String = s.chars().skip(skip).collect();
    // Prefix a sentinel so Codex knows the front was clipped.
    out.insert_str(0, "[…truncado…]\n");
    out
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

pub fn build_fallback_context_inner() -> Result<FallbackContext, String> {
    let context_md_raw = read_context_md();
    let active_skill = context_md_raw
        .as_deref()
        .and_then(read_active_skill_from_context_md);
    let l0_pinned = context_md_raw.as_deref().and_then(extract_l0_pinned);

    Ok(FallbackContext {
        current_session_id: read_current_session_id(),
        current_task: read_active_task(),
        active_skill,
        recent_signals: collect_recent_signals(),
        l0_pinned,
        conversation_tail: read_conversation_tail(),
    })
}

/// Compose the single-string Codex prompt. Each optional block is omitted
/// entirely (not "header + empty") when its source is None, so the final
/// prompt scales with how much context is actually available.
pub fn build_fallback_prompt_inner() -> Result<String, String> {
    let ctx = build_fallback_context_inner()?;
    let mut out = String::new();
    out.push_str("Continuando trabajo desde sesión Claude rate-limited.\n");

    if let Some(skill) = ctx.active_skill.as_deref() {
        out.push_str("\n[SKILL ACTIVA]\n");
        out.push_str(skill);
        out.push('\n');
    }

    if let Some(task) = ctx.current_task.as_deref() {
        out.push_str("\n[TAREA ACTUAL]\n");
        out.push_str(task);
        out.push('\n');
    }

    if let Some(session) = ctx.current_session_id.as_deref() {
        // Sessions get a tiny block of their own — useful for Codex when
        // it needs to refer back to a specific Claude transcript by id.
        out.push_str("\n[SESIÓN ANTERIOR]\n");
        out.push_str(session);
        out.push('\n');
    }

    if !ctx.recent_signals.is_empty() {
        out.push_str("\n[SEÑALES RECIENTES]\n");
        for s in ctx.recent_signals.iter() {
            out.push_str("- ");
            out.push_str(s);
            out.push('\n');
        }
    }

    if let Some(l0) = ctx.l0_pinned.as_deref() {
        out.push_str("\n[CONTEXTO L0 (pinned)]\n");
        out.push_str(l0);
        out.push('\n');
    }

    if let Some(tail) = ctx.conversation_tail.as_deref() {
        out.push_str("\n[ÚLTIMAS INTERACCIONES]\n");
        out.push_str(tail);
        out.push('\n');
    }

    out.push_str(
        "\nPor favor toma el relevo. Mantén el mismo tono y nivel de detalle. \
         NO repitas lo ya hecho; continúa donde se dejó.\n",
    );

    // Final safety belt: if the assembled prompt is gigantic (rare but
    // possible with very long transcripts), truncate the [ÚLTIMAS
    // INTERACCIONES] block from the front. We do this by re-clipping the
    // whole prompt from the tail so the closing instructions survive.
    if out.chars().count() > PROMPT_GLOBAL_CAP {
        out = cap_chars_keep_tail(&out, PROMPT_GLOBAL_CAP);
    }
    Ok(out)
}

/// Public entry for the "launch Codex with context" command. Returns the
/// provider name (always "codex") on success so the UI can show a confirmation
/// toast that matches the spawn-session command's shape.
pub async fn launch_codex_fallback_inner(
    app: &tauri::AppHandle,
    cwd: Option<String>,
) -> Result<String, String> {
    let prompt = build_fallback_prompt_inner()?;
    // Hand off to the existing sessions plumbing — we deliberately do NOT
    // duplicate the wt.exe / spawn-claude-session.ps1 logic. This keeps the
    // fallback path consistent with regular "new session" launches and
    // means improvements to spawn_session_inner (logging, retries, flag
    // validation) automatically apply here.
    let result =
        crate::sessions::spawn_session_inner(app, "codex".to_string(), Some(prompt), cwd, None)
            .await?;
    Ok(result.provider)
}

// ---------------------------------------------------------------------------
// Tauri commands
//
// Kept thin: each command just forwards to the corresponding `_inner` fn.
// This mirrors the convention in sessions.rs / mcps.rs / etc. so wiring in
// lib.rs is mechanical.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn build_fallback_context() -> Result<FallbackContext, String> {
    build_fallback_context_inner()
}

#[tauri::command]
pub async fn build_fallback_prompt() -> Result<String, String> {
    build_fallback_prompt_inner()
}

#[tauri::command]
pub async fn launch_codex_fallback(
    app: tauri::AppHandle,
    cwd: Option<String>,
) -> Result<String, String> {
    launch_codex_fallback_inner(&app, cwd).await
}

// ---------------------------------------------------------------------------
// Unit tests — pure functions only, no filesystem.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_line_parsed() {
        let md = "header\nfoo skill=senior-engineer bar\nrest\n";
        assert_eq!(
            read_active_skill_from_context_md(md),
            Some("senior-engineer".to_string())
        );
    }

    #[test]
    fn skill_line_missing_returns_none() {
        let md = "header\nno marker here\n";
        assert_eq!(read_active_skill_from_context_md(md), None);
    }

    #[test]
    fn cap_keep_tail_preserves_end() {
        let s: String = "0123456789".chars().collect();
        let capped = cap_chars_keep_tail(&s, 4);
        // Sentinel prefix + last 4 chars.
        assert!(capped.contains("6789"));
        assert!(capped.starts_with("[…truncado…]"));
    }

    #[test]
    fn cap_keep_tail_no_op_when_under_cap() {
        let s = "short";
        assert_eq!(cap_chars_keep_tail(s, 100), "short");
    }

    #[test]
    fn extract_text_from_string_content() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"type":"user","message":{"role":"user","content":"hola mundo"}}"#,
        )
        .unwrap();
        assert_eq!(extract_message_text(&v), Some("hola mundo".to_string()));
    }

    #[test]
    fn extract_text_from_array_content() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"content":[
                {"type":"thinking","thinking":"hidden"},
                {"type":"text","text":"visible"},
                {"type":"tool_use","name":"x"}
            ]}}"#,
        )
        .unwrap();
        assert_eq!(extract_message_text(&v), Some("visible".to_string()));
    }

    #[test]
    fn extract_text_skips_tool_only_turn() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"content":[
                {"type":"tool_use","name":"x"}
            ]}}"#,
        )
        .unwrap();
        assert_eq!(extract_message_text(&v), None);
    }
}
