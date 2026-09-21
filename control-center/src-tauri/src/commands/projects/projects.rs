// Project CRUD + launcher + open-in-IDE commands.
use crate::project_context;
use crate::projects;

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
pub async fn scan_projects(app: tauri::AppHandle) -> Result<Vec<projects::ProjectInfo>, String> {
    projects::scan_projects_inner(&app).await
}

/// Bump a project's `last_active` to now so "Most recent" ordering tracks real
/// usage. Called by the frontend whenever the user opens or launches a project.
#[tauri::command]
pub async fn touch_project(id: String) -> Result<(), String> {
    projects::touch_project_inner(&id)
}

#[allow(clippy::too_many_arguments)] // tauri command — args driven by frontend contract
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
    // v2.7.2 — accent colour `#rrggbb`. None / invalid = no colour.
    color: Option<String>,
    // FRENTE D — comando para lanzar la app del proyecto (optional).
    app_command: Option<String>,
) -> Result<projects::CreateProjectResult, String> {
    // F2: route through *_with_emit so project.created notifications fire
    projects::create_project_inner_with_emit(
        &app,
        projects::CreateProjectPayload {
            name,
            path,
            ide,
            language,
            tags,
            default_provider,
            default_shell,
            parent_folder_override,
            notes,
            color,
            app_command,
        },
    )
}

#[allow(clippy::too_many_arguments)] // tauri command — args driven by frontend contract
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
    // v2.7.2 — patch the accent colour. "" clears it, invalid hex is ignored.
    color: Option<String>,
    // FRENTE D — patch del comando de la app. "" lo borra, None no lo toca.
    app_command: Option<String>,
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
        color,
        app_command,
    })
}

/// FRENTE D — lanza `app_command` en una ventana de terminal nueva con cwd =
/// la ruta del proyecto. El botón del front se deshabilita cuando el
/// proyecto no tiene `app_command`; este comando revalida todo server-side
/// de forma independiente (mandamiento 11 — nunca un no-op silencioso).
#[tauri::command]
pub async fn project_open_app(id: String) -> Result<projects::ProjectActionResult, String> {
    projects::project_open_app_inner(id).await
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
pub async fn launch_all_items(app: tauri::AppHandle, project_id: String) -> Result<usize, String> {
    projects::launch_all_items_inner(app, project_id).await
}

/// Open a project path in the user's IDE.
///
/// Launcher resolution is shared with `projects::ide` (PATH -> JetBrains
/// Toolbox shim -> standard install directory), so an IDE whose CLI is not on
/// PATH — the JetBrains and Android Studio installers do not add one — is
/// still found.
///
/// A *preferred* IDE that is not installed returns an error instead of
/// opening a different editor. The previous version pushed `code` / `cursor`
/// in behind the preference as fallbacks, so a project pinned to Rider
/// silently opened in VS Code. Without a preference we auto-detect, and only
/// when nothing at all is installed do we fall back to the file explorer.
#[tauri::command]
pub async fn open_project_in_ide(
    path: String,
    preferred_ide: Option<String>,
) -> Result<String, String> {
    use crate::projects::ide;
    use crate::projects::normalise::normalise_ide;
    use std::path::PathBuf;

    let p = PathBuf::from(&path);
    if !p.is_dir() && !p.is_file() {
        return Err(format!("path not found: {}", path));
    }
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("canonicalize: {}", e))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    // Strip the Windows extended path prefix \\?\ which `code` doesn't like.
    let cleaned = canonical_str
        .strip_prefix(r"\\?\")
        .unwrap_or(&canonical_str)
        .to_string();

    let raw_pref = preferred_ide
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if let Some(raw) = raw_pref {
        let cli = normalise_ide(Some(raw))
            .as_deref()
            .and_then(ide::slug_to_cli)
            .ok_or_else(|| format!("unknown IDE '{}'", raw))?;
        let program = ide::resolve_launcher(cli).ok_or_else(|| {
            format!(
                "{} is not installed (no '{}' on PATH, in the JetBrains Toolbox scripts \
                 directory, or in a standard install directory)",
                ide::display_name(cli),
                cli
            )
        })?;
        ide::spawn_launcher(&program, &cleaned).map_err(|e| e.to_string())?;
        return Ok(format!("opened in {}", ide::display_name(cli)));
    }

    for cli in ide::AUTODETECT_ORDER {
        if let Some(program) = ide::resolve_launcher(cli) {
            ide::spawn_launcher(&program, &cleaned).map_err(|e| e.to_string())?;
            return Ok(format!("opened in {}", ide::display_name(cli)));
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
    explorer
        .spawn()
        .map_err(|e| format!("spawn explorer: {}", e))?;
    Ok("opened in file explorer (no IDE found on this machine)".to_string())
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
pub async fn project_claude_md_save(project_path: String, content: String) -> Result<(), String> {
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
/// CLAUDE.md content + path, KG entities, bug cards,
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

// ---- Bitacora del proyecto (2026-09-21) ----
// Los resumenes por sesion que escribe session-summarize-previous.js existian
// desde el 11-09 y solo los leia el hook de SessionStart. Estos dos comandos
// los sacan a la GUI: el listado para la vista colapsada, el cuerpo entero
// solo cuando el usuario despliega una tarjeta.

/// Bitacora de un proyecto: una entrada por sesion resumida, la mas reciente
/// primero. Sin resumenes devuelve lista vacia (proyecto aun no abierto desde
/// que existe el generador), nunca un error.
#[tauri::command]
pub async fn project_session_log(
    project_id: String,
) -> Result<Vec<crate::projects::session_log::SessionLogEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::projects::session_log::session_log_inner(&project_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Markdown completo de un resumen concreto, para la tarjeta desplegada.
#[tauri::command]
pub async fn project_session_entry(
    project_id: String,
    session_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::projects::session_log::session_entry_inner(&project_id, &session_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
