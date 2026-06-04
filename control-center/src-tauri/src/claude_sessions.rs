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
    let secs = modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_secs();
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

/// Recover the original cwd from Claude's slugified folder name. Claude
/// sanitises any non-alphanumeric character to `-`, so multiple non-alnum
/// chars in a row collapse to multiple dashes. The mapping we apply on the
/// way back:
///
/// * The FIRST `--` is the drive separator `:\\` (e.g. `C--` -> `C:\\`).
/// * Subsequent `--` are `\\.` — almost always a hidden directory like
///   `.ultron`, `.claude`, etc. Losing that dot was the root cause of the
///   "No conversation found with session ID" error: Claude's resume command
///   re-slugifies the cwd and compares folder names, so missing dots made
///   the comparison miss.
/// * A single `-` is a plain path separator `\\`.
fn unslug(slug: &str) -> String {
    let mut out = String::with_capacity(slug.len() + 4);
    let bytes = slug.as_bytes();
    let mut i = 0;
    let mut first_double_seen = false;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            if !first_double_seen {
                out.push(':');
                out.push('\\');
                first_double_seen = true;
            } else {
                out.push('\\');
                out.push('.');
            }
            i += 2;
        } else if bytes[i] == b'-' {
            out.push('\\');
            i += 1;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

/// v2.5: Read the cwd from the first JSONL line that carries one. Claude
/// Code transcripts log the working directory in event metadata; reading
/// it back is far more reliable than reverse-engineering the slug.
/// Scans up to 50 lines per file. Returns None if no cwd field is found.
pub(crate) fn cwd_from_jsonl(project_dir: &PathBuf) -> Option<String> {
    let entries = fs::read_dir(project_dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let text = match fs::read_to_string(&p) {
            Ok(t) => t,
            Err(_) => continue,
        };
        for line in text.lines().take(50) {
            if line.is_empty() {
                continue;
            }
            let parsed: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // Try several shapes: top-level cwd, message.cwd, metadata.cwd.
            if let Some(cwd) = parsed.get("cwd").and_then(|v| v.as_str()) {
                return Some(cwd.to_string());
            }
            if let Some(cwd) = parsed
                .get("message")
                .and_then(|m| m.get("cwd"))
                .and_then(|v| v.as_str())
            {
                return Some(cwd.to_string());
            }
            if let Some(cwd) = parsed
                .get("metadata")
                .and_then(|m| m.get("cwd"))
                .and_then(|v| v.as_str())
            {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Extract the first user message text from a transcript. We deliberately
/// keep the scan bounded — Claude transcripts can grow to many MB and we
/// only need a snippet.
fn extract_first_user_message(path: &PathBuf) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    // Bounded scan — first 200 lines is plenty to find an initial user
    // message even in a transcript that begins with system metadata.
    for line in content.lines().take(200) {
        if line.is_empty() {
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Claude transcripts look like:
        //   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
        // We tolerate a couple of shapes (string content, single-block, multi-block).
        let typ = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if typ != "user" {
            continue;
        }
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
        // v2.5: prefer the cwd recorded inside the JSONL events (authoritative).
        // Fall back to the slug heuristic only when no JSONL carries a cwd.
        let label = cwd_from_jsonl(&project_path).unwrap_or_else(|| unslug(&slug));

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
            // v2.6 (card-v26-fb-004): previous filter required '-' anywhere
            // in the filename AND size >= 100 bytes. Both were too strict
            // — valid sessions disappeared. Now: skip strictly empty files
            // and require the filename to start with a hex char so we
            // don't pick up non-session jsonl logs.
            let id = fname.trim_end_matches(".jsonl").to_string();
            if id.is_empty() {
                continue;
            }
            if !id
                .chars()
                .next()
                .map(|c| c.is_ascii_hexdigit())
                .unwrap_or(false)
            {
                continue;
            }
            let meta = match f.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() == 0 {
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
    // v2.5.2 (fb-046): diagnostic so we can see at a glance how many
    // sessions and unique workspaces the backend returned. Debug-only.
    #[cfg(debug_assertions)]
    {
        let mut slugs: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for s in &out {
            slugs.insert(s.project_slug.as_str());
        }
        eprintln!(
            "[claude_sessions::list_claude_sessions_inner] sessions={} workspaces={} limit={:?}",
            out.len(),
            slugs.len(),
            limit
        );
    }
    if let Some(n) = limit {
        out.truncate(n);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Workspace-level aggregation — "Recent workspaces" view
// ---------------------------------------------------------------------------
//
// The Sessions tab redesign reframes the page as a workspace picker. The
// existing `list_claude_sessions_inner` returns one entry per JSONL file,
// which is useful for the power-user "All sessions" list but too verbose
// for the headline grid. `list_workspaces_inner` collapses sessions by
// folder (one slot per unique cwd) and pre-computes the aggregates the
// frontend cards need: latest activity, session count, newest session id
// (for one-click Continue), and the original cwd recovered from the slug.
//
// When a workspace cwd matches a registered project (`projects.json`), we
// enrich the entry with `project_id` and `project_name` so the UI can show
// the friendly label; otherwise the raw cwd stands in.

#[derive(Debug, Serialize, Clone)]
pub struct WorkspaceSummary {
    /// Absolute cwd recovered from Claude's folder slug. Used both for
    /// display (mono font, truncated) and as the `cwd` arg for spawning
    /// a fresh session in this workspace.
    pub cwd: String,
    /// Id from `projects.json` when the cwd matches a registered entry.
    pub project_id: Option<String>,
    /// Display name from `projects.json`. Falls back to None when the
    /// workspace is not registered; the frontend then renders the cwd
    /// tail as the headline.
    pub project_name: Option<String>,
    /// ISO 8601 mtime of the most recently touched session JSONL in
    /// this workspace. Sort key for the recent-workspaces grid.
    pub last_activity: Option<String>,
    /// How many session JSONL files live under this workspace folder.
    pub session_count: u32,
    /// UUID of the newest session — the "Continue last session" button
    /// passes this as `resumeId` to `spawn_session`.
    pub latest_session_id: Option<String>,
    /// Nearest ancestor directory that contains a `.git/` folder, when it
    /// is different from `cwd`. Lets the UI offer "Use git root" when the
    /// user launched Claude inside a subfolder (e.g. `.ultron/control-center`
    /// rather than `.ultron`). `None` when `cwd` itself is the git root or
    /// no ancestor has `.git/`. Fixes the long-standing "Sessions opens the
    /// subfolder instead of the project root" friction without rewriting
    /// the slug resolution.
    pub git_root: Option<String>,
}

/// Walk up from `cwd` looking for a `.git/` directory. Returns the path of
/// the first ancestor that contains `.git/` (NOT `cwd` itself when `cwd` is
/// already the root — we want to surface only the case where a workspace
/// lives below a git root). Returns `None` when nothing found within 8
/// levels (deep enough for any sane repo layout, bounded so a broken
/// symlink loop can't hang the call).
fn find_git_root_above(cwd: &str) -> Option<String> {
    let path = std::path::PathBuf::from(cwd);
    // Decision: when the cwd no longer exists on disk (project deleted,
    // drive unmounted, network share down) we return None instead of
    // walking the literal parent — the workspace card hides the "Use git
    // root" affordance because acting on it would fail anyway.
    if !path.exists() {
        return None;
    }
    let mut current = path.parent()?.to_path_buf();
    // Cycle-detection set guards against adversarial symlinks where
    // `parent()` can return a path already visited (KIRKARDO 3 MED).
    // The 8-level bound is kept as a defense-in-depth ceiling.
    let mut seen: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();
    for _ in 0..8 {
        if !seen.insert(current.clone()) {
            // Already visited this exact path — symlink loop, abort.
            return None;
        }
        if current.join(".git").is_dir() {
            return Some(current.to_string_lossy().into_owned());
        }
        match current.parent() {
            Some(p) => current = p.to_path_buf(),
            None => break,
        }
    }
    None
}

pub fn list_workspaces_inner() -> Result<Vec<WorkspaceSummary>, String> {
    let sessions = list_claude_sessions_inner(None)?;
    if sessions.is_empty() {
        return Ok(Vec::new());
    }

    // Cross-reference with the project registry up front (one read for the
    // whole batch) so we can enrich every workspace without re-parsing
    // projects.json per entry.
    let projects = crate::projects::list_projects_inner().unwrap_or_default();

    use std::collections::HashMap;
    let mut by_cwd: HashMap<String, WorkspaceSummary> = HashMap::new();

    for s in sessions.into_iter() {
        let key = s.project_label.clone();
        let entry = by_cwd
            .entry(key.clone())
            .or_insert_with(|| WorkspaceSummary {
                cwd: s.project_label.clone(),
                project_id: None,
                project_name: None,
                last_activity: None,
                session_count: 0,
                latest_session_id: None,
                git_root: None,
            });
        entry.session_count = entry.session_count.saturating_add(1);
        // Sessions arrive sorted newest-first from `list_claude_sessions_inner`,
        // so the first one we see per workspace is the latest.
        if entry.latest_session_id.is_none() {
            entry.latest_session_id = Some(s.id.clone());
            entry.last_activity = s.last_activity.clone();
        }
    }

    // Enrich with project metadata when the cwd lines up with a registered
    // entry. We normalise both sides — Claude's recovered label uses `\\`
    // separators on Windows, and projects.json paths usually match, but we
    // compare case-insensitively to defend against drive-letter casing.
    for ws in by_cwd.values_mut() {
        let needle = ws.cwd.replace('/', "\\").to_lowercase();
        if let Some(matched) = projects.iter().find(|p| {
            p.path
                .as_deref()
                .map(|pp| pp.replace('/', "\\").to_lowercase() == needle)
                .unwrap_or(false)
        }) {
            ws.project_id = Some(matched.id.clone());
            ws.project_name = matched.name.clone().or_else(|| Some(matched.id.clone()));
        }
        // Detect the nearest ancestor git root. We deliberately ignore the
        // case where `cwd` itself contains `.git/` — the UI only needs to
        // act when the session was launched inside a subfolder of a git
        // repo (.ultron/control-center → .ultron, etc.).
        ws.git_root = find_git_root_above(&ws.cwd);
    }

    let mut out: Vec<WorkspaceSummary> = by_cwd.into_values().collect();
    // Most recently active workspace first — same sort key the frontend
    // would compute anyway, but doing it server-side keeps the UI dumb.
    out.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    Ok(out)
}

// ---- P4: per-project sessions listing ----

#[derive(Debug, Serialize, Clone)]
pub struct ClaudeSessionSummary {
    pub session_id: String,
    pub path: String,
    pub modified_at: String,
    pub first_user_message: Option<String>,
}

pub(crate) fn project_slug_for(path: &str) -> String {
    // Claude Code mangles project paths into directory names by replacing
    // ANY non-alphanumeric character with `-`. This means `:`, `\`, `/`, and
    // `.` all become `-`, so consecutive non-alnum runs collapse to multiple
    // dashes:
    //   "C:\Users\USER\.ultron" -> "C--Users-USER--ultron"
    //                                  ^^         ^^
    //                                  ":\\"      "\\."
    //
    // v2.5.2 (fb-046 fix): previous implementation only replaced `\` and `/`,
    // producing `C:-Users-USER-.ultron` which did NOT match Claude's
    // folder name, so the Sessions sub-tab found zero sessions for the
    // active project. Now we mirror Claude's own rule: every non-alnum
    // char becomes `-`. Trailing/leading dashes are trimmed to be safe.
    let mut out = String::with_capacity(path.len() + 4);
    for ch in path.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    // Some users register paths with a trailing separator (`C:\Users\X\`).
    // After translation that leaves a trailing `-` which would never match
    // the on-disk folder. Trim just the edges, never the middle (we need
    // the doubles to survive).
    out.trim_matches('-').to_string()
}

#[tauri::command]
pub async fn project_sessions_list(
    project_path: String,
) -> Result<Vec<ClaudeSessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
        let slug = project_slug_for(&project_path);
        let dir = home.join(".claude").join("projects").join(&slug);
        // v2.5.2 (fb-046): diagnostic logging so we can see exactly which
        // path translation the backend chose. Only emitted in debug builds
        // to keep release logs quiet.
        #[cfg(debug_assertions)]
        eprintln!(
            "[claude_sessions::project_sessions_list] project_path={:?} slug={:?} dir={:?} exists={}",
            project_path,
            slug,
            dir,
            dir.exists()
        );
        if !dir.exists() {
            return Ok::<Vec<ClaudeSessionSummary>, String>(vec![]);
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("read dir: {e}"))? {
            let entry = entry.map_err(|e| format!("entry: {e}"))?;
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let session_id = p
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let meta = entry.metadata().map_err(|e| format!("metadata: {e}"))?;
            let modified_at = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| format!("epoch:{}", d.as_secs()))
                .unwrap_or_else(|| "unknown".to_string());
            let first_user_message = extract_first_user_message(&p);
            out.push(ClaudeSessionSummary {
                session_id,
                path: p.display().to_string(),
                modified_at,
                first_user_message,
            });
        }
        out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
