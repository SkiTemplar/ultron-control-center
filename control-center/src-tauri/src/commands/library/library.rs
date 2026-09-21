//! P5 — Agent/Skill library Tauri command wrappers.
//!
//! 2026-09-22: la cabecera decia que este modulo expone el catalogo curado de
//! `cockpit/curated-catalog.json`. Era falso desde hacia tiempo (no habia ni
//! un lector del fichero en todo el codigo), asi que la afirmacion se retira
//! junto con las structs que la sostenian. El descubrimiento de repositorios
//! vive en `commands::library::repos`.

use crate::library;

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
    // Capture the data needed for the post-install integration BEFORE the args
    // are moved into the installer.
    let repo_label = format!("{}/{}", args.owner, args.repo);
    let project_id = args.target_project_id.clone();
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

    // Post-install integration (BEST-EFFORT, never fails the install): the
    // installed file's stem is the asset slug (e.g. ".../skills/foo/SKILL.md"
    // → "foo"; ".../agents/foo.md" → "foo"). Auto-syncs the routing catalog and
    // proposes a memory candidate. Runs on the blocking pool so the synchronous
    // node spawn + DB write don't stall the async runtime.
    let asset = installed_asset_slug(&p);
    let assets = asset.into_iter().collect::<Vec<_>>();
    let label = repo_label.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        super::post_install::post_install_integrate(&label, &assets, project_id.as_deref())
    })
    .await;

    Ok(p.display().to_string())
}

/// Derive the skill/agent slug from an installed target path:
///   `.../skills/<name>/SKILL.md` → `<name>`
///   `.../agents/<name>.md`       → `<name>`
fn installed_asset_slug(target: &std::path::Path) -> Option<String> {
    let file = target.file_name().and_then(|s| s.to_str())?;
    if file.eq_ignore_ascii_case("SKILL.md") {
        // Skill folder layout: parent directory name is the slug.
        return target
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .map(str::to_string);
    }
    // Agent (or flat) layout: the file stem is the slug.
    Some(file.trim_end_matches(".md").to_string())
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
// Tarjeta de repositorio
// ---------------------------------------------------------------------------
//
// `RepoHit` vivia aqui y se rellenaba con `gh search repos`. Desde el
// 2026-09-22 la define `maria::repos`, que es quien habla con la API REST, y
// aqui solo se reexporta para no romper a sus consumidores (`catalog_compat`
// la importa por esta ruta).

pub use crate::maria::repos::RepoHit;

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
