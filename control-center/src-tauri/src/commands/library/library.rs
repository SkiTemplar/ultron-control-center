//! P5 — Agent/Skill library Tauri command wrappers.
//! v2.1 — also surfaces the curated catalog (`cockpit/curated-catalog.json`)
//! that powers the Library -> Catalog sub-tab.

use crate::library;
use crate::ultron_root;

/// Raw JSON payload of `~/.ultron/cockpit/curated-catalog.json`. Returned
/// as a `serde_json::Value` so the schema can evolve in the file without
/// requiring a backend recompile — the frontend tolerates unknown keys.
#[tauri::command]
pub fn read_curated_catalog() -> Result<serde_json::Value, String> {
    let path = ultron_root()?.join("cockpit").join("curated-catalog.json");
    if !path.exists() {
        // Empty schema: frontend renders the "no domains" empty state and
        // a "create a catalog" hint instead of crashing.
        return Ok(serde_json::json!({
            "schema_version": 1,
            "updated_at": null,
            "domains": []
        }));
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("parse curated-catalog.json: {e}"))
}

#[tauri::command]
pub async fn library_search_github(
    query: String,
    kind: library::LibraryKind,
    limit: Option<u32>,
) -> Result<Vec<library::RemoteItem>, String> {
    let lim = limit.unwrap_or(30);
    library::search_github_inner(query, kind, lim).await
}

#[derive(serde::Deserialize)]
pub struct InstallArgs {
    pub owner: String,
    pub repo: String,
    pub path: String,
    pub kind: library::LibraryKind,
    pub target_scope: library::TargetScope,
    pub target_project_id: Option<String>,
    pub target_name: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[tauri::command]
pub async fn library_install_from_github(args: InstallArgs) -> Result<String, String> {
    let p = library::install_from_github_inner(
        args.owner,
        args.repo,
        args.path,
        args.kind,
        args.target_scope,
        args.target_project_id,
        args.target_name,
        args.overwrite,
    )
    .await?;
    Ok(p.display().to_string())
}

#[derive(serde::Deserialize)]
pub struct AgentCreateArgs {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub tools: Vec<String>,
    pub model: Option<String>,
    pub body: String,
    pub target_scope: library::TargetScope,
    pub target_project_id: Option<String>,
}

#[tauri::command]
pub fn agent_create(args: AgentCreateArgs) -> Result<String, String> {
    let spec = library::AgentCreateSpec {
        name: args.name,
        description: args.description,
        tools: args.tools,
        model: args.model,
        body: args.body,
    };
    let p = library::agent_create_inner(spec, args.target_scope, args.target_project_id)?;
    Ok(p.display().to_string())
}

#[derive(serde::Deserialize)]
pub struct SkillCreateArgs {
    pub name: String,
    pub description: String,
    pub body: String,
    pub target_scope: library::TargetScope,
    pub target_project_id: Option<String>,
}

#[tauri::command]
pub fn skill_create(args: SkillCreateArgs) -> Result<String, String> {
    let spec = library::SkillCreateSpec {
        name: args.name,
        description: args.description,
        body: args.body,
    };
    let p = library::skill_create_inner(spec, args.target_scope, args.target_project_id)?;
    Ok(p.display().to_string())
}

#[tauri::command]
pub fn library_pin_agent(
    project_id: String,
    agent_slug: String,
) -> Result<library::PinnedAgents, String> {
    library::pin_agent_inner(&project_id, &agent_slug)
}

#[tauri::command]
pub fn library_unpin_agent(
    project_id: String,
    agent_slug: String,
) -> Result<library::PinnedAgents, String> {
    library::unpin_agent_inner(&project_id, &agent_slug)
}

#[tauri::command]
pub fn library_list_pinned(project_id: String) -> Result<library::PinnedAgents, String> {
    library::pinned_load(&project_id)
}

// ---------------------------------------------------------------------------
// Catalog refresh — fetch the first paragraph of each item's source file
// from GitHub raw and return them keyed by `owner/repo/path`. The frontend
// merges these into the static seed summaries so the cards show fresh
// upstream wording on every Catalog mount. Failures are reported per-item;
// the global call never errors out.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct CatalogPreview {
    pub key: String,
    pub summary: Option<String>,
    pub error: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct CatalogPreviewRequest {
    pub owner: String,
    pub repo: String,
    pub path: String,
    /// Optional branch override; defaults to `main` and falls back to `master`.
    #[serde(default)]
    pub branch: Option<String>,
}

#[tauri::command]
pub async fn catalog_fetch_previews(
    items: Vec<CatalogPreviewRequest>,
) -> Result<Vec<CatalogPreview>, String> {
    let client = reqwest::Client::builder()
        .user_agent("ultron-control-center/2.0 (catalog-preview)")
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;

    // Sequential fetches keep deps minimal (no `futures` crate). Catalog
    // is small (<50 items) and the per-request timeout caps total runtime.
    let mut out: Vec<CatalogPreview> = Vec::with_capacity(items.len());
    for req in items {
        let key = format!("{}/{}/{}", req.owner, req.repo, req.path);
        let branches: Vec<String> = match req.branch {
            Some(b) if !b.is_empty() => vec![b],
            _ => vec!["main".to_string(), "master".to_string()],
        };
        let mut last_err: Option<String> = None;
        let mut summary: Option<String> = None;
        for branch in &branches {
            let url = format!(
                "https://raw.githubusercontent.com/{}/{}/{}/{}",
                req.owner, req.repo, branch, req.path
            );
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => match resp.text().await {
                    Ok(body) => {
                        summary = Some(extract_summary(&body));
                        last_err = None;
                        break;
                    }
                    Err(e) => last_err = Some(format!("body: {e}")),
                },
                Ok(resp) => last_err = Some(format!("http {}", resp.status())),
                Err(e) => last_err = Some(format!("net: {e}")),
            }
        }
        out.push(CatalogPreview {
            key,
            summary,
            error: last_err,
        });
    }
    Ok(out)
}

/// Pull the first non-trivial paragraph out of a SKILL.md / README.md /
/// agent .md file. Strips YAML frontmatter and the leading `# Title`
/// header. Caps at 240 chars so the catalog cards stay tight.
fn extract_summary(body: &str) -> String {
    let mut text = body.trim_start();
    if text.starts_with("---") {
        // Skip frontmatter block.
        if let Some(end) = text[3..].find("\n---") {
            text = text[3 + end + 4..].trim_start();
        }
    }
    let mut paragraph = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if line.starts_with('#') {
            // Skip heading lines until we find prose.
            continue;
        }
        if line.starts_with("```") || line.starts_with("<!--") {
            continue;
        }
        if !paragraph.is_empty() {
            paragraph.push(' ');
        }
        paragraph.push_str(line);
        if paragraph.len() > 280 {
            break;
        }
    }
    let trimmed = paragraph.trim();
    if trimmed.len() <= 240 {
        return trimmed.to_string();
    }
    let cut = trimmed
        .char_indices()
        .nth(237)
        .map(|(i, _)| i)
        .unwrap_or(237);
    format!("{}…", &trimmed[..cut])
}

// ---------------------------------------------------------------------------
// GitHub repo search — discover new skills/agents/MCP servers by repo, not by
// file path. Backs the Library -> Catalog "Search GitHub" panel.
// ---------------------------------------------------------------------------
//
// We deliberately shell out to `gh search repos` (already authenticated, no
// extra reqwest plumbing, same CREATE_NO_WINDOW Windows handling as the rest
// of library.rs). `mode = "trending"` is implemented as a recently-updated
// query restricted to claude-flavoured topics — GitHub does not expose a
// first-class "trending" endpoint, but stars + recent push is a workable
// proxy and matches what the user sees on github.com/trending.
//
// Errors are returned as a flat Vec<RepoHit> with the error surfaced via the
// command-level `Err(String)` so the UI can render a single inline message.

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RepoHit {
    pub full_name: String,
    pub owner: String,
    pub name: String,
    pub description: Option<String>,
    pub stars: u64,
    pub language: Option<String>,
    pub html_url: Option<String>,
    pub updated_at: Option<String>,
    pub topics: Vec<String>,
}

/// Local `gh` spawn helper mirroring the one in `crate::library` — kept in
/// this module so we don't need to widen the visibility of the original.
/// Windows-only `CREATE_NO_WINDOW` (0x0800_0000) keeps the subprocess from
/// flashing a console window.
fn gh_command_local(args: &[String]) -> std::process::Command {
    let mut cmd = std::process::Command::new("gh");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

fn run_gh_search_repos(args: Vec<String>) -> Result<Vec<RepoHit>, String> {
    let output = gh_command_local(&args)
        .output()
        .map_err(|e| format!("gh search repos failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh exited {}: {}", output.status, stderr));
    }

    #[derive(serde::Deserialize)]
    struct GhOwner {
        login: String,
    }
    #[derive(serde::Deserialize)]
    struct GhRepoHit {
        #[serde(rename = "fullName")]
        full_name: String,
        owner: GhOwner,
        name: String,
        description: Option<String>,
        #[serde(rename = "stargazersCount")]
        stargazers_count: u64,
        language: Option<String>,
        url: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: Option<String>,
        #[serde(default)]
        topics: Vec<serde_json::Value>,
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let hits: Vec<GhRepoHit> =
        serde_json::from_str(&stdout).map_err(|e| format!("gh json parse: {e}"))?;

    let out = hits
        .into_iter()
        .map(|h| {
            // gh's `--json topics` field returns either a list of
            // bare strings (`["foo", "bar"]`) or a list of objects
            // (`[{"name": "foo"}, ...]`) depending on the gh version.
            // Accept both shapes safely.
            let topics: Vec<String> = h
                .topics
                .iter()
                .filter_map(|v| {
                    if let Some(s) = v.as_str() {
                        return Some(s.to_string());
                    }
                    v.get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string())
                })
                .collect();
            RepoHit {
                full_name: h.full_name,
                owner: h.owner.login,
                name: h.name,
                description: h.description,
                stars: h.stargazers_count,
                language: h.language,
                html_url: h.url,
                updated_at: h.updated_at,
                topics,
            }
        })
        .collect();

    Ok(out)
}

/// Free-text repo search. The query is passed verbatim as the first arg to
/// `gh search repos`, which supports standard GitHub qualifiers (`stars:>N`,
/// `language:rust`, `topic:claude-code`, …) — the frontend can either send a
/// raw user input or pre-assemble qualifiers.
#[tauri::command]
pub async fn github_search_repos(
    query: String,
    limit: Option<u32>,
) -> Result<Vec<RepoHit>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("query is empty".to_string());
    }
    let lim = limit.unwrap_or(20).clamp(1, 50).to_string();
    // NOTE: `topics` was removed from the --json field list — recent gh
    // versions reject it as "Unknown JSON field". GhRepoHit::topics has
    // #[serde(default)] so the parser still works and the field stays empty.
    let args: Vec<String> = vec![
        "search".into(),
        "repos".into(),
        q,
        "--json".into(),
        "fullName,owner,name,description,stargazersCount,language,url,updatedAt".into(),
        "--limit".into(),
        lim,
        "--sort".into(),
        "stars".into(),
    ];
    tauri::async_runtime::spawn_blocking(move || run_gh_search_repos(args))
        .await
        .map_err(|e| format!("spawn join: {e}"))?
}

/// "Trending" feed for Claude-flavoured repos. Implemented as a union over
/// the topics the community has settled on (claude-skill, claude-skills,
/// claude-agent, claude-agents, mcp, mcp-server, claude-code), filtered to
/// repos pushed in the last 90 days and sorted by stars. The hardcoded
/// topic list keeps the call deterministic and avoids hitting per-topic
/// quotas.
#[tauri::command]
pub async fn github_search_trending(
    kind: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<RepoHit>, String> {
    let kind = kind.unwrap_or_else(|| "all".to_string());
    let topics: Vec<&str> = match kind.as_str() {
        "skill" | "skills" => vec![
            "claude-skill",
            "claude-skills",
            "agent-skill",
            "claude-code-skills",
        ],
        "agent" | "agents" => vec!["claude-agent", "claude-agents", "claude-code-agents"],
        "mcp" => vec!["mcp", "mcp-server", "model-context-protocol"],
        _ => vec![
            "claude-skill",
            "claude-skills",
            "claude-agent",
            "claude-agents",
            "mcp-server",
            "claude-code",
        ],
    };
    // GitHub search supports OR'd topic qualifiers as `topic:a topic:b`
    // (logical OR when multiple qualifiers of the same key are given).
    let topic_qualifiers = topics
        .iter()
        .map(|t| format!("topic:{t}"))
        .collect::<Vec<_>>()
        .join(" ");

    // Pushed in the last ~90 days. Computed dynamically con chrono para que
    // la ventana no se quede congelada (antes era una fecha hardcodeada que
    // envejecía y degradaba los resultados de "trending").
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(90))
        .format("%Y-%m-%d")
        .to_string();
    let pushed_window = format!("pushed:>{cutoff}");

    let q = format!("{topic_qualifiers} {pushed_window}");
    let lim = limit.unwrap_or(24).clamp(1, 50).to_string();
    // See github_search_repos: `topics` field was dropped from gh CLI; the
    // query qualifiers (`topic:...`) still narrow the result set server-side.
    let args: Vec<String> = vec![
        "search".into(),
        "repos".into(),
        q,
        "--json".into(),
        "fullName,owner,name,description,stargazersCount,language,url,updatedAt".into(),
        "--limit".into(),
        lim,
        "--sort".into(),
        "stars".into(),
    ];

    tauri::async_runtime::spawn_blocking(move || run_gh_search_repos(args))
        .await
        .map_err(|e| format!("spawn join: {e}"))?
}

// ---------------------------------------------------------------------------
// v2.6 (v27-f14) — list_skill_files: list sibling files of a SKILL.md /
// agent .md so the Skills / Agents detail UI can surface a navigable
// breakdown of the folder. Returns a flat, name-sorted list capped at 32
// entries (skill folders deeper than that are almost always plugin bundles
// we'd rather open in an external editor anyway).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct SiblingFile {
    /// Bare file or directory name (no path).
    pub name: String,
    /// Absolute path on disk.
    pub path: String,
    /// True if the entry is a directory (sub-folder of the skill/agent).
    pub is_dir: bool,
    /// Lowercase extension without the dot, when present (`md`, `py`, …).
    pub ext: Option<String>,
    /// File size in bytes (None for directories or stat errors).
    pub size_bytes: Option<u64>,
}

/// List the sibling files of a SKILL.md / agent .md so the detail UI can
/// surface a navigable breakdown of the folder. The `entry_path` argument
/// is either the path of the SKILL.md / agent .md itself or the directory
/// that contains it — both shapes are accepted to match what the frontend
/// already has in `SkillEntry.path` and `AgentEntry.path`.
#[tauri::command]
pub fn list_skill_files(entry_path: String) -> Result<Vec<SiblingFile>, String> {
    let raw = std::path::PathBuf::from(&entry_path);
    if !raw.exists() {
        return Err(format!("path not found: {entry_path}"));
    }
    let dir = if raw.is_dir() {
        raw
    } else {
        raw.parent()
            .ok_or_else(|| format!("no parent for: {entry_path}"))?
            .to_path_buf()
    };

    let mut out: Vec<SiblingFile> = Vec::new();
    let read_dir =
        std::fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip noisy dotfiles that the user almost never wants to open from
        // the Library UI. `.disabled` is intentionally allowed through —
        // users do use it to find disabled skills.
        if name == ".DS_Store" || name == "Thumbs.db" {
            continue;
        }
        let path = entry.path();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = metadata.is_dir();
        let ext = if is_dir {
            None
        } else {
            path.extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_ascii_lowercase())
        };
        let size_bytes = if is_dir { None } else { Some(metadata.len()) };
        out.push(SiblingFile {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            ext,
            size_bytes,
        });
        if out.len() >= 64 {
            break;
        }
    }

    // Directories first (so the user sees subfolders at the top), then files.
    // Within each group, sort case-insensitively by name.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a
            .name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase()),
    });
    // Cap final list at 32 entries — large plugin bundles should be opened
    // in an external editor, not browsed from inside the Control Center.
    out.truncate(32);
    Ok(out)
}

// ---------------------------------------------------------------------------
// AI-driven install (v2.9.5 — P1 Library>Catalog)
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct AiInstallArgs {
    pub repo_url: String,
    pub target_scope: library::TargetScope,
    #[serde(default)]
    pub dry_run: bool,
}

/// Analyse a GitHub repo with the AI Router and (optionally) execute the
/// install. Returns an `AiInstallResult` that the UI previews before the
/// user confirms execution (or falls back to clipboard if AI is unavailable).
#[tauri::command]
pub async fn library_install_via_ai(
    args: AiInstallArgs,
) -> Result<library::AiInstallResult, String> {
    library::install_via_ai_inner(args.repo_url, args.target_scope, args.dry_run).await
}

#[cfg(test)]
mod catalog_tests {
    use super::extract_summary;

    #[test]
    fn strips_frontmatter_and_title() {
        let body =
            "---\nname: foo\ndescription: x\n---\n\n# Foo\n\nFirst real line here.\nSecond line.\n";
        let s = extract_summary(body);
        assert_eq!(s, "First real line here. Second line.");
    }

    #[test]
    fn skips_empty_body() {
        let body = "---\nname: foo\n---\n";
        let s = extract_summary(body);
        assert!(s.is_empty());
    }

    #[test]
    fn truncates_long_paragraph_with_ellipsis() {
        let long = "x".repeat(400);
        let body = format!("# Title\n\n{}\n", long);
        let s = extract_summary(&body);
        assert!(s.ends_with('…'));
        assert!(s.chars().count() <= 238);
    }
}
