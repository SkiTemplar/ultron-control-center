// ULTRON Control Center — Claude session history.
//
// Surfaces the JSONL transcripts Claude Code stores under
// `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`. The view we
// produce is intentionally lightweight: id, project (the cwd, recovered
// from the folder slug), first user message as preview, byte size,
// timestamps. We don't load the whole transcript — only enough lines to
// extract the preview cheaply.

use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};
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
/// Scans up to 50 lines per file, line by line (a single tool_result line
/// can weigh MB). Returns None if no cwd field is found. A found cwd is
/// cached per project folder: the slug is derived from the cwd, so it
/// never changes.
pub(crate) fn cwd_from_jsonl(project_dir: &PathBuf) -> Option<String> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(cwd) = cache.lock().ok().and_then(|c| c.get(project_dir).cloned()) {
        return Some(cwd);
    }
    let cwd = scan_cwd(project_dir)?;
    if let Ok(mut c) = cache.lock() {
        c.insert(project_dir.clone(), cwd.clone());
    }
    Some(cwd)
}

fn scan_cwd(project_dir: &Path) -> Option<String> {
    let entries = fs::read_dir(project_dir).ok()?;
    entries.flatten().find_map(|entry| {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            return None;
        }
        let f = fs::File::open(&p).ok()?;
        cwd_in(std::io::BufReader::new(f))
    })
}

/// First cwd in the first 50 lines of a transcript.
fn cwd_in(reader: impl BufRead) -> Option<String> {
    reader
        .lines()
        .take(50)
        .map_while(Result::ok)
        .find_map(|line| cwd_of_line(&line))
}

fn cwd_of_line(line: &str) -> Option<String> {
    if line.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(line).ok()?;
    // Try several shapes: top-level cwd, message.cwd, metadata.cwd.
    ["", "message", "metadata"].iter().find_map(|k| {
        let holder = if k.is_empty() {
            Some(&parsed)
        } else {
            parsed.get(*k)
        };
        holder
            .and_then(|h| h.get("cwd"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    })
}

/// Extract the first user message text from a transcript. We deliberately
/// keep the scan bounded — Claude transcripts can grow to many MB and we
/// only need a snippet.
fn extract_first_user_message(path: &PathBuf) -> Option<String> {
    let f = fs::File::open(path).ok()?;
    first_user_in(std::io::BufReader::new(f))
}

/// First user message in the first 200 lines, read lazily: the scan stops
/// at the first `user` line instead of loading 200 lines (tool_result
/// lines weigh MB; the 200 first lines of 917 transcripts were 262 MB).
fn first_user_in(reader: impl BufRead) -> Option<String> {
    reader
        .lines()
        .take(200)
        .map_while(Result::ok)
        .find_map(|line| user_text_of_line(&line))
}

fn user_text_of_line(line: &str) -> Option<String> {
    if line.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(line).ok()?;
    // Claude transcripts look like:
    //   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
    // We tolerate a couple of shapes (string content, single-block, multi-block).
    if parsed.get("type").and_then(|v| v.as_str()) != Some("user") {
        return None;
    }
    let content = parsed.get("message").unwrap_or(&parsed).get("content")?;
    if let Some(s) = content.as_str() {
        return Some(trim_preview(s));
    }
    content.as_array()?.iter().find_map(|block| {
        if block.get("type").and_then(|v| v.as_str()) != Some("text") {
            return None;
        }
        block.get("text").and_then(|v| v.as_str()).map(trim_preview)
    })
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
/// Streams the file and caches the count by (size, mtime): a listing used to
/// read every transcript in full (2+ GB) on each call.
fn count_lines(path: &PathBuf, meta: &fs::Metadata) -> u64 {
    use std::collections::HashMap;
    use std::io::Read;
    use std::sync::{Mutex, OnceLock};
    type Key = (u64, Option<SystemTime>);
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (Key, u64)>>> = OnceLock::new();
    let key: Key = (meta.len(), meta.modified().ok());
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((k, n)) = cache.lock().ok().and_then(|c| c.get(path).copied()) {
        if k == key {
            return n;
        }
    }
    let Ok(mut f) = fs::File::open(path) else {
        return 0;
    };
    let mut buf = vec![0u8; 256 * 1024];
    let mut n = 0u64;
    loop {
        match f.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(read) => n += buf[..read].iter().filter(|b| **b == b'\n').count() as u64,
        }
    }
    if let Ok(mut c) = cache.lock() {
        c.insert(path.clone(), (key, n));
    }
    n
}

/// First `max` lines of a file, reading only what is needed.
#[cfg(test)]
fn first_lines(path: &PathBuf, max: usize) -> Option<Vec<String>> {
    use std::io::{BufRead, BufReader};
    let f = fs::File::open(path).ok()?;
    Some(
        BufReader::new(f)
            .lines()
            .take(max)
            .map_while(Result::ok)
            .collect(),
    )
}

pub fn list_claude_sessions_inner(limit: Option<usize>) -> Result<Vec<ClaudeSession>, String> {
    list_sessions(limit, true, |_, _| true)
}

/// Same listing without `line_count` (always 0), the only field that needs
/// to read each transcript in full. For callers that do not show it.
pub fn list_claude_sessions_light(limit: Option<usize>) -> Result<Vec<ClaudeSession>, String> {
    list_sessions(limit, false, |_, _| true)
}

/// Light listing filtered by `keep(id, cwd)` BEFORE sorting and cutting to
/// `limit`: only the sessions that survive the cut get their preview read.
/// For callers that drop sessions (live ones, other folders) and want the
/// newest N of the rest without opening every transcript.
pub fn list_claude_sessions_light_where(
    limit: Option<usize>,
    keep: impl Fn(&str, &str) -> bool,
) -> Result<Vec<ClaudeSession>, String> {
    list_sessions(limit, false, keep)
}

/// A session file found on disk, before reading anything inside it.
struct Candidate {
    id: String,
    slug: String,
    label: String,
    path: PathBuf,
    meta: fs::Metadata,
}

fn list_sessions(
    limit: Option<usize>,
    with_lines: bool,
    keep: impl Fn(&str, &str) -> bool,
) -> Result<Vec<ClaudeSession>, String> {
    let dir = projects_dir().ok_or_else(|| "no HOME".to_string())?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    list_in(&dir, limit, with_lines, keep, extract_first_user_message)
}

/// Candidates under `dir` that pass `keep`, then sorted, cut and previewed.
fn list_in(
    dir: &Path,
    limit: Option<usize>,
    with_lines: bool,
    keep: impl Fn(&str, &str) -> bool,
    preview: impl Fn(&PathBuf) -> Option<String>,
) -> Result<Vec<ClaudeSession>, String> {
    let found: Vec<Candidate> = candidates(dir)?
        .into_iter()
        .filter(|c| keep(&c.id, &c.label))
        .collect();
    Ok(build_sessions(found, limit, with_lines, preview))
}

/// Sorts by mtime (newest first), cuts to `limit` and only then reads the
/// preview: listing 6 sessions used to read the head of all 917 transcripts.
fn build_sessions(
    mut found: Vec<Candidate>,
    limit: Option<usize>,
    with_lines: bool,
    preview: impl Fn(&PathBuf) -> Option<String>,
) -> Vec<ClaudeSession> {
    found.sort_by_key(|c| std::cmp::Reverse(c.meta.modified().ok()));
    if let Some(n) = limit {
        found.truncate(n);
    }
    found
        .into_iter()
        .map(|c| ClaudeSession {
            preview: preview(&c.path),
            size_bytes: c.meta.len(),
            last_activity: mtime_iso(&c.meta),
            line_count: if with_lines {
                count_lines(&c.path, &c.meta)
            } else {
                0
            },
            id: c.id,
            project_slug: c.slug,
            project_label: c.label,
        })
        .collect()
}

/// Every session file under the projects folder (metadata only).
fn candidates(dir: &Path) -> Result<Vec<Candidate>, String> {
    let mut out = Vec::new();
    for project_entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let slug = project_entry.file_name().to_string_lossy().to_string();
        // v2.5: prefer the cwd recorded inside the JSONL events (authoritative).
        // Fall back to the slug heuristic only when no JSONL carries a cwd.
        let label = cwd_from_jsonl(&project_path).unwrap_or_else(|| unslug(&slug));
        out.extend(project_candidates(&project_path, &slug, &label));
    }
    Ok(out)
}

/// Top-level .jsonl files inside a project folder. We skip
/// `subagents/*.jsonl` because those are not resumable sessions — they're
/// internal records of subagent turns.
fn project_candidates(project_path: &Path, slug: &str, label: &str) -> Vec<Candidate> {
    let Ok(files) = fs::read_dir(project_path) else {
        return Vec::new();
    };
    files
        .map_while(Result::ok)
        .filter_map(|f| {
            let path = f.path();
            let id = session_id_of(&path)?;
            let meta = f.metadata().ok().filter(|m| m.len() > 0)?;
            Some(Candidate {
                id,
                slug: slug.to_string(),
                label: label.to_string(),
                path,
                meta,
            })
        })
        .collect()
}

/// v2.6 (card-v26-fb-004): previous filter required '-' anywhere in the
/// filename AND size >= 100 bytes. Both were too strict — valid sessions
/// disappeared. Now: skip strictly empty files (in the caller) and require
/// the filename to start with a hex char so we don't pick up non-session
/// jsonl logs.
fn session_id_of(path: &Path) -> Option<String> {
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return None;
    }
    let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let id = fname.trim_end_matches(".jsonl");
    let starts_hex = id.chars().next().is_some_and(|c| c.is_ascii_hexdigit());
    starts_hex.then(|| id.to_string())
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
    let sessions = list_claude_sessions_light(None)?;
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

// NOTE (F6 cleanup 2026-06-07): `project_sessions_list` (a never-registered
// Tauri command), its return type `ClaudeSessionSummary`, and the
// `project_slug_for` helper it depended on were removed as dead code. Nothing
// in `generate_handler!` nor the frontend referenced them, and `recall.rs`
// keeps its own inline `slug_for` copy, so there was no remaining consumer.
// If a per-project session list is needed again, build it on top of
// `list_claude_sessions_inner` (which is live and already filters by slug).

#[cfg(test)]
mod lectura_acotada_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn primeras_lineas_y_recuento_cacheado_por_tamano() {
        let dir = tempfile::tempdir().expect("tmp");
        let p = dir.path().join("a.jsonl");
        std::fs::write(&p, "uno\ndos\ntres\n").expect("escribir");
        assert_eq!(first_lines(&p, 2), Some(vec!["uno".into(), "dos".into()]));
        let m = std::fs::metadata(&p).expect("meta");
        assert_eq!(count_lines(&p, &m), 3);
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&p)
            .expect("abrir");
        writeln!(f, "cuatro").expect("añadir");
        let m2 = std::fs::metadata(&p).expect("meta");
        assert_eq!(count_lines(&p, &m2), 4, "otro tamaño invalida la caché");
        assert_eq!(first_lines(&dir.path().join("no"), 2), None);
    }
}

#[cfg(test)]
mod listado_perezoso_tests {
    use super::*;
    use std::cell::RefCell;
    use std::io::{Cursor, Read};
    use std::time::Duration;

    fn user(texto: &str) -> String {
        format!(r#"{{"type":"user","message":{{"role":"user","content":"{texto}"}}}}"#)
    }

    /// 50 transcripts; `s00` es el más antiguo y `s49` el más reciente.
    fn proyecto(dir: &Path) -> PathBuf {
        let proj = dir.join("C--p");
        fs::create_dir_all(&proj).expect("proyecto");
        let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        for i in 0..50u64 {
            let p = proj.join(format!("a{i:02}.jsonl"));
            fs::write(&p, user(&format!("hola {i}")) + "\n").expect("escribir");
            let f = fs::OpenOptions::new().write(true).open(&p).expect("abrir");
            f.set_modified(base + Duration::from_secs(i))
                .expect("mtime");
        }
        proj
    }

    #[test]
    fn con_limite_solo_lee_la_vista_previa_de_las_mas_recientes() {
        let dir = tempfile::tempdir().expect("tmp");
        proyecto(dir.path());
        let leidos = RefCell::new(Vec::new());
        let found = candidates(dir.path()).expect("candidatas");
        assert_eq!(found.len(), 50);
        let out = build_sessions(found, Some(3), false, |p| {
            leidos.borrow_mut().push(p.clone());
            extract_first_user_message(p)
        });
        let ids: Vec<&str> = out.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["a49", "a48", "a47"]);
        assert_eq!(
            leidos.borrow().len(),
            3,
            "abrió transcripts fuera del límite"
        );
        assert_eq!(out[0].preview.as_deref(), Some("hola 49"));
    }

    #[test]
    fn el_filtro_va_antes_del_corte_y_de_la_vista_previa() {
        let dir = tempfile::tempdir().expect("tmp");
        proyecto(dir.path());
        let leidos = RefCell::new(0usize);
        let vivas = ["a49", "a48"];
        let out = list_in(
            dir.path(),
            Some(3),
            false,
            |id, _| !vivas.contains(&id),
            |p| {
                *leidos.borrow_mut() += 1;
                extract_first_user_message(p)
            },
        )
        .expect("listado");
        let ids: Vec<&str> = out.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            ["a47", "a46", "a45"],
            "las filtradas gastaron el límite"
        );
        assert_eq!(
            *leidos.borrow(),
            3,
            "leyó vistas previas de sesiones descartadas"
        );
    }

    #[test]
    fn sin_limite_las_lee_todas_en_orden_de_actividad() {
        let dir = tempfile::tempdir().expect("tmp");
        proyecto(dir.path());
        let found = candidates(dir.path()).expect("candidatas");
        let out = build_sessions(found, None, false, extract_first_user_message);
        assert_eq!(out.len(), 50);
        assert_eq!(out.last().map(|s| s.id.as_str()), Some("a00"));
    }

    /// Lector que revienta si se le pide algo: prueba que la búsqueda no
    /// sigue leyendo tras encontrar la primera línea `user`.
    struct Explota;

    impl Read for Explota {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            panic!("se leyó más allá del primer mensaje de usuario");
        }
    }

    #[test]
    fn la_vista_previa_para_en_el_primer_user() {
        let cabeza = format!("{{\"type\":\"summary\"}}\n{}\n", user("primero"));
        let lector = Cursor::new(cabeza.into_bytes()).chain(std::io::BufReader::new(Explota));
        assert_eq!(first_user_in(lector).as_deref(), Some("primero"));
    }

    #[test]
    fn el_cwd_para_en_la_primera_linea_que_lo_trae() {
        let cabeza = "{\"type\":\"summary\"}\n{\"cwd\":\"C:\\\\p\"}\n";
        let lector =
            Cursor::new(cabeza.as_bytes().to_vec()).chain(std::io::BufReader::new(Explota));
        assert_eq!(cwd_in(lector).as_deref(), Some("C:\\p"));
    }
}
