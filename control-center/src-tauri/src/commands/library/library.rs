//! P5 — Agent/Skill library Tauri command wrappers.

use crate::library;

// La instalación desde GitHub (`library_install_from_github`) se retiró el
// 2026-10-17: su modal no tenía entrada en la UI y derivaba mal el nombre de
// las skills. El descubrimiento por GitHub sigue en Catalog (búsqueda de
// repos + «Integrar con IA»).

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
pub async fn agent_create(args: AgentCreateArgs) -> Result<String, String> {
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
pub async fn skill_create(args: SkillCreateArgs) -> Result<String, String> {
    let spec = library::SkillCreateSpec {
        name: args.name,
        description: args.description,
        body: args.body,
    };
    let p = library::skill_create_inner(spec, args.target_scope, args.target_project_id)?;
    Ok(p.display().to_string())
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

/// Local `gh` spawn helper (el gemelo de `library/gh_helpers.rs` se retiró
/// el 2026-10-17 con la instalación desde GitHub). Windows-only `CREATE_NO_WINDOW` (0x0800_0000) keeps the subprocess from
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
///
/// Async con `spawn_blocking` (2026-10-23): era un comando síncrono con
/// `read_dir`, y en Tauri 2 eso corre en el hilo principal y congela la
/// ventana mientras el disco responde.
#[tauri::command]
pub async fn list_skill_files(entry_path: String) -> Result<Vec<SiblingFile>, String> {
    tauri::async_runtime::spawn_blocking(move || list_skill_files_inner(&entry_path))
        .await
        .map_err(|e| format!("spawn join: {e}"))?
}

/// Carpeta a listar: la propia ruta si es un directorio, si no su padre.
fn skill_dir_of(entry_path: &str) -> Result<std::path::PathBuf, String> {
    let raw = std::path::PathBuf::from(entry_path);
    if !raw.exists() {
        return Err(format!("path not found: {entry_path}"));
    }
    if raw.is_dir() {
        return Ok(raw);
    }
    raw.parent()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| format!("no parent for: {entry_path}"))
}

/// Una entrada del directorio como `SiblingFile`, o `None` si se omite.
fn sibling_of(entry: &std::fs::DirEntry) -> Option<SiblingFile> {
    let name = entry.file_name().to_string_lossy().to_string();
    // Skip noisy dotfiles that the user almost never wants to open from
    // the Library UI. `.disabled` is intentionally allowed through —
    // users do use it to find disabled skills.
    if name == ".DS_Store" || name == "Thumbs.db" {
        return None;
    }
    let path = entry.path();
    let metadata = entry.metadata().ok()?;
    let is_dir = metadata.is_dir();
    let ext = if is_dir {
        None
    } else {
        path.extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
    };
    Some(SiblingFile {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir,
        ext,
        size_bytes: (!is_dir).then_some(metadata.len()),
    })
}

pub(crate) fn list_skill_files_inner(entry_path: &str) -> Result<Vec<SiblingFile>, String> {
    let dir = skill_dir_of(entry_path)?;
    let read_dir =
        std::fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    let mut out: Vec<SiblingFile> = read_dir
        .filter_map(Result::ok)
        .filter_map(|e| sibling_of(&e))
        .take(64)
        .collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_comando_es_asincrono_y_lista_la_carpeta_de_la_skill() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("SKILL.md"), "x").unwrap();
        std::fs::write(dir.path().join("b.PY"), "yy").unwrap();
        std::fs::write(dir.path().join("Thumbs.db"), "").unwrap();
        std::fs::create_dir(dir.path().join("refs")).unwrap();
        let skill_md = dir.path().join("SKILL.md").to_string_lossy().to_string();
        // Caso negativo del hallazgo: con el comando síncrono esto no compila
        // (no devuelve un Future que bloquear).
        let files = tauri::async_runtime::block_on(list_skill_files(skill_md)).expect("lista");
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["refs", "b.PY", "SKILL.md"]);
        assert_eq!(files[1].ext.as_deref(), Some("py"));
        assert_eq!(files[1].size_bytes, Some(2));
        assert_eq!(files[0].size_bytes, None);
    }

    #[test]
    fn una_ruta_inexistente_es_un_error() {
        let err = list_skill_files_inner("Z:/no/existe/SKILL.md").unwrap_err();
        assert!(err.contains("path not found"), "{err}");
    }

    #[test]
    fn el_tope_es_de_32_entradas() {
        let dir = tempfile::tempdir().expect("tempdir");
        for i in 0..40 {
            std::fs::write(dir.path().join(format!("f{i:02}.md")), "").unwrap();
        }
        let files = list_skill_files_inner(&dir.path().to_string_lossy()).expect("lista");
        assert_eq!(files.len(), 32);
    }
}
