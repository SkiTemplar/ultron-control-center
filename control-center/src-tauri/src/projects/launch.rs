// projects/launch.rs — Launch dispatch: open_project, launch_item, launch_all, open_in_ide.

use super::normalise::normalise_ide;
use super::read_ops::load_items_for;
use super::registry::{launch_project_py_path, path_ps_safe, registry_path};
use super::types::{LauncherItem, ProjectActionResult};
use super::write_ops::validate_launcher_item;

/// Open a project by id. v15.4 migration: no longer shells out to
/// `ultron.ps1`. Three fast paths handled in pure Rust:
///   1. `path` points to a file (.exe / .lnk / .bat / .url / .pdf / .html /
///      .cmd) OR `ide` is one of the "external launcher" kinds.
///   2. `path` is an existing directory AND `ide` is one of the editor slugs
///      Rust knows ("vscode" / "cursor" / "code-insiders" plus their aliases).
///   3. Anything else falls through to `launch_project.py` via `uv run python`.
pub async fn open_project_inner(
    app: &tauri::AppHandle,
    id: String,
) -> Result<ProjectActionResult, String> {
    use tauri_plugin_shell::ShellExt;
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!("invalid project id '{}'", id));
    }
    let registry = registry_path().ok_or_else(|| "no HOME".to_string())?;
    let raw =
        std::fs::read_to_string(&registry).map_err(|e| format!("read projects.json: {}", e))?;
    let root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    let entry = root
        .get("projects")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|p| p.get("id").and_then(|x| x.as_str()) == Some(id.as_str()))
        })
        .cloned()
        .ok_or_else(|| format!("project '{}' not found", id))?;

    let ide = entry
        .get("ide")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let path = entry
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let path_ref = std::path::Path::new(&path);
    let is_file = path_ref.is_file();
    let is_dir = path_ref.is_dir();
    let is_external_kind = matches!(
        ide.to_lowercase().as_str(),
        "external" | "app" | "game" | "browser"
    );

    if !path.is_empty() && (is_file || is_external_kind) {
        path_ps_safe(&path)?;
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".exe") {
            let mut cmd = std::process::Command::new(&path);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            let spawn_result = cmd.spawn();
            return match spawn_result {
                Ok(_child) => Ok(ProjectActionResult {
                    success: true,
                    stdout: format!("spawned {}", path),
                    stderr: String::new(),
                    exit_code: Some(0),
                }),
                Err(e) => Ok(ProjectActionResult {
                    success: false,
                    stdout: String::new(),
                    stderr: format!("spawn {}: {}", path, e),
                    exit_code: None,
                }),
            };
        }
        let ps_quoted = format!("'{}'", path.replace('\'', "''"));
        let ps_cmd = format!("Start-Process -FilePath {}", ps_quoted);
        let output = app
            .shell()
            .command("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &ps_cmd,
            ])
            .output()
            .await
            .map_err(|e| format!("spawn ps: {}", e))?;
        return Ok(ProjectActionResult {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code(),
        });
    }

    if is_dir {
        let normalised_ide = normalise_ide(Some(ide.as_str()));
        if let Some(slug) = normalised_ide.as_deref() {
            match open_in_ide(&path, Some(slug)).await {
                Ok(()) => {
                    return Ok(ProjectActionResult {
                        success: true,
                        stdout: format!("opened {} in {}", id, slug),
                        stderr: String::new(),
                        exit_code: Some(0),
                    });
                }
                Err(e) => {
                    eprintln!(
                        "[projects] open_in_ide({}, {}) failed: {} — falling back to launch_project.py",
                        id, slug, e
                    );
                }
            }
        }
    }

    let py = launch_project_py_path().ok_or_else(|| "no HOME".to_string())?;
    let py_str = py.to_string_lossy().to_string();
    let output = app
        .shell()
        .command("uv")
        .args(["run", "python", &py_str, &id])
        .output()
        .await
        .map_err(|e| format!("spawn uv run launch_project.py: {}", e))?;
    Ok(ProjectActionResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
    })
}

/// FRENTE D — lanza el `app_command` configurado en el proyecto (p. ej.
/// `npm run tauri dev`) en una ventana de terminal nueva, con cwd = la ruta
/// del proyecto. El botón del front se deshabilita cuando `app_command` está
/// vacío, pero esta función revalida todo desde disco de forma independiente
/// — nunca confía en que el front mandó el estado correcto.
pub async fn project_open_app_inner(id: String) -> Result<ProjectActionResult, String> {
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!("invalid project id '{}'", id));
    }
    let registry = registry_path().ok_or_else(|| "no HOME".to_string())?;
    let raw =
        std::fs::read_to_string(&registry).map_err(|e| format!("read projects.json: {}", e))?;
    let root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    let entry = root
        .get("projects")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|p| p.get("id").and_then(|x| x.as_str()) == Some(id.as_str()))
        })
        .ok_or_else(|| format!("project '{}' not found", id))?;

    let name = entry
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(id.as_str());
    let app_command = entry
        .get("app_command")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("project '{}' has no app_command configured", id))?;
    validate_app_command(app_command)?;
    let path = entry
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if path.is_empty() {
        return Err(format!("project '{}' has no path configured", id));
    }
    path_ps_safe(&path)?;
    let cwd = std::path::Path::new(&path);
    if !cwd.is_dir() {
        return Err(format!("project path does not exist: {}", path));
    }

    spawn_app_command(name, app_command, cwd)?;
    Ok(ProjectActionResult {
        success: true,
        stdout: format!("launched app_command for '{}' in {}", id, path),
        stderr: String::new(),
        exit_code: Some(0),
    })
}

/// Solo caracteres de control se rechazan aquí — a diferencia de un `path`,
/// `app_command` es intencionalmente una línea de comando arbitraria (p. ej.
/// `npm run dev && echo done`), así que no aplicamos el filtro de
/// path-traversal de `path_ps_safe`.
pub(crate) fn validate_app_command(cmd: &str) -> Result<(), String> {
    if cmd.is_empty() {
        return Err("app_command is empty".into());
    }
    if cmd.chars().any(|c| c.is_control()) {
        return Err("app_command contains control characters".into());
    }
    Ok(())
}

/// Windows: `cmd /c start "ULTRON <nombre>" cmd /k <app_command>` — abre una
/// ventana de consola nueva y visible (a diferencia del resto de spawns de
/// este módulo, que usan CREATE_NO_WINDOW porque la app Tauri no tiene
/// consola). Cada elemento va como argv separado — `Command::args` en
/// Windows escapa cada uno por su cuenta, así que `app_command` nunca se
/// concatena a ciegas en una cadena de shell.
#[cfg(windows)]
fn spawn_app_command(name: &str, app_command: &str, cwd: &std::path::Path) -> Result<(), String> {
    let title = format!("ULTRON {}", name);
    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/C", "start", &title, "cmd", "/K", app_command]);
    cmd.current_dir(cwd);
    cmd.spawn()
        .map_err(|e| format!("spawn app_command: {}", e))?;
    Ok(())
}

/// macOS: abre Terminal.app y le pide que corra `cd <cwd> && <app_command>`.
#[cfg(target_os = "macos")]
fn spawn_app_command(_name: &str, app_command: &str, cwd: &std::path::Path) -> Result<(), String> {
    let cwd_str = cwd
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let escaped_cmd = app_command.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "tell application \"Terminal\" to do script \"cd {} && {}\"",
        cwd_str, escaped_cmd
    );
    std::process::Command::new("osascript")
        .args(["-e", &script])
        .spawn()
        .map_err(|e| format!("spawn app_command: {}", e))?;
    Ok(())
}

/// Linux: delega en el emulador de terminal por defecto del sistema
/// (`x-terminal-emulator`, el alias de Debian/Ubuntu para el terminal
/// preferido del usuario).
#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_app_command(_name: &str, app_command: &str, cwd: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("x-terminal-emulator")
        .arg("-e")
        .arg(app_command)
        .current_dir(cwd)
        .spawn()
        .map_err(|e| format!("spawn app_command: {}", e))?;
    Ok(())
}

/// Spawn a Quick Launch executable. We validate the same security envelope as
/// the `exe` launcher chip (`path_ps_safe`) and prefer a direct
/// `Command::new(path)` spawn for `.exe` so we never enter a shell.
pub async fn launch_project_executable_inner(
    app: &tauri::AppHandle,
    path: String,
) -> Result<ProjectActionResult, String> {
    use tauri_plugin_shell::ShellExt;
    if path.trim().is_empty() {
        return Err("path is empty".into());
    }
    if path.starts_with(r"\\") || path.starts_with("//") {
        return Err("UNC paths are not allowed".into());
    }
    path_ps_safe(&path)?;
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".exe") {
        let mut cmd = std::process::Command::new(&path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        return match cmd.spawn() {
            Ok(_) => Ok(ProjectActionResult {
                success: true,
                stdout: format!("spawned {}", path),
                stderr: String::new(),
                exit_code: Some(0),
            }),
            Err(e) => Ok(ProjectActionResult {
                success: false,
                stdout: String::new(),
                stderr: format!("spawn {}: {}", path, e),
                exit_code: None,
            }),
        };
    }
    let ps_quoted = format!("'{}'", path.replace('\'', "''"));
    let ps_cmd = format!("Start-Process -FilePath {}", ps_quoted);
    let output = app
        .shell()
        .command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps_cmd,
        ])
        .output()
        .await
        .map_err(|e| format!("spawn ps: {}", e))?;
    Ok(ProjectActionResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
    })
}

/// Spawn a single launcher item. Returns Ok(()) on success.
pub async fn launch_item_inner(
    app: tauri::AppHandle,
    project_id: String,
    index: usize,
) -> Result<(), String> {
    if !project_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!("invalid project id '{}'", project_id));
    }
    let items = load_items_for(&project_id)?;
    let item = items
        .get(index)
        .ok_or_else(|| format!("item index {} out of range (len={})", index, items.len()))?;
    dispatch_item(&app, item).await
}

/// Best-effort batch launch. Iterates items in order, logging per-item
/// errors instead of aborting; returns the count of items that launched
/// successfully.
///
/// v15.2.x semantics:
///   - `folder` items are SKIPPED.
///   - When the project has a preferred `ide` set, additionally invoke
///     the IDE opener with that explicit preference.
pub async fn launch_all_items_inner(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<usize, String> {
    if !project_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!("invalid project id '{}'", project_id));
    }
    let items = load_items_for(&project_id)?;
    let mut launched = 0usize;
    for (i, item) in items.iter().enumerate() {
        if item.kind == "folder" {
            continue;
        }
        match dispatch_item(&app, item).await {
            Ok(_) => launched += 1,
            Err(e) => {
                eprintln!("[projects] launch_all_items[{}] {}: {}", project_id, i, e);
            }
        }
    }

    if let Some((path, preferred_ide)) = project_path_and_ide(&project_id) {
        if let Err(e) = open_in_ide(&path, Some(preferred_ide.as_str())).await {
            eprintln!(
                "[projects] launch_all_items[{}] ide launch failed: {}",
                project_id, e
            );
        }
    }
    Ok(launched)
}

/// Look up `(path, ide)` for a project, returning `Some(...)` only when
/// both are non-empty and the path exists on disk.
fn project_path_and_ide(project_id: &str) -> Option<(String, String)> {
    let registry = registry_path()?;
    let raw = std::fs::read_to_string(&registry).ok()?;
    let root: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let arr = root.get("projects")?.as_array()?;
    let entry = arr
        .iter()
        .find(|p| p.get("id").and_then(|x| x.as_str()) == Some(project_id))?;
    let path = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let ide = entry.get("ide").and_then(|v| v.as_str()).unwrap_or("");
    let path_t = path.trim();
    let ide_t = ide.trim();
    if path_t.is_empty() || ide_t.is_empty() {
        return None;
    }
    let normalised = normalise_ide(Some(ide_t))?;
    if !std::path::Path::new(path_t).exists() {
        return None;
    }
    Some((path_t.to_string(), normalised))
}

/// Spawn the given path in the preferred IDE (or auto-detect when None).
pub async fn open_in_ide(path: &str, preferred: Option<&str>) -> Result<(), String> {
    let p = std::path::PathBuf::from(path);
    if !p.is_dir() && !p.is_file() {
        return Err(format!("path not found: {}", path));
    }
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("canonicalize: {}", e))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    let cleaned = canonical_str
        .strip_prefix(r"\\?\")
        .unwrap_or(&canonical_str)
        .to_string();

    let slug_to_cli = |s: &str| match s {
        "vscode" => Some("code"),
        "cursor" => Some("cursor"),
        "code-insiders" => Some("code-insiders"),
        "intellij" => Some("idea"),
        "rider" => Some("rider"),
        "webstorm" => Some("webstorm"),
        "pycharm" => Some("pycharm"),
        "clion" => Some("clion"),
        "androidstudio" => Some("studio"),
        "fleet" => Some("fleet"),
        "nvim" => Some("nvim"),
        "sublime" => Some("subl"),
        "zed" => Some("zed"),
        _ => None,
    };

    let mut candidates: Vec<&str> = Vec::new();
    if let Some(pref) = preferred.and_then(slug_to_cli) {
        candidates.push(pref);
    }
    for c in [
        "code",
        "cursor",
        "code-insiders",
        "idea",
        "rider",
        "webstorm",
        "pycharm",
        "clion",
        "studio",
        "fleet",
        "nvim",
        "subl",
        "zed",
    ] {
        if !candidates.contains(&c) {
            candidates.push(c);
        }
    }

    for cli in &candidates {
        let found = std::process::Command::new("where")
            .arg(cli)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !found {
            continue;
        }
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", cli, &cleaned]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.spawn().map_err(|e| format!("spawn {}: {}", cli, e))?;
        return Ok(());
    }
    Err("no IDE on PATH".to_string())
}

/// Per-kind dispatch. Pulled out so launch_item / launch_all share one
/// implementation.
async fn dispatch_item(app: &tauri::AppHandle, item: &LauncherItem) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    validate_launcher_item(item)?;
    match item.kind.as_str() {
        "exe" => {
            let path = item.path.as_deref().unwrap_or("").trim();
            path_ps_safe(path)?;
            let exe_path = std::path::Path::new(path);
            if !exe_path.is_file() {
                return Err(format!("exe not found: {}", path));
            }
            let args = item.args.clone().unwrap_or_default();
            for a in &args {
                if a.chars().any(|c| c.is_control()) {
                    return Err("launcher argument contains control characters".into());
                }
            }
            let lower = path.to_ascii_lowercase();
            if lower.ends_with(".exe") {
                let mut cmd = std::process::Command::new(path);
                cmd.args(&args);
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                }
                cmd.spawn().map_err(|e| format!("spawn exe: {}", e))?;
                return Ok(());
            }
            let ps_path = format!("'{}'", path.replace('\'', "''"));
            let cmd = if args.is_empty() {
                format!("Start-Process -FilePath {}", ps_path)
            } else {
                let quoted: Vec<String> = args
                    .iter()
                    .map(|a| format!("'{}'", a.replace('\'', "''")))
                    .collect();
                format!(
                    "Start-Process -FilePath {} -ArgumentList @({})",
                    ps_path,
                    quoted.join(", ")
                )
            };
            let output = app
                .shell()
                .command("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &cmd,
                ])
                .output()
                .await
                .map_err(|e| format!("spawn exe: {}", e))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                return Err(format!("Start-Process failed: {}", stderr.trim()));
            }
            Ok(())
        }
        "folder" => {
            let path = item.path.as_deref().unwrap_or("").trim();
            path_ps_safe(path)?;
            if !std::path::Path::new(path).is_dir() {
                return Err(format!("folder not found: {}", path));
            }
            let ps_path = format!("'{}'", path.replace('\'', "''"));
            let cmd = format!(
                "Start-Process -FilePath explorer.exe -ArgumentList {}",
                ps_path
            );
            let _ = app
                .shell()
                .command("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &cmd,
                ])
                .output()
                .await
                .map_err(|e| format!("spawn explorer: {}", e))?;
            Ok(())
        }
        "claude" | "codex" => {
            let cwd = item.cwd.clone();
            let kind = item.kind.clone();
            crate::sessions::spawn_session_inner(app, kind, None, cwd, None)
                .await
                .map(|_| ())
        }
        "session" => {
            let cwd = item.cwd.clone();
            let provider = item
                .provider
                .clone()
                .unwrap_or_else(|| "claude".to_string());
            crate::sessions::spawn_session_inner(app, provider, None, cwd, None)
                .await
                .map(|_| ())
        }
        "ide" => {
            let direct_path = item
                .path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if let Some(p) = direct_path {
                return open_in_ide(p, item.cwd.as_deref()).await;
            }
            Err("ide item needs `path` (or move it onto the project's preferred_ide)".into())
        }
        other => Err(format!("unknown launcher kind '{}'", other)),
    }
}
