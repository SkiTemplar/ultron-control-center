// v2.6 — External-editor + sandboxed-read helpers for the Library detail pane.
//
// Two commands live here, both consumed by `Skills.tsx`, `Agents.tsx`, and
// `Rules.tsx` after the v2.6 "card → detail-pane" redesign:
//
// 1. `open_in_vscode(folder_path, file_path)` — opens the parent workspace
//    folder in VS Code AND focuses the specific file inside it. Used by the
//    "Open Externally" button: skills with multi-file workspaces (SKILL.md +
//    examples + python helpers) come up with the whole folder visible while
//    the requested file is the active tab. When `file_path` is empty (e.g. a
//    standalone agent .md), it falls back to opening just that single file.
//    Windows ships `code` as a `.cmd` shim, so we wrap with `cmd.exe /C` the
//    same way `open_folder_in_vscode` already does.
//
// 2. `read_text_file(path)` — bounded read of any UTF-8 text file inside the
//    user's `~/.claude/`, `~/.ultron/`, or `<project>/.claude/` trees. The
//    detail pane uses it to load the body of plugin-scoped skills / agents
//    (which have absolute paths instead of slug-addressable names) and the
//    sibling files surfaced by `list_skill_files`. We sandbox to the three
//    roots above so a renderer bug can't surface `C:\Windows\System32\…`.

use std::path::{Path, PathBuf};

/// Open a folder in VS Code with a specific file focused inside it. The
/// frontend uses this when the user clicks "Open Externally" on a skill or
/// agent card: the skill's parent folder becomes the workspace and the file
/// itself becomes the focused tab.
///
/// Arguments:
///   - `folder_path` — absolute path of the workspace folder to open. May be
///     empty when the entry has no parent folder (rare — falls back to
///     opening just the file).
///   - `file_path`   — absolute path of the file to focus inside the
///     workspace. May be empty when the caller only wants to open the folder.
///
/// Failure modes:
///   - both arguments empty                     → `Err("nothing to open")`
///   - non-existent folder OR file              → `Err("path not found …")`
///   - `code` not on PATH / cmd.exe missing     → `Err("spawn code: …")`
///   - VS Code returns a non-zero exit status   → `Err("code exited …")`
#[tauri::command]
pub async fn open_in_vscode(folder_path: String, file_path: String) -> Result<(), String> {
    let folder = folder_path.trim();
    let file = file_path.trim();
    if folder.is_empty() && file.is_empty() {
        return Err("nothing to open".to_string());
    }

    // Validate inputs early — failing here gives a clearer error than the
    // generic `code exited with status 1` we'd hit otherwise.
    if !folder.is_empty() && !Path::new(folder).exists() {
        return Err(format!("folder not found: {folder}"));
    }
    if !file.is_empty() && !Path::new(file).exists() {
        return Err(format!("file not found: {file}"));
    }

    let folder_arg = folder.to_string();
    let file_arg = file.to_string();
    let status = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Wrap with `cmd.exe /C code …` so the `code.cmd` shim on PATHEXT
            // resolves correctly — `Command::new("code")` does not walk shims
            // on Windows. CREATE_NO_WINDOW keeps cmd.exe from flashing a
            // console for the half-second the child lives.
            let mut cmd = std::process::Command::new("cmd.exe");
            cmd.arg("/C").arg("code");
            if !folder_arg.is_empty() {
                cmd.arg(&folder_arg);
            }
            if !file_arg.is_empty() {
                cmd.arg(&file_arg);
            }
            cmd.creation_flags(0x0800_0000);
            cmd.status()
        }
        #[cfg(not(windows))]
        {
            let mut cmd = std::process::Command::new("code");
            if !folder_arg.is_empty() {
                cmd.arg(&folder_arg);
            }
            if !file_arg.is_empty() {
                cmd.arg(&file_arg);
            }
            cmd.status()
        }
    })
    .await
    .map_err(|e| format!("spawn join: {e}"))?
    .map_err(|e| format!("spawn code: {e}"))?;

    if !status.success() {
        return Err(format!("code exited with status {status}"));
    }
    Ok(())
}

/// Compute the list of canonical roots a Library detail pane is allowed to
/// read from. Anything outside this set is rejected with an error so a
/// renderer bug can't surface arbitrary files from `C:\Windows`.
fn allowed_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        // Personal Claude data: skills, agents, rules, commands, plugins.
        roots.push(home.join(".claude"));
        // ULTRON tree: cockpit/projects/<id>/.claude/* lives here.
        roots.push(home.join(".ultron"));
    }
    roots
        .into_iter()
        .map(|p| std::fs::canonicalize(&p).unwrap_or(p))
        .collect()
}

/// Read a UTF-8 text file by absolute path, sandboxed to the Library's
/// allowed roots (see `allowed_roots`). Used by the Skills / Agents detail
/// pane to load bodies and sibling files that the slug-based readers
/// (`read_skill_md`, `read_agent_md`) can't reach — plugin-scoped entries
/// and arbitrary `.md` / `.py` siblings.
///
/// Hard caps:
///   - file size: 4 MiB. The detail pane is for human-readable docs, not
///     for piping a 50 MB log into the WebView.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let raw = PathBuf::from(&path);
    if !raw.exists() {
        return Err(format!("path not found: {path}"));
    }
    let canonical = std::fs::canonicalize(&raw).map_err(|e| format!("canonicalize {path}: {e}"))?;
    if !canonical.is_file() {
        return Err(format!("not a file: {path}"));
    }

    let roots = allowed_roots();
    let inside = roots.iter().any(|r| canonical.starts_with(r));
    if !inside {
        return Err(format!(
            "path {} outside allowed roots",
            canonical.display()
        ));
    }

    // Size cap before reading so a bad path can't OOM the renderer.
    let metadata =
        std::fs::metadata(&canonical).map_err(|e| format!("stat {}: {e}", canonical.display()))?;
    const MAX_BYTES: u64 = 4 * 1024 * 1024;
    if metadata.len() > MAX_BYTES {
        return Err(format!(
            "file too large ({} bytes > {} cap)",
            metadata.len(),
            MAX_BYTES
        ));
    }

    std::fs::read_to_string(&canonical).map_err(|e| format!("read {}: {e}", canonical.display()))
}
