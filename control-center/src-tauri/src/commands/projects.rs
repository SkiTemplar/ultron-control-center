// Project CRUD + launcher + open-in-IDE commands.
use crate::projects;
use crate::project_context;

#[tauri::command]
pub async fn list_projects() -> Result<Vec<projects::ProjectInfo>, String> {
    projects::list_projects_inner()
}

#[tauri::command]
pub async fn open_project(
    app: tauri::AppHandle,
    id: String,
) -> Result<projects::ProjectActionResult, String> {
    projects::open_project_inner(&app, id).await
}

#[tauri::command]
pub async fn scan_projects(
    app: tauri::AppHandle,
) -> Result<Vec<projects::ProjectInfo>, String> {
    projects::scan_projects_inner(&app).await
}

#[tauri::command]
pub async fn create_project(
    app: tauri::AppHandle,
    name: String,
    path: String,
    ide: Option<String>,
    language: Option<String>,
    tags: Option<Vec<String>>,
    default_provider: Option<String>,
    // fb-016 — three new optional fields. Older frontends that don't send
    // them just leave them as None, which the inner write-path interprets
    // as "skip", so backwards compat is preserved.
    default_shell: Option<String>,
    parent_folder_override: Option<String>,
    notes: Option<String>,
) -> Result<projects::CreateProjectResult, String> {
    // F2: route through *_with_emit so project.created notifications fire
    projects::create_project_inner_with_emit(&app, projects::CreateProjectPayload {
        name,
        path,
        ide,
        language,
        tags,
        default_provider,
        default_shell,
        parent_folder_override,
        notes,
    })
}

#[tauri::command]
pub async fn update_project(
    id: String,
    name: Option<String>,
    path: Option<String>,
    ide: Option<String>,
    language: Option<String>,
    tags: Option<Vec<String>>,
    default_provider: Option<String>,
    // fb-016 — patches for the new optional fields. None = leave unchanged,
    // empty string = clear, anything else = set/normalise.
    default_shell: Option<String>,
    parent_folder_override: Option<String>,
    notes: Option<String>,
    // v2.6.2 — patch the Quick Launch executables. Some([]) clears the list.
    executables: Option<Vec<projects::ExecutableEntry>>,
) -> Result<projects::UpdateProjectResult, String> {
    projects::update_project_inner(projects::UpdateProjectPayload {
        id,
        name,
        path,
        ide,
        language,
        tags,
        default_provider,
        default_shell,
        parent_folder_override,
        notes,
        executables,
    })
}

/// v2.6.2 — spawn a Quick Launch executable. Validated server-side via the
/// same hardening helpers as the launcher chips.
#[tauri::command]
pub async fn launch_project_executable(
    app: tauri::AppHandle,
    path: String,
) -> Result<projects::ProjectActionResult, String> {
    projects::launch_project_executable_inner(&app, path).await
}

/// Surgical patch for `Project.default_provider`. The Projects tab's inline
/// radio invokes this on every selection change without needing to assemble
/// a full update payload; keeps the on-disk write to a single field.
#[tauri::command]
pub async fn set_default_provider(
    project_id: String,
    provider: String,
) -> Result<projects::UpdateProjectResult, String> {
    projects::set_default_provider_inner(project_id, provider)
}

#[tauri::command]
pub async fn delete_project(
    app: tauri::AppHandle,
    id: String,
) -> Result<projects::DeleteProjectResult, String> {
    // F2: route through *_with_emit so project.deleted notifications fire
    projects::delete_project_inner_with_emit(&app, id)
}

#[tauri::command]
pub async fn add_launcher_item(
    project_id: String,
    item: projects::LauncherItem,
) -> Result<projects::UpdateProjectResult, String> {
    projects::add_launcher_item_inner(projects::AddLauncherItemPayload { project_id, item })
}

#[tauri::command]
pub async fn remove_launcher_item(
    project_id: String,
    index: usize,
) -> Result<projects::UpdateProjectResult, String> {
    projects::remove_launcher_item_inner(project_id, index)
}

#[tauri::command]
pub async fn reorder_launcher_items(
    project_id: String,
    from: usize,
    to: usize,
) -> Result<projects::UpdateProjectResult, String> {
    projects::reorder_launcher_items_inner(project_id, from, to)
}

#[tauri::command]
pub async fn launch_item(
    app: tauri::AppHandle,
    project_id: String,
    index: usize,
) -> Result<(), String> {
    projects::launch_item_inner(app, project_id, index).await
}

#[tauri::command]
pub async fn launch_all_items(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<usize, String> {
    projects::launch_all_items_inner(app, project_id).await
}

/// Open a project path in the user's IDE.
/// Order: VS Code (`code <path>`) -> Cursor (`cursor <path>`) -> file explorer.
/// Path is canonicalised to reject relative / traversal payloads.
#[tauri::command]
pub async fn open_project_in_ide(
    path: String,
    preferred_ide: Option<String>,
) -> Result<String, String> {
    use std::path::PathBuf;
    let p = PathBuf::from(&path);
    if !p.is_dir() && !p.is_file() {
        return Err(format!("path not found: {}", path));
    }
    let canonical = p.canonicalize().map_err(|e| format!("canonicalize: {}", e))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    // Strip the Windows extended path prefix \\?\ which `code` doesn't like.
    let cleaned = canonical_str
        .strip_prefix(r"\\?\")
        .unwrap_or(&canonical_str)
        .to_string();

    // Map the per-project IDE slug ("vscode" / "cursor" / "code-insiders")
    // to the CLI binary name that ships with that editor. `vscode` is the
    // canonical slug we expose to the UI; the CLI itself is called `code`.
    // v15.5.18 fix: extend slug → CLI map to cover the JetBrains family + the
    // frontend dropdown (Rider, WebStorm, PyCharm, CLion, IDEA, GoLand, PhpStorm).
    // Prior to this fix only VS Code / Cursor / Code-Insiders were mapped, so any
    // JetBrains preference fell back through slug_to_cli=None → candidates list
    // skipped the user's choice → first available CLI (code) was used → user
    // reported "siempre abre Visual Studio". JetBrains CLIs install per-IDE
    // (`rider`, `webstorm`, etc.) when "Generate shell scripts" is enabled in
    // the JetBrains Toolbox settings; if not, the `where` check fails and we
    // fall through to the next candidate as before.
    let slug_to_cli = |s: &str| match s.to_ascii_lowercase().as_str() {
        "vscode" | "vs code" | "code" => Some("code"),
        "cursor" => Some("cursor"),
        "code-insiders" | "code insiders" | "vscode-insiders" | "insiders" => {
            Some("code-insiders")
        }
        "rider" => Some("rider"),
        "webstorm" => Some("webstorm"),
        "pycharm" => Some("pycharm"),
        "clion" => Some("clion"),
        "idea" | "intellij" | "intellij idea" => Some("idea"),
        "goland" => Some("goland"),
        "phpstorm" => Some("phpstorm"),
        "rustrover" => Some("rustrover"),
        "datagrip" => Some("datagrip"),
        "fleet" => Some("fleet"),
        "sublime" | "subl" => Some("subl"),
        "nvim" | "neovim" | "vim" => Some("nvim"),
        "zed" => Some("zed"),
        _ => None,
    };

    // Build the ordered try list. When the caller supplies a preference we
    // put it first; the remaining CLIs fall in behind it as fallbacks so
    // a project tagged "cursor" still opens *something* when Cursor is
    // missing on this machine (instead of dropping to explorer.exe).
    let mut candidates: Vec<&str> = Vec::new();
    let pref_cli = preferred_ide
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(slug_to_cli);
    if let Some(p) = pref_cli {
        candidates.push(p);
    }
    for c in ["code", "cursor", "code-insiders"] {
        if !candidates.contains(&c) {
            candidates.push(c);
        }
    }

    for cli in &candidates {
        if std::process::Command::new("where").arg(cli).output()
            .map(|o| o.status.success()).unwrap_or(false)
        {
            // Use cmd /C to invoke the .cmd shim winget installs.
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/C", cli, &cleaned]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            cmd.spawn().map_err(|e| format!("spawn {}: {}", cli, e))?;
            return Ok(format!("opened in {}", cli));
        }
    }

    // Fallback: file explorer.
    let mut explorer = std::process::Command::new("explorer.exe");
    explorer.arg(&cleaned);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        explorer.creation_flags(0x08000000);
    }
    explorer.spawn().map_err(|e| format!("spawn explorer: {}", e))?;
    Ok("opened in file explorer (no IDE on PATH)".to_string())
}

// ---- P4: per-project CLAUDE.md editor ----
// NOTE: project_claude_md_load / project_claude_md_save remain here for
// backward compat with the legacy editor. The richer `project_context_load`
// command below supersedes them for the new Context tab.

fn resolve_claude_md(project_path: &str) -> std::path::PathBuf {
    let p = std::path::PathBuf::from(project_path);
    let dotclaude = p.join(".claude").join("CLAUDE.md");
    if dotclaude.exists() {
        return dotclaude;
    }
    p.join("CLAUDE.md")
}

#[tauri::command]
pub async fn project_claude_md_load(project_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_claude_md(&project_path);
        if !path.exists() {
            return Ok::<String, String>(String::new());
        }
        std::fs::read_to_string(&path).map_err(|e| format!("read CLAUDE.md: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_claude_md_save(
    project_path: String,
    content: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_claude_md(&project_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
        }
        let tmp = path.with_extension("md.tmp");
        std::fs::write(&tmp, content).map_err(|e| format!("write tmp: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- v2.9.5: rich project context aggregator ----

/// Load all context signals for the per-project Context sub-tab in one call:
/// CLAUDE.md content + path, Mem0 memories, KG entities, bug cards,
/// decision records, git summary, and next-step suggestions.
#[tauri::command]
pub async fn project_context_load(
    project_id: String,
    project_name: String,
    project_path: String,
) -> Result<project_context::ProjectContextPayload, String> {
    project_context::load_inner(project_id, project_name, project_path).await
}

/// Create a starter CLAUDE.md stub at <project_path>/CLAUDE.md.
/// Returns the generated content so the UI can display it immediately.
/// Errors if the file already exists.
#[tauri::command]
pub async fn project_create_claude_md(
    project_path: String,
    project_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_context::create_claude_md_stub(&project_path, &project_name)
    })
    .await
    .map_err(|e| e.to_string())?
}
