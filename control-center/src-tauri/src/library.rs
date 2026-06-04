//! Control Center 2.0 — Agent + Skill library (P5).
//!
//! - GitHub search via `gh search code` (user's authenticated token).
//! - Install from GitHub via `gh api repos/<owner>/<repo>/contents/<path>`
//!   (returns base64-encoded content + `name`/`path`).
//! - In-app creation: build frontmatter from struct + write atomically.
//! - Per-project pinning: JSON list at
//!   `~/.ultron/cockpit/projects/<id>/pinned-agents.json` (shared with the
//!   P4 `agents_pinned_*` commands).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteItem {
    pub owner: String,
    pub repo: String,
    pub path: String,
    pub name: String,
    pub html_url: Option<String>,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LibraryKind {
    Agent,
    Skill,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TargetScope {
    Global,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PinnedAgents {
    pub pinned: Vec<String>,
}

// ---------------------------------------------------------------------------
// `gh` subprocess helper — Windows-only CREATE_NO_WINDOW flag
// ---------------------------------------------------------------------------
//
// Plain `std::process::Command::new("gh")` on Windows flashes a console
// window for the lifetime of the subprocess, which USER flagged as
// annoying in v2.5.1 ("se lanza una terminal que no se quita"). Setting
// `CREATE_NO_WINDOW` (0x0800_0000) keeps the spawn fully invisible.

fn gh_command(args: &[String]) -> std::process::Command {
    let mut cmd = std::process::Command::new("gh");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

// ---------------------------------------------------------------------------
// Search cache (10-min TTL, in-memory)
// ---------------------------------------------------------------------------

struct CacheEntry {
    items: Vec<RemoteItem>,
    inserted_at: Instant,
}

static CACHE: Mutex<Option<HashMap<String, CacheEntry>>> = Mutex::new(None);
const CACHE_TTL: Duration = Duration::from_secs(600);

fn cache_get(key: &str) -> Option<Vec<RemoteItem>> {
    let mut guard = CACHE.lock().ok()?;
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(entry) = map.get(key) {
        if entry.inserted_at.elapsed() < CACHE_TTL {
            return Some(entry.items.clone());
        }
    }
    None
}

fn cache_put(key: String, items: Vec<RemoteItem>) {
    if let Ok(mut guard) = CACHE.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(
            key,
            CacheEntry {
                items,
                inserted_at: Instant::now(),
            },
        );
    }
}

// ---------------------------------------------------------------------------
// GitHub search via `gh search code`
// ---------------------------------------------------------------------------

pub async fn search_github_inner(
    query: String,
    kind: LibraryKind,
    limit: u32,
) -> Result<Vec<RemoteItem>, String> {
    let kind_path = match kind {
        LibraryKind::Agent => ".claude/agents",
        LibraryKind::Skill => ".claude/skills",
    };
    let cache_key = format!("{}:{}", kind_path, query);
    if let Some(cached) = cache_get(&cache_key) {
        return Ok(cached);
    }

    // gh CLI v2.x dropped the `name` field from `gh search code --json`.
    // Available fields are now: path, repository, sha, textMatches, url.
    // We derive the display name from the basename of `path`.
    //
    // GitHub code search treats the FIRST token as the keyword and the
    // rest as qualifiers. Putting `SKILL.md` before `path:` returns 0
    // results because GitHub indexes "SKILL.md" as a filename, not a
    // body token. The user-supplied query MUST come first so the rest
    // of the line works as qualifiers — verified manually via
    //   gh search code "tdd path:.claude/skills" → 5 hits
    //   gh search code "SKILL.md path:.claude/skills tdd" → []
    //
    // Post-filtering happens below (per-kind path/extension assertions),
    // so we don't lose precision by loosening the query.
    let q = match kind {
        LibraryKind::Skill => format!("{} path:{}", query, kind_path),
        LibraryKind::Agent => format!("{} path:{} extension:md", query, kind_path),
    };
    let limit_str = limit.clamp(1, 100).to_string();
    let args: Vec<String> = vec![
        "search".into(),
        "code".into(),
        q,
        "--json".into(),
        "repository,path,url".into(),
        "--limit".into(),
        limit_str,
    ];

    let output = tauri::async_runtime::spawn_blocking(move || gh_command(&args).output())
        .await
        .map_err(|e| format!("spawn join: {e}"))?
        .map_err(|e| format!("gh search code failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh exited {}: {}", output.status, stderr));
    }

    #[derive(Deserialize)]
    struct GhRepo {
        #[serde(rename = "nameWithOwner")]
        name_with_owner: String,
    }
    #[derive(Deserialize)]
    struct GhHit {
        repository: GhRepo,
        path: String,
        url: Option<String>,
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let hits: Vec<GhHit> =
        serde_json::from_str(&stdout).map_err(|e| format!("gh json parse: {e}"))?;

    let items: Vec<RemoteItem> = hits
        .into_iter()
        .filter_map(|h| {
            // Strict filter per kind: skill hits MUST be a SKILL.md file
            // (anything else is a false positive — README.md, docs/, etc.).
            // Agent hits MUST be a .md file directly under an `agents/`
            // segment (not nested README/docs).
            match kind {
                LibraryKind::Skill => {
                    // Accept three shapes (verified on real repos):
                    //   .claude/skills/<name>/SKILL.md   ← canonical
                    //   .claude/skills/<name>.md         ← flat file
                    //   .claude/skills/<name>/README.md  ← occasional
                    let p = &h.path;
                    let is_skill_md = p.ends_with("/SKILL.md") || p == "SKILL.md";
                    let is_readme_under_skills = p.contains(".claude/skills/")
                        && p.to_ascii_lowercase().ends_with("/readme.md");
                    let is_flat_skill = {
                        // .claude/skills/<name>.md (parent dir literally "skills").
                        let parent_is_skills = p
                            .rsplit('/')
                            .nth(1)
                            .map(|seg| seg == "skills")
                            .unwrap_or(false);
                        parent_is_skills && p.ends_with(".md")
                    };
                    if !(is_skill_md || is_readme_under_skills || is_flat_skill) {
                        return None;
                    }
                }
                LibraryKind::Agent => {
                    if !h.path.ends_with(".md") {
                        return None;
                    }
                    // The file's parent dir must literally be `agents`
                    // (i.e. <repo>/.claude/agents/<name>.md). Skips
                    // `.claude/agents/README.md` rejection too — README is
                    // not a kebab-case agent slug downstream anyway.
                    let parent_is_agents = h
                        .path
                        .rsplit('/')
                        .nth(1)
                        .map(|seg| seg == "agents")
                        .unwrap_or(false);
                    if !parent_is_agents {
                        return None;
                    }
                    let bn = h.path.rsplit('/').next().unwrap_or("");
                    if bn.eq_ignore_ascii_case("readme.md") {
                        return None;
                    }
                }
            }

            let (owner, repo) = {
                let mut it = h.repository.name_with_owner.splitn(2, '/');
                let o = it.next()?.to_string();
                let r = it.next()?.to_string();
                (o, r)
            };
            // Derive a human name from the path:
            //   .claude/skills/foo/SKILL.md  -> "foo"
            //   .claude/agents/foo.md        -> "foo"
            let name = match kind {
                LibraryKind::Skill => {
                    let bn = h.path.rsplit('/').next().unwrap_or("");
                    let bn_lc = bn.to_ascii_lowercase();
                    if bn_lc == "skill.md" || bn_lc == "readme.md" {
                        // Folder-style: <name>/SKILL.md → parent dir is the name.
                        h.path.rsplit('/').nth(1).unwrap_or("").to_string()
                    } else {
                        // Flat file: <name>.md → stem of the basename.
                        bn.trim_end_matches(".md").to_string()
                    }
                }
                LibraryKind::Agent => h
                    .path
                    .rsplit('/')
                    .next()
                    .unwrap_or("")
                    .trim_end_matches(".md")
                    .to_string(),
            };
            if name.is_empty() {
                return None;
            }
            Some(RemoteItem {
                owner,
                repo,
                path: h.path,
                name,
                html_url: h.url,
                preview: None,
            })
        })
        .collect();

    cache_put(cache_key, items.clone());
    Ok(items)
}

// ---------------------------------------------------------------------------
// Install from GitHub
// ---------------------------------------------------------------------------

pub async fn install_from_github_inner(
    owner: String,
    repo: String,
    path: String,
    kind: LibraryKind,
    target_scope: TargetScope,
    target_project_id: Option<String>,
    target_name: Option<String>,
    overwrite: bool,
) -> Result<PathBuf, String> {
    let endpoint = format!("repos/{}/{}/contents/{}", owner, repo, path);
    let args: Vec<String> = vec!["api".into(), endpoint];
    let output = tauri::async_runtime::spawn_blocking(move || gh_command(&args).output())
        .await
        .map_err(|e| format!("spawn join: {e}"))?
        .map_err(|e| format!("gh api failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh api exited {}: {}", output.status, stderr));
    }

    #[derive(Deserialize)]
    struct ContentResp {
        content: String,
        encoding: String,
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let resp: ContentResp =
        serde_json::from_str(&stdout).map_err(|e| format!("gh api json: {e}"))?;
    if resp.encoding != "base64" {
        return Err(format!("unexpected encoding: {}", resp.encoding));
    }
    // GitHub wraps base64 with newlines every 60 chars.
    let cleaned: String = resp
        .content
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let bytes = base64_decode(&cleaned)?;
    let body = String::from_utf8(bytes).map_err(|e| format!("not utf-8: {e}"))?;

    // Derive final name + target path.
    let name = target_name.unwrap_or_else(|| {
        path.rsplit('/')
            .next()
            .unwrap_or("")
            .trim_end_matches(".md")
            .trim_end_matches("/SKILL")
            .to_string()
    });
    if !is_kebab(&name) {
        return Err(format!("invalid name (must be kebab-case): {name}"));
    }

    // Skills go under <root>/skills/<name>/SKILL.md; agents under <root>/agents/<name>.md.
    let target = match kind {
        LibraryKind::Agent => {
            resolve_agent_target(&name, target_scope, target_project_id.as_deref())?
        }
        LibraryKind::Skill => {
            resolve_skill_dir(&name, target_scope, target_project_id.as_deref())?.join("SKILL.md")
        }
    };

    if target.exists() && !overwrite {
        return Err(format!("already exists: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }
    atomic_write_bytes(&target, body.as_bytes())?;
    Ok(target)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))
}

// ---------------------------------------------------------------------------
// In-app create (agent + skill)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct AgentCreateSpec {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub tools: Vec<String>,
    pub model: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SkillCreateSpec {
    pub name: String,
    pub description: String,
    pub body: String,
}

pub fn agent_create_inner(
    spec: AgentCreateSpec,
    target_scope: TargetScope,
    target_project_id: Option<String>,
) -> Result<PathBuf, String> {
    if !is_kebab(&spec.name) {
        return Err(format!("invalid name (must be kebab-case): {}", spec.name));
    }
    let target = resolve_agent_target(&spec.name, target_scope, target_project_id.as_deref())?;
    if target.exists() {
        return Err(format!("agent already exists: {}", target.display()));
    }
    let mut fm = String::new();
    fm.push_str("---\n");
    fm.push_str(&format!("name: {}\n", spec.name));
    fm.push_str(&format!(
        "description: {}\n",
        yaml_string(&spec.description)
    ));
    if !spec.tools.is_empty() {
        let arr: Vec<String> = spec.tools.iter().map(|t| format!("\"{}\"", t)).collect();
        fm.push_str(&format!("tools: [{}]\n", arr.join(", ")));
    }
    if let Some(m) = &spec.model {
        if !m.is_empty() {
            fm.push_str(&format!("model: {}\n", m));
        }
    }
    fm.push_str("---\n\n");
    fm.push_str(&spec.body);
    if !fm.ends_with('\n') {
        fm.push('\n');
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }
    atomic_write_bytes(&target, fm.as_bytes())?;
    Ok(target)
}

pub fn skill_create_inner(
    spec: SkillCreateSpec,
    target_scope: TargetScope,
    target_project_id: Option<String>,
) -> Result<PathBuf, String> {
    if !is_kebab(&spec.name) {
        return Err(format!("invalid name (must be kebab-case): {}", spec.name));
    }
    let dir = resolve_skill_dir(&spec.name, target_scope, target_project_id.as_deref())?;
    let target = dir.join("SKILL.md");
    if target.exists() {
        return Err(format!("skill already exists: {}", target.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let mut fm = String::new();
    fm.push_str("---\n");
    fm.push_str(&format!("name: {}\n", spec.name));
    fm.push_str(&format!(
        "description: {}\n",
        yaml_string(&spec.description)
    ));
    fm.push_str("---\n\n");
    fm.push_str(&spec.body);
    if !fm.ends_with('\n') {
        fm.push('\n');
    }
    atomic_write_bytes(&target, fm.as_bytes())?;
    Ok(target)
}

// ---------------------------------------------------------------------------
// Per-project pinning (shared layout with P4 `agents_pinned_*`).
// ---------------------------------------------------------------------------

fn pinned_path(project_id: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home
        .join(".ultron")
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("pinned-agents.json"))
}

pub fn pinned_load(project_id: &str) -> Result<PinnedAgents, String> {
    let p = pinned_path(project_id)?;
    if !p.exists() {
        return Ok(PinnedAgents::default());
    }
    let txt = std::fs::read_to_string(&p).map_err(|e| format!("read pinned: {e}"))?;
    Ok(serde_json::from_str::<PinnedAgents>(&txt).unwrap_or_default())
}

pub fn pinned_save(project_id: &str, pa: &PinnedAgents) -> Result<(), String> {
    let p = pinned_path(project_id)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let body = serde_json::to_vec_pretty(pa).map_err(|e| format!("ser: {e}"))?;
    atomic_write_bytes(&p, &body)
}

pub fn pin_agent_inner(project_id: &str, slug: &str) -> Result<PinnedAgents, String> {
    let mut pa = pinned_load(project_id)?;
    if !pa.pinned.iter().any(|s| s == slug) {
        pa.pinned.push(slug.to_string());
        pinned_save(project_id, &pa)?;
    }
    Ok(pa)
}

pub fn unpin_agent_inner(project_id: &str, slug: &str) -> Result<PinnedAgents, String> {
    let mut pa = pinned_load(project_id)?;
    pa.pinned.retain(|s| s != slug);
    pinned_save(project_id, &pa)?;
    Ok(pa)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn claude_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home.join(".claude"))
}

fn project_root(project_id: &str) -> Result<PathBuf, String> {
    let projects = crate::projects::list_projects_inner()?;
    projects
        .into_iter()
        .find(|p| p.id == project_id)
        .and_then(|p| p.path.map(PathBuf::from))
        .ok_or_else(|| format!("project not found or has no path: {project_id}"))
}

fn resolve_agent_target(
    name: &str,
    scope: TargetScope,
    project_id: Option<&str>,
) -> Result<PathBuf, String> {
    let base = match scope {
        TargetScope::Global => claude_root()?,
        TargetScope::Project => {
            let pid = project_id
                .ok_or_else(|| "target_project_id required for project scope".to_string())?;
            project_root(pid)?.join(".claude")
        }
    };
    Ok(base.join("agents").join(format!("{}.md", name)))
}

fn resolve_skill_dir(
    name: &str,
    scope: TargetScope,
    project_id: Option<&str>,
) -> Result<PathBuf, String> {
    let base = match scope {
        TargetScope::Global => claude_root()?,
        TargetScope::Project => {
            let pid = project_id
                .ok_or_else(|| "target_project_id required for project scope".to_string())?;
            project_root(pid)?.join(".claude")
        }
    };
    Ok(base.join("skills").join(name))
}

fn is_kebab(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
}

fn yaml_string(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{}\"", escaped)
}

/// tmp + rename atomic write — same discipline as the rest of the
/// crate (see `projects::atomic_write`).
fn atomic_write_bytes(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = target.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, target).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// AI-driven install (v2.9.5 — P1 Library>Catalog)
//
// Flow:
//   1. Clone repo to temp dir  (~/.ultron/cockpit/temp-install/<sanitized>/)
//   2. Read README.md + manifests + SKILL.md / plugin.json
//   3. Build prompt with repo content + current stack context
//   4. Call ai_router::route("code-review", prompt) → JSON report
//   5. Parse report: if compatible=false → return early with warnings
//   6. Execute steps + copy files (unless dry_run=true)
//   7. Cleanup temp dir + return AiInstallResult
//
// Fallback: if the AI Router has no usable provider, the command returns
// `AiInstallResult { ai_available: false, report: None, … }` and the UI
// shows the "copy URL" fallback path.
// ---------------------------------------------------------------------------

/// One shell step returned by the AI analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallStep {
    pub cmd: String,
    /// Working directory — may use `~` which the executor expands.
    pub cwd: String,
}

/// One file copy returned by the AI analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopyFile {
    /// Path relative to the cloned temp directory.
    pub from: String,
    /// Absolute target path (may use `~` which the executor expands).
    pub to: String,
}

/// Structured report that the AI must produce (strict JSON).
/// Unknown fields are ignored (`deny_unknown_fields` is deliberately absent
/// so future AI models can add extra fields without breaking the parser).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallReport {
    pub compatible: bool,
    /// Human-readable rationale for the compatibility decision.
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub steps: Vec<InstallStep>,
    #[serde(default)]
    pub copy_files: Vec<CopyFile>,
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Detected install type: "agent", "skill", "rules", "mcp", "npm",
    /// "cargo", "python", "unknown".
    #[serde(default = "default_install_type")]
    pub install_type: String,
}

fn default_install_type() -> String {
    "unknown".to_string()
}

/// Final result returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiInstallResult {
    /// Whether the AI router was reachable and produced a report.
    pub ai_available: bool,
    /// The AI-generated report (None when ai_available=false).
    pub report: Option<InstallReport>,
    /// Whether we actually executed the install (false when dry_run=true
    /// or compatible=false).
    pub executed: bool,
    /// Paths of files that were copied during the install.
    #[serde(default)]
    pub installed_paths: Vec<String>,
    /// Combined warnings + execution errors surfaced to the UI.
    #[serde(default)]
    pub errors: Vec<String>,
}

/// Extract the repo `owner/name` slug from a GitHub URL.
/// Accepts:
///   https://github.com/owner/repo
///   https://github.com/owner/repo.git
///   github.com/owner/repo
fn parse_github_slug(url: &str) -> Option<(String, String)> {
    let stripped = url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("github.com/");
    let parts: Vec<&str> = stripped.splitn(3, '/').collect();
    if parts.len() < 2 {
        return None;
    }
    let owner = parts[0].to_string();
    let repo = parts[1].trim_end_matches(".git").to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

/// Sanitise a repo name to a filesystem-safe directory component.
fn sanitize_dir_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Expand a leading `~` to the user's home directory.
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

/// Clone a GitHub repo using `gh repo clone`.
fn clone_repo(owner: &str, repo: &str, dest: &Path) -> Result<(), String> {
    let slug = format!("{}/{}", owner, repo);
    let dest_str = dest.to_string_lossy().to_string();
    let mut cmd = std::process::Command::new("gh");
    cmd.args(["repo", "clone", &slug, &dest_str]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("gh repo clone: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("gh repo clone failed: {stderr}"));
    }
    Ok(())
}

/// Read a file from disk, capping at `max_bytes` to avoid flooding the prompt.
fn read_capped(path: &Path, max_bytes: usize) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let truncated = if bytes.len() > max_bytes {
        &bytes[..max_bytes]
    } else {
        &bytes[..]
    };
    Some(String::from_utf8_lossy(truncated).into_owned())
}

/// Collect relevant files from the cloned repo into a single context string.
///
/// Reads the usual top-level manifests/READMEs PLUS, for deep skill/agent
/// repos, the nested `.claude/skills/<name>/SKILL.md` and `.claude/agents/*.md`
/// (and a bare top-level `skills/`/`agents/` layout) so the AI analysis sees
/// the actual skill/agent definitions instead of only the README. Without
/// this, a repo whose payload lives entirely under `.claude/skills/*/SKILL.md`
/// looked empty to the analyzer and got mis-classified.
fn collect_repo_context(repo_dir: &Path) -> String {
    let candidates = [
        "README.md",
        "readme.md",
        "SKILL.md",
        "plugin.json",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "setup.py",
        "LICENSE",
        "INSTALL.md",
        "CONTRIBUTING.md",
    ];
    let mut parts: Vec<String> = Vec::new();
    for name in &candidates {
        let p = repo_dir.join(name);
        if let Some(content) = read_capped(&p, 8_000) {
            parts.push(format!("=== {} ===\n{}", name, content));
        }
    }

    // Nested skill definitions: <root>/.claude/skills/<name>/SKILL.md and a
    // bare <root>/skills/<name>/SKILL.md fallback. Cap the number of nested
    // files surfaced so a mega-repo can't blow up the prompt.
    for skills_root in [
        repo_dir.join(".claude").join("skills"),
        repo_dir.join("skills"),
    ] {
        collect_nested_skill_mds(&skills_root, &mut parts);
    }

    // Nested agent definitions: <root>/.claude/agents/*.md and <root>/agents/*.md.
    for agents_root in [
        repo_dir.join(".claude").join("agents"),
        repo_dir.join("agents"),
    ] {
        collect_nested_agent_mds(&agents_root, &mut parts);
    }

    if parts.is_empty() {
        "<no recognisable files found>".to_string()
    } else {
        parts.join("\n\n")
    }
}

/// Max nested skill/agent files surfaced into the analysis prompt. Keeps a
/// huge multi-skill repo from flooding the context window.
const MAX_NESTED_FILES: usize = 12;

/// Read each `<root>/<name>/SKILL.md`, appending up to `MAX_NESTED_FILES`
/// entries to `parts`. No-op when `root` is not a directory.
fn collect_nested_skill_mds(root: &Path, parts: &mut Vec<String>) {
    if !root.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if parts.len() >= MAX_NESTED_FILES {
            break;
        }
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let skill_md = dir.join("SKILL.md");
        if let Some(content) = read_capped(&skill_md, 4_000) {
            let label = dir.file_name().and_then(|s| s.to_str()).unwrap_or("skill");
            parts.push(format!("=== skills/{}/SKILL.md ===\n{}", label, content));
        }
    }
}

/// Read each `<root>/*.md` agent file, appending up to `MAX_NESTED_FILES`
/// entries to `parts`. No-op when `root` is not a directory.
fn collect_nested_agent_mds(root: &Path, parts: &mut Vec<String>) {
    if !root.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if parts.len() >= MAX_NESTED_FILES {
            break;
        }
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if fname.eq_ignore_ascii_case("README.md") {
            continue;
        }
        if let Some(content) = read_capped(&p, 4_000) {
            parts.push(format!("=== agents/{} ===\n{}", fname, content));
        }
    }
}

/// Pick the strongest available zone for the install-compatibility analysis.
///
/// The original code always routed to `code-review`, which seeds to a Light
/// (Haiku) zone — fine for quick lint passes, weak for reasoning about whether
/// an arbitrary repo is safe to install. We prefer a `code-edit` zone when it
/// exists (it seeds to a Medium codex/gpt-5 assignment), falling back to
/// `code-review` and finally to the literal `"code-review"` id when zone
/// listing fails entirely. Selection is by *configured* zones so a user who
/// reconfigured their router still gets a valid id.
fn pick_analysis_zone() -> String {
    // Strongest first. `code-edit` is Medium-class in the seed; `code-review`
    // is the safe Light-class default we keep as a fallback.
    const PREFERRED: [&str; 2] = ["code-edit", "code-review"];
    match crate::ai_router::ai_router_list_zones() {
        Ok(zones) => {
            for id in PREFERRED {
                if zones.iter().any(|z| z.id == id) {
                    return id.to_string();
                }
            }
            // No preferred zone configured — fall back to the first zone in
            // the `code` category if any, else the literal default.
            zones
                .iter()
                .find(|z| z.category == "code")
                .map(|z| z.id.clone())
                .unwrap_or_else(|| "code-review".to_string())
        }
        Err(_) => "code-review".to_string(),
    }
}

/// Read the user's current stack context from CLAUDE.md + detectable manifests.
fn collect_stack_context() -> String {
    let mut parts: Vec<String> = Vec::new();

    // Global CLAUDE.md
    if let Some(home) = dirs::home_dir() {
        let claude_md = home.join(".claude").join("CLAUDE.md");
        if let Some(content) = read_capped(&claude_md, 3_000) {
            parts.push(format!(
                "=== ~/.claude/CLAUDE.md (current stack) ===\n{}",
                content
            ));
        }
    }

    parts.join("\n\n")
}

/// Build the analysis prompt sent to the AI router.
fn build_analysis_prompt(repo_context: &str, stack_context: &str) -> String {
    format!(
        r#"You are a developer-tools install assistant. Analyse the repository below and \
decide whether it is compatible with the user's current stack.

Return ONLY a single JSON object — no markdown, no extra text — with this exact shape:
{{
  "compatible": <true|false>,
  "reason": "<one sentence explaining the decision>",
  "install_type": "<agent|skill|rules|mcp|npm|cargo|python|unknown>",
  "steps": [
    {{"cmd": "<shell command to run>", "cwd": "<working directory, may use ~>"}}
  ],
  "copy_files": [
    {{"from": "<path relative to repo root>", "to": "<absolute target path, may use ~>"}}
  ],
  "warnings": ["<optional warning messages>"]
}}

Rules:
- "steps" should only include commands that are safe and reproducible (npm install, cargo add, pip install, cp, etc.)
- "copy_files" should map agent .md files to ~/.claude/agents/, skill files to ~/.claude/skills/<name>/, rules to ~/.claude/rules/, hooks to ~/.claude/hooks/
- If the repo is incompatible (wrong language, missing deps, dangerous code), set compatible=false and explain in "reason"
- Keep "steps" and "copy_files" empty if there is nothing safe to execute
- Do NOT include git clone or cd steps — the repo is already cloned

=== CURRENT USER STACK ===
{stack_context}

=== REPOSITORY TO ANALYSE ===
{repo_context}
"#
    )
}

/// Parse the AI's raw text response into an `InstallReport`, tolerating
/// markdown code fences and leading/trailing noise.
fn parse_ai_report(raw: &str) -> Result<InstallReport, String> {
    // Strip optional ```json … ``` fences.
    let stripped = {
        let s = raw.trim();
        let s = if let Some(inner) = s.strip_prefix("```json") {
            inner.trim_start()
        } else if let Some(inner) = s.strip_prefix("```") {
            inner.trim_start()
        } else {
            s
        };
        let s = if let Some(inner) = s.strip_suffix("```") {
            inner.trim_end()
        } else {
            s
        };
        s
    };

    // Find the first `{` and last `}` to isolate the JSON object.
    let start = stripped
        .find('{')
        .ok_or_else(|| "no JSON object in AI response".to_string())?;
    let end = stripped
        .rfind('}')
        .ok_or_else(|| "no closing } in AI response".to_string())?;
    let json_slice = &stripped[start..=end];

    serde_json::from_str::<InstallReport>(json_slice).map_err(|e| {
        format!(
            "AI report parse error: {e}\nRaw slice: {}",
            &json_slice[..json_slice.len().min(400)]
        )
    })
}

/// Execute the install steps from the report. Returns a list of errors
/// (non-fatal — we proceed with remaining steps and report all failures).
fn execute_steps(steps: &[InstallStep]) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    for step in steps {
        let cwd = expand_tilde(&step.cwd);
        // Shell-split the command naively: first token is the program, rest
        // are args. For complex commands (pipes, &&) we fall back to
        // spawning via `sh -c` on Unix or `cmd /C` on Windows.
        let needs_shell = step.cmd.contains("&&")
            || step.cmd.contains("|")
            || step.cmd.contains(";")
            || step.cmd.contains(">>")
            || step.cmd.contains(">");

        let result = if needs_shell {
            #[cfg(windows)]
            let mut cmd = {
                let mut c = std::process::Command::new("cmd");
                c.args(["/C", &step.cmd]);
                c
            };
            #[cfg(not(windows))]
            let mut cmd = {
                let mut c = std::process::Command::new("sh");
                c.args(["-c", &step.cmd]);
                c
            };
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            cmd.current_dir(&cwd).output()
        } else {
            let tokens: Vec<&str> = step.cmd.split_whitespace().collect();
            if tokens.is_empty() {
                continue;
            }
            let mut cmd = std::process::Command::new(tokens[0]);
            cmd.args(&tokens[1..]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            cmd.current_dir(&cwd).output()
        };

        match result {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                errors.push(format!(
                    "step `{}` exited {}: {}",
                    step.cmd,
                    out.status,
                    stderr.trim()
                ));
            }
            Err(e) => {
                errors.push(format!("step `{}` spawn error: {e}", step.cmd));
            }
        }
    }
    errors
}

/// Copy files from the cloned repo to target paths.
/// Returns (installed_paths, errors).
fn execute_copies(repo_dir: &Path, copies: &[CopyFile]) -> (Vec<String>, Vec<String>) {
    let mut installed: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for copy in copies {
        let from = repo_dir.join(&copy.from);
        let to = expand_tilde(&copy.to);

        // Security: reject absolute `from` paths that escape the repo dir.
        if copy.from.starts_with('/') || copy.from.starts_with('\\') || copy.from.contains("..") {
            errors.push(format!("rejected unsafe from-path: {}", copy.from));
            continue;
        }

        if !from.exists() {
            errors.push(format!("source not found: {}", from.display()));
            continue;
        }

        if let Some(parent) = to.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                errors.push(format!("mkdir {}: {e}", parent.display()));
                continue;
            }
        }

        let copy_result = if from.is_dir() {
            copy_dir_recursive(&from, &to)
        } else {
            std::fs::copy(&from, &to)
                .map(|_| ())
                .map_err(|e| format!("copy {} → {}: {e}", from.display(), to.display()))
        };

        match copy_result {
            Ok(()) => installed.push(to.display().to_string()),
            Err(e) => errors.push(e),
        }
    }

    (installed, errors)
}

/// Recursively copy a directory.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("readdir {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let ty = entry.file_type().map_err(|e| format!("filetype: {e}"))?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path).map_err(|e| format!("copy: {e}"))?;
        }
    }
    Ok(())
}

/// Main entry point for AI-driven install.
pub async fn install_via_ai_inner(
    repo_url: String,
    _target_scope: TargetScope,
    dry_run: bool,
) -> Result<AiInstallResult, String> {
    // --- Step 1: parse GitHub URL ---
    let (owner, repo_name) = parse_github_slug(&repo_url)
        .ok_or_else(|| format!("could not parse GitHub URL: {repo_url}"))?;

    // --- Step 2: prepare temp dir ---
    let temp_base = ultron_root()?.join("cockpit").join("temp-install");
    let dir_name = format!(
        "{}-{}",
        sanitize_dir_name(&owner),
        sanitize_dir_name(&repo_name)
    );
    let temp_dir = temp_base.join(&dir_name);

    // Remove stale temp dir from a previous failed install, if any.
    if temp_dir.exists() {
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("create temp dir: {e}"))?;

    // --- Step 3: clone ---
    if let Err(e) = clone_repo(&owner, &repo_name, &temp_dir) {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(e);
    }

    // --- Step 4: collect context ---
    let repo_context = collect_repo_context(&temp_dir);
    let stack_context = collect_stack_context();
    let prompt = build_analysis_prompt(&repo_context, &stack_context);

    // --- Step 5: call AI router ---
    // Route to the strongest available analysis zone (code-edit > code-review)
    // so the compatibility judgement uses a stronger model when one exists.
    let analysis_zone = pick_analysis_zone();
    let ai_text = match crate::ai_router::route(&analysis_zone, &prompt) {
        Ok(text) => text,
        Err(router_err) => {
            // Fallback: AI not available — return without a report so the
            // UI can offer the clipboard fallback.
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Ok(AiInstallResult {
                ai_available: false,
                report: None,
                executed: false,
                installed_paths: vec![],
                errors: vec![format!("AI Router unavailable: {router_err}")],
            });
        }
    };

    // --- Step 6: parse report ---
    let report = match parse_ai_report(&ai_text) {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Err(format!(
                "AI response could not be parsed as InstallReport: {e}"
            ));
        }
    };

    // --- Step 7: abort if incompatible ---
    if !report.compatible {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Ok(AiInstallResult {
            ai_available: true,
            report: Some(report),
            executed: false,
            installed_paths: vec![],
            errors: vec![],
        });
    }

    // --- Step 8: dry-run returns here with the plan but doesn't execute ---
    if dry_run {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Ok(AiInstallResult {
            ai_available: true,
            report: Some(report),
            executed: false,
            installed_paths: vec![],
            errors: vec![],
        });
    }

    // --- Step 9: execute steps + copies ---
    let step_errors = execute_steps(&report.steps);
    let (installed_paths, copy_errors) = execute_copies(&temp_dir, &report.copy_files);

    let _ = std::fs::remove_dir_all(&temp_dir);

    let mut all_errors: Vec<String> = step_errors;
    all_errors.extend(copy_errors);
    all_errors.extend(report.warnings.clone());

    Ok(AiInstallResult {
        ai_available: true,
        report: Some(report),
        executed: true,
        installed_paths,
        errors: all_errors,
    })
}

fn ultron_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron"))
        .ok_or_else(|| "No HOME dir".to_string())
}

#[cfg(test)]
mod ai_install_tests {
    use super::*;

    #[test]
    fn parse_github_slug_standard_url() {
        let (o, r) = parse_github_slug("https://github.com/foo/bar-baz").unwrap();
        assert_eq!(o, "foo");
        assert_eq!(r, "bar-baz");
    }

    #[test]
    fn parse_github_slug_git_suffix() {
        let (o, r) = parse_github_slug("https://github.com/foo/bar.git").unwrap();
        assert_eq!(r, "bar");
    }

    #[test]
    fn parse_github_slug_rejects_invalid() {
        assert!(parse_github_slug("not-a-url").is_none());
        assert!(parse_github_slug("https://github.com/onlyone").is_none());
    }

    #[test]
    fn sanitize_dir_name_replaces_dots_and_slashes() {
        assert_eq!(sanitize_dir_name("foo.bar/baz"), "foo_bar_baz");
    }

    #[test]
    fn parse_ai_report_valid_json() {
        let raw = r#"{"compatible":true,"reason":"ok","steps":[],"copy_files":[],"warnings":[],"install_type":"agent"}"#;
        let r = parse_ai_report(raw).unwrap();
        assert!(r.compatible);
        assert_eq!(r.install_type, "agent");
    }

    #[test]
    fn parse_ai_report_strips_markdown_fence() {
        let raw =
            "```json\n{\"compatible\":false,\"reason\":\"nope\",\"install_type\":\"unknown\"}\n```";
        let r = parse_ai_report(raw).unwrap();
        assert!(!r.compatible);
    }

    #[test]
    fn parse_ai_report_tolerates_trailing_prose() {
        let raw = "Here is the analysis:\n{\"compatible\":true,\"reason\":\"fine\",\"install_type\":\"skill\"}\nDone.";
        let r = parse_ai_report(raw).unwrap();
        assert!(r.compatible);
    }

    #[test]
    fn expand_tilde_home() {
        let p = expand_tilde("~/foo/bar");
        assert!(p.to_string_lossy().contains("foo"));
        assert!(!p.to_string_lossy().starts_with('~'));
    }

    #[test]
    fn collect_repo_context_reads_nested_skill_and_agent_files() {
        // Build a temp repo whose payload lives ONLY in nested
        // .claude/skills/<name>/SKILL.md and .claude/agents/<name>.md — the
        // exact deep layout the old top-level-only reader missed.
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();

        let skill_dir = root.join(".claude").join("skills").join("my-skill");
        std::fs::create_dir_all(&skill_dir).expect("mkdir skill");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: my-skill\ndescription: nested skill payload\n---\nBODY",
        )
        .expect("write skill md");

        let agents_dir = root.join(".claude").join("agents");
        std::fs::create_dir_all(&agents_dir).expect("mkdir agents");
        std::fs::write(
            agents_dir.join("my-agent.md"),
            "---\nname: my-agent\ndescription: nested agent payload\n---\nROLE",
        )
        .expect("write agent md");
        // README under agents must be skipped.
        std::fs::write(agents_dir.join("README.md"), "ignore me").expect("write readme");

        let ctx = collect_repo_context(root);
        assert!(
            ctx.contains("skills/my-skill/SKILL.md"),
            "nested skill should be surfaced: {ctx}"
        );
        assert!(ctx.contains("nested skill payload"));
        assert!(
            ctx.contains("agents/my-agent.md"),
            "nested agent should be surfaced: {ctx}"
        );
        assert!(ctx.contains("nested agent payload"));
        assert!(
            !ctx.contains("ignore me"),
            "agents/README.md must be skipped"
        );
    }

    #[test]
    fn pick_analysis_zone_returns_nonempty() {
        // Must always return a usable zone id (never empty) even if the
        // router config is missing on the test box.
        let zone = pick_analysis_zone();
        assert!(!zone.is_empty());
    }
}
