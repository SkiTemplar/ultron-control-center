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
        map.insert(key, CacheEntry { items, inserted_at: Instant::now() });
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
    // For skills we want SKILL.md hits only (a real skill is always a
    // directory containing SKILL.md). For agents we ask for any .md under
    // .claude/agents.
    let q = match kind {
        LibraryKind::Skill => format!("SKILL.md path:{} {}", kind_path, query),
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

    let output = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("gh").args(&args).output()
    })
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
                    if !h.path.ends_with("/SKILL.md") && h.path != "SKILL.md" {
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
                        .rsplitn(3, '/')
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
                    // parent of SKILL.md
                    h.path
                        .rsplitn(3, '/')
                        .nth(1)
                        .unwrap_or("")
                        .to_string()
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
    let output = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("gh").args(&args).output()
    })
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
    let cleaned: String = resp.content.chars().filter(|c| !c.is_whitespace()).collect();
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
            resolve_skill_dir(&name, target_scope, target_project_id.as_deref())?
                .join("SKILL.md")
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
    let target = resolve_agent_target(
        &spec.name,
        target_scope,
        target_project_id.as_deref(),
    )?;
    if target.exists() {
        return Err(format!("agent already exists: {}", target.display()));
    }
    let mut fm = String::new();
    fm.push_str("---\n");
    fm.push_str(&format!("name: {}\n", spec.name));
    fm.push_str(&format!("description: {}\n", yaml_string(&spec.description)));
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
    fm.push_str(&format!("description: {}\n", yaml_string(&spec.description)));
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
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
}

fn yaml_string(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
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
