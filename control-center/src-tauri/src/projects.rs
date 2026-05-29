// ULTRON Control Center — Projects module.
//
// Reads ~/.ultron/cockpit/projects.json (registry built by
// scripts/cockpit/scan_projects.py). Exposes a flat list with the fields
// the UI needs for the workspace picker + Projects tab.
//
// v15.2 — Projects are reframed as "launch groups": each entry holds a
// list of `items` (exe, folder, claude, codex) that can be launched
// together. The old per-project `actions` whitelist is gone.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Process-wide write lock
// ---------------------------------------------------------------------------
//
// Every mutator does a load-all → modify → atomic_write cycle. Without a
// lock, two concurrent Tauri commands (e.g. `create_project` racing with
// `update_project`) both read the same baseline and the second writer
// clobbers the first writer's change — silent data loss. The lock is held
// across the whole read-modify-write so the operation is atomic from the
// caller's point of view. Same pattern as `sessions_tags::SESSIONS_TAGS_WRITE_LOCK`
// and `kg::kg_write_lock`. Pure reads (`list_projects_inner`, `load_items_for`)
// are excluded intentionally.
static PROJECTS_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn projects_lock() -> &'static Mutex<()> {
    PROJECTS_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

/// One thing to launch as part of a project. `kind` discriminates the
/// payload:
///   - "exe"    → `path` (absolute), optional `args[]`. Spawned with
///                Start-Process so the parent doesn't wait.
///   - "folder" → `path` (absolute directory). Revealed in Explorer.
///   - "claude" → `cwd` (absolute directory). Forwarded to
///                `sessions::spawn_session_inner`.
///   - "codex"  → `cwd` (absolute directory). Same as claude but for codex.
/// `label` is optional UI text; when absent the UI derives one from the path.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LauncherItem {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// v15.4.11 — only meaningful when `kind == "session"`. One of
    /// "claude" / "codex" / "gemini". Lets the UI consolidate the
    /// three legacy kinds behind a single "Sesión AI" entry with a
    /// provider sub-selector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProjectInfo {
    pub id: String,
    pub name: Option<String>,
    pub path: Option<String>,
    pub ide: Option<String>,
    pub language: Option<String>,
    pub type_: Option<String>,
    pub status: Option<String>,
    pub last_active: Option<String>,
    pub tags: Vec<String>,
    /// Per-project launcher items. When the registry entry omits an
    /// `items[]` array AND has a `path`, the loader synthesises a default
    /// `[folder(path), claude(path)]` pair at read time so old-style entries
    /// keep working without an on-disk migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<LauncherItem>>,
    /// Preferred session provider when the user hits the project's "main
    /// launch" path: one of "claude" | "codex" | "gemini". The frontend uses
    /// it to mark the corresponding chip as the default. Old registries
    /// without the field default to "claude" at read time — see
    /// `list_projects_inner`. The launch dispatch is provider-agnostic; this
    /// field is pure metadata.
    pub default_provider: Option<String>,
    /// fb-016 — preferred default shell for new terminals spawned inside
    /// this project's workspace. One of "powershell" | "powershell-admin" |
    /// "cmd" | "bash". `None` falls back to the global default. Pure
    /// metadata — the PTY layer reads it when it spawns a non-AI terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_shell: Option<String>,
    /// fb-016 — override the cwd terminals open in. When set (and a real
    /// directory on disk) terminals start here instead of `path`. Use case:
    /// the project lives at `repo/` but most work happens in `repo/app/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_folder_override: Option<String>,
    /// fb-016 — free-form notes about the project. Distinct from the Notes
    /// tab (which manages standalone notes). This is a single textarea the
    /// user sees in the project edit modal — useful for stack reminders,
    /// gotchas, todos that don't deserve a kanban card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// v2.6.2 — Quick Launch executables surfaced on the project home. Each
    /// entry pairs a display name with an .exe / .lnk / .bat / .cmd path
    /// that `launch_project_executable` can spawn directly. Distinct from
    /// `items[]` (the Projects-tab launcher chips): this list is intentionally
    /// kept thin so the Project home can show big buttons without forcing the
    /// user to use the chip wizard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executables: Option<Vec<ExecutableEntry>>,
}

/// v2.6.2 — single Quick Launch executable. `name` is the user-facing label;
/// `path` must point at a .exe / .lnk / .bat / .cmd that
/// `launch_project_executable` can spawn. `args` / `icon` are reserved for
/// future expansion; serde keeps them optional so older registries round-trip
/// without rewriting.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExecutableEntry {
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProjectsRoot {
    #[serde(default)]
    projects: Vec<RegEntry>,
}

#[derive(Debug, Deserialize)]
struct RegEntry {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    ide: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default, rename = "type")]
    type_: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    last_active: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    items: Option<Vec<LauncherItem>>,
    #[serde(default)]
    default_provider: Option<String>,
    #[serde(default)]
    default_shell: Option<String>,
    #[serde(default)]
    parent_folder_override: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    executables: Option<Vec<ExecutableEntry>>,
}

/// Allowed values for `Project.default_provider`. Centralised so backend
/// commands (set_default_provider, create_project, update_project) and the
/// load-time normaliser stay in lock-step.
const VALID_PROVIDERS: &[&str] = &["claude", "codex", "gemini"];

/// fb-016 — allowed values for `Project.default_shell`. Anything outside
/// the allowlist collapses to None at load time so the PTY layer falls
/// back to the global default. Aliases ("pwsh" → "powershell") accepted
/// in the normaliser below.
const VALID_SHELLS: &[&str] = &["powershell", "powershell-admin", "cmd", "bash"];

/// Allowed values for the per-project preferred IDE. Used by the editor
/// modal dropdown and consumed by `open_project_in_ide` to skip auto-detect.
/// Legacy values (e.g. "external", "app", "game", anything else) collapse
/// to `None` at load time so the row falls back to the auto-detect path.
const VALID_IDES: &[&str] = &[
    "vscode",
    "cursor",
    "code-insiders",
    "intellij",
    "rider",
    "webstorm",
    "pycharm",
    "clion",
    "androidstudio",
    "fleet",
    "nvim",
    "sublime",
    "zed",
];

/// fb-016 — coerce a raw `default_shell` to one of the four supported
/// shells or None. Accepts a small set of aliases so manually-edited
/// registries keep working ("pwsh" → "powershell", "powershell admin"
/// with spaces, etc).
fn normalise_shell(raw: Option<&str>) -> Option<String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty())?;
    let lower = s.to_ascii_lowercase();
    let canonical = match lower.as_str() {
        "powershell" | "pwsh" | "ps" => Some("powershell"),
        "powershell-admin" | "powershell admin" | "pwsh-admin" | "admin" => {
            Some("powershell-admin")
        }
        "cmd" | "cmd.exe" => Some("cmd"),
        "bash" | "git-bash" | "wsl" => Some("bash"),
        _ => None,
    };
    canonical.map(|s| s.to_string()).or_else(|| {
        if VALID_SHELLS.contains(&lower.as_str()) {
            Some(lower)
        } else {
            None
        }
    })
}

fn normalise_provider(raw: Option<&str>) -> String {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            let lower = s.to_ascii_lowercase();
            if VALID_PROVIDERS.contains(&lower.as_str()) {
                lower
            } else {
                "claude".to_string()
            }
        }
        None => "claude".to_string(),
    }
}

/// Coerce a raw `ide` field from projects.json to one of the supported
/// editor slugs or `None`. We accept a few aliases ("code" → vscode,
/// "vs code" → vscode) so manually-edited registry files keep working.
fn normalise_ide(raw: Option<&str>) -> Option<String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty())?;
    let lower = s.to_ascii_lowercase();
    let canonical = match lower.as_str() {
        "vscode" | "vs code" | "code" => Some("vscode"),
        "cursor" => Some("cursor"),
        "code-insiders" | "code insiders" | "vscode-insiders" | "insiders" => {
            Some("code-insiders")
        }
        "intellij" | "idea" | "intellij idea" => Some("intellij"),
        "rider" => Some("rider"),
        "webstorm" => Some("webstorm"),
        "pycharm" => Some("pycharm"),
        "clion" | "c-lion" | "c lion" => Some("clion"),
        "androidstudio" | "android studio" | "android-studio" => Some("androidstudio"),
        "fleet" => Some("fleet"),
        "nvim" | "neovim" => Some("nvim"),
        "sublime" | "sublime text" | "subl" => Some("sublime"),
        "zed" => Some("zed"),
        _ => None,
    };
    canonical.map(|s| s.to_string()).or_else(|| {
        // Pass through anything else that already happens to be in the
        // allowlist (defensive — covers future additions to VALID_IDES).
        if VALID_IDES.contains(&lower.as_str()) {
            Some(lower)
        } else {
            None
        }
    })
}

fn registry_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/cockpit/projects.json"))
}

use serde::Deserialize as _Deserialize;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Serialize, Clone)]
pub struct ProjectActionResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// Path to the Python project launcher (scripts/cockpit/launch_project.py).
/// v15.4: replaces the legacy `ultron.ps1 open <id>` hop. The Tauri backend
/// now calls the Python script directly via `uv run python`, removing the
/// PowerShell dispatcher from the control-center's runtime dependencies.
fn launch_project_py_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/scripts/cockpit/launch_project.py"))
}

/// CC-08 hardening: defensive sanity check before a path string is
/// interpolated into a PowerShell `-Command` argument. PowerShell
/// single-quoted strings are *literal* (so `;`, `` ` ``, `$`, `&`, `|`
/// inside them don't dispatch), but a malformed projects.json that
/// somehow contains a NUL byte, embedded newline, or path-traversal
/// segment is still pathological — we reject it instead of hoping PS
/// does the right thing. Callers that target a bare `.exe` should
/// prefer `Command::new(path).spawn()` (no PS at all) over this; this
/// helper covers the ShellExecute-required cases (.lnk / .url / .bat /
/// .cmd / .pdf / .html) and the folder reveal.
fn path_ps_safe(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("path is empty".into());
    }
    // Any control char (NUL / CR / LF / etc) is automatic-reject — they
    // would let the path break out of the single-quoted PS payload.
    if path.chars().any(|c| c.is_control()) {
        return Err("path contains control characters".into());
    }
    // Path-traversal sentinel — projects.json must hold canonical
    // absolute paths, not relative `..\..\..` chains. If the launch
    // path is relative or contains traversal we refuse, since we have
    // no way to ground it safely from the Tauri runtime.
    if path.contains("..\\") || path.contains("../") {
        return Err("path traversal segments are not allowed".into());
    }
    Ok(())
}

/// Open a project by id. v15.4 migration: no longer shells out to
/// `ultron.ps1`. Three fast paths handled in pure Rust:
///   1. `path` points to a file (.exe / .lnk / .bat / .url / .pdf / .html /
///      .cmd) OR `ide` is one of the "external launcher" kinds — Start-Process
///      it directly.
///   2. `path` is an existing directory AND `ide` is one of the editor slugs
///      Rust knows ("vscode" / "cursor" / "code-insiders" plus their aliases)
///      — delegate to `open_in_ide` (the same helper used by `launch_all`).
///   3. Anything else (JetBrains tools, UnityHub, AndroidStudio, missing IDE,
///      etc.) falls through to `launch_project.py` via `uv run python`, which
///      owns the full launcher matrix (Rider, Webstorm, UnityHub, CLion,
///      PyCharm, VisualStudio, …) plus context.md prefill.
pub async fn open_project_inner(
    app: &tauri::AppHandle,
    id: String,
) -> Result<ProjectActionResult, String> {
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!("invalid project id '{}'", id));
    }
    let registry = registry_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = std::fs::read_to_string(&registry)
        .map_err(|e| format!("read projects.json: {}", e))?;
    let root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    let entry = root
        .get("projects")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find(|p| p.get("id").and_then(|x| x.as_str()) == Some(id.as_str()))
        })
        .cloned()
        .ok_or_else(|| format!("project '{}' not found", id))?;

    let ide = entry.get("ide").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let path = entry.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let path_ref = std::path::Path::new(&path);
    let is_file = path_ref.is_file();
    let is_dir = path_ref.is_dir();
    let is_external_kind = matches!(
        ide.to_lowercase().as_str(),
        "external" | "app" | "game" | "browser"
    );

    // Path 1: external launcher (file path or "external"/"app"/"game"/"browser" IDE).
    // CC-08 hardening: defensive validation BEFORE the path enters any
    // PS payload. Bare .exe files bypass PS entirely via
    // `std::process::Command::new(path).spawn()` — there's no shell
    // interpolation surface there at all, so even a malicious projects.json
    // can't smuggle metachars into a parent shell. Other launcher kinds
    // (.lnk / .url / .bat / .cmd / .pdf / .html) need PS Start-Process
    // for ShellExecute association handling, so they still go through PS
    // but only after `path_ps_safe` rejects control chars / traversal.
    if !path.is_empty() && (is_file || is_external_kind) {
        path_ps_safe(&path)?;
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".exe") {
            // No shell — Command::new gets the path as an argv element.
            // CreateProcess interprets it as the binary path, full stop.
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
        // .lnk / .url / .bat / .cmd / .pdf / .html — keep ShellExecute via PS,
        // but path_ps_safe already vetoed any control char / traversal.
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

    // Path 2: directory + Rust-known editor slug → delegate to open_in_ide.
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
                    // Fall through to Python launcher rather than aborting —
                    // it has its own fallback chain (JetBrains Toolbox, etc).
                    eprintln!("[projects] open_in_ide({}, {}) failed: {} — falling back to launch_project.py", id, slug, e);
                }
            }
        }
    }

    // Path 3: defer to launch_project.py (Rider, UnityHub, CLion, PyCharm,
    // Webstorm, AndroidStudio, etc — plus context.md prefill).
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

/// Slugify a free-form name into a registry-safe id.
fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

#[derive(Debug, _Deserialize)]
pub struct CreateProjectPayload {
    pub name: String,
    pub path: String,
    pub ide: Option<String>,
    pub language: Option<String>,
    pub tags: Option<Vec<String>>,
    /// One of "claude" | "codex" | "gemini". Anything else (or absent) is
    /// normalised to "claude" before being written to projects.json.
    pub default_provider: Option<String>,
    /// fb-016 — preferred shell for non-AI terminals (optional).
    pub default_shell: Option<String>,
    /// fb-016 — override the cwd that terminals open in (optional).
    pub parent_folder_override: Option<String>,
    /// fb-016 — free-form notes (optional).
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CreateProjectResult {
    pub success: bool,
    pub id: String,
    pub message: String,
}

/// Append a new project to ~/.ultron/cockpit/projects.json directly. Avoids
/// invoking project_editor.py (which routes through an LLM for description
/// generation we don't need here). Idempotency: if the id collides, we
/// suffix -2, -3, etc.
///
/// `path` is now optional in spirit — the user may create a "launch group"
/// with no root path and rely entirely on `items[]`. We keep accepting an
/// empty string and skip the existence check in that case, but still reject
/// UNC paths defensively.
pub fn create_project_inner(p: CreateProjectPayload) -> Result<CreateProjectResult, String> {
    use std::path::Path;
    if p.name.trim().is_empty() {
        return Err("name is empty".to_string());
    }
    let raw_path = p.path.trim().to_string();
    let path_provided = !raw_path.is_empty();
    if path_provided {
        let path = Path::new(&raw_path);
        // Reject UNC and exotic prefixes — only local drive paths. UNC opens
        // the door to "create project pointing at \\\\evil.example.com\\share\\stage.exe"
        // and then "Open" runs the remote binary via Start-Process. Defense in
        // depth on top of the registry write being authenticated.
        let path_str = path.to_string_lossy();
        if path_str.starts_with(r"\\") || path_str.starts_with("//") {
            return Err("UNC paths are not allowed".into());
        }
        if !path.is_dir() && !path.is_file() {
            return Err(format!("path does not exist: {}", raw_path));
        }
        // For file entries, restrict the extension to the known launcher types.
        if path.is_file() {
            let allowed_ext = ["exe", "lnk", "bat", "cmd", "url", "html", "pdf"];
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            if !allowed_ext.contains(&ext.as_str()) {
                return Err(format!(
                    "file extension '{}' not allowed for project path (allowed: {})",
                    ext,
                    allowed_ext.join(", ")
                ));
            }
        }
    }
    let base_id = slugify(&p.name);
    if base_id.is_empty() {
        return Err("name produced empty id after slugify".to_string());
    }

    let _guard = projects_lock()
        .lock()
        .map_err(|e| format!("projects write lock poisoned: {}", e))?;

    let registry = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/cockpit/projects.json");
    let raw = std::fs::read_to_string(&registry)
        .map_err(|e| format!("read projects.json: {}", e))?;
    let mut root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;

    let projects = root
        .get_mut("projects")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "projects.json has no projects[]".to_string())?;

    // Compute a unique id
    let existing_ids: std::collections::HashSet<String> = projects
        .iter()
        .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let mut id = base_id.clone();
    let mut i = 2u32;
    while existing_ids.contains(&id) {
        id = format!("{}-{}", base_id, i);
        i += 1;
    }

    let today = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| {
            let secs = d.as_secs() as i64;
            let mut days = secs / 86_400;
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
                31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
            ];
            let mut month = 0usize;
            while month < 12 && days >= mdays[month] {
                days -= mdays[month];
                month += 1;
            }
            format!("{:04}-{:02}-{:02}", year, month + 1, days + 1)
        })
        .unwrap_or_else(|_| "1970-01-01".to_string());

    let default_provider = normalise_provider(p.default_provider.as_deref());
    let default_shell = normalise_shell(p.default_shell.as_deref());
    let parent_folder_override = p
        .parent_folder_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let notes = p
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mut new_entry = serde_json::json!({
        "id": id,
        "name": p.name.trim(),
        "path": raw_path,
        "ide": p.ide.unwrap_or_default(),
        "language": p.language.unwrap_or_default(),
        "type": "",
        "deadline": "",
        "last_active": today,
        "status": "manual",
        "tags": p.tags.unwrap_or_default(),
        "auto_tags": [],
        "items": [],
        "default_provider": default_provider,
    });
    // fb-016 — only write the new fields when they carry a value so we
    // don't bloat projects.json with empty strings on every create.
    if let Some(shell) = default_shell {
        new_entry["default_shell"] = serde_json::Value::String(shell);
    }
    if let Some(folder) = parent_folder_override {
        new_entry["parent_folder_override"] = serde_json::Value::String(folder);
    }
    if let Some(n) = notes {
        new_entry["notes"] = serde_json::Value::String(n);
    }
    projects.push(new_entry);

    // Update last_scan to now (ISO).
    if let Some(obj) = root.as_object_mut() {
        obj.insert(
            "last_scan".to_string(),
            serde_json::Value::String(today.clone() + "T00:00:00"),
        );
    }

    let serialized =
        serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    atomic_write(&registry, &serialized)?;

    Ok(CreateProjectResult {
        success: true,
        id: id.clone(),
        message: format!("created project '{}'", id),
    })
}

#[derive(Debug, _Deserialize)]
pub struct UpdateProjectPayload {
    pub id: String,
    pub name: Option<String>,
    pub path: Option<String>,
    pub ide: Option<String>,
    pub language: Option<String>,
    pub tags: Option<Vec<String>>,
    /// Optional update for the project's default provider. None = leave the
    /// existing value untouched (consistent with the rest of the patch
    /// fields). Any non-`claude/codex/gemini` value collapses to "claude".
    pub default_provider: Option<String>,
    /// fb-016 — patch the default shell. Empty string clears the field
    /// (loader will read it back as None). Unknown values collapse to None
    /// at write time so the registry stays clean.
    pub default_shell: Option<String>,
    /// fb-016 — patch the parent_folder_override. Empty string clears.
    pub parent_folder_override: Option<String>,
    /// fb-016 — patch the free-form notes. Empty string clears.
    pub notes: Option<String>,
    /// v2.6.2 — patch the Quick Launch executables list. Some(empty vec)
    /// clears the list; None leaves it alone (consistent with the rest of
    /// the patch fields). Entries with an empty name or path are dropped
    /// before persistence.
    pub executables: Option<Vec<ExecutableEntry>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct UpdateProjectResult {
    pub success: bool,
    pub id: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DeleteProjectResult {
    pub success: bool,
    pub id: String,
}

/// Patch an existing entry in projects.json. Only fields explicitly provided
/// (Some) get touched; the rest are preserved. Atomic write through a temp
/// file so a crash mid-write doesn't corrupt the registry.
pub fn update_project_inner(p: UpdateProjectPayload) -> Result<UpdateProjectResult, String> {
    use std::path::Path;
    if p.id.trim().is_empty() {
        return Err("id is empty".to_string());
    }
    let _guard = projects_lock()
        .lock()
        .map_err(|e| format!("projects write lock poisoned: {}", e))?;
    let registry = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/cockpit/projects.json");
    let raw = std::fs::read_to_string(&registry)
        .map_err(|e| format!("read projects.json: {}", e))?;
    let mut root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    let projects = root
        .get_mut("projects")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "projects.json has no projects[]".to_string())?;

    let target = projects.iter_mut().find(|v| {
        v.get("id").and_then(|x| x.as_str()).map(String::from) == Some(p.id.clone())
    });
    let entry = match target {
        Some(e) => e,
        None => return Err(format!("project '{}' not found", p.id)),
    };

    if let Some(name) = p.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        entry["name"] = serde_json::Value::String(name.to_string());
    }
    if let Some(path) = p.path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // Soft-validate: warn-only if missing — the user may be fixing a
        // moved folder. Fail only when the value is syntactically broken.
        let _ = Path::new(path);
        entry["path"] = serde_json::Value::String(path.to_string());
    }
    if let Some(ide) = p.ide.as_deref() {
        // Empty string → clear the field. Anything non-empty gets
        // normalised; an unrecognised value collapses to "" so the
        // loader treats it as None on the next read.
        let trimmed = ide.trim();
        if trimmed.is_empty() {
            entry["ide"] = serde_json::Value::String(String::new());
        } else {
            let normalised = normalise_ide(Some(trimmed)).unwrap_or_default();
            entry["ide"] = serde_json::Value::String(normalised);
        }
    }
    if let Some(lang) = p.language.as_deref() {
        entry["language"] = serde_json::Value::String(lang.trim().to_string());
    }
    if let Some(tags) = p.tags.as_ref() {
        let arr: Vec<serde_json::Value> = tags
            .iter()
            .filter_map(|t| {
                let t = t.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(serde_json::Value::String(t.to_string()))
                }
            })
            .collect();
        entry["tags"] = serde_json::Value::Array(arr);
    }
    if let Some(prov) = p.default_provider.as_deref() {
        // Normalise unconditionally so a bad client value can't poison the
        // registry. Storing "" or a typo would force the frontend into a
        // fallback path on every render.
        entry["default_provider"] = serde_json::Value::String(normalise_provider(Some(prov)));
    }
    // fb-016 — three new optional fields. Empty string = clear (write Null
    // so it disappears from projects.json on the next round-trip).
    if let Some(raw) = p.default_shell.as_deref() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            entry["default_shell"] = serde_json::Value::Null;
        } else if let Some(canonical) = normalise_shell(Some(trimmed)) {
            entry["default_shell"] = serde_json::Value::String(canonical);
        } else {
            // Unknown value → clear rather than poison the registry.
            entry["default_shell"] = serde_json::Value::Null;
        }
    }
    if let Some(raw) = p.parent_folder_override.as_deref() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            entry["parent_folder_override"] = serde_json::Value::Null;
        } else {
            entry["parent_folder_override"] = serde_json::Value::String(trimmed.to_string());
        }
    }
    if let Some(raw) = p.notes.as_deref() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            entry["notes"] = serde_json::Value::Null;
        } else {
            entry["notes"] = serde_json::Value::String(trimmed.to_string());
        }
    }
    // v2.6.2 — write the executables list. Empty list = clear the field
    // (Null on disk so we don't bloat the registry with empty arrays).
    if let Some(list) = p.executables.as_ref() {
        let cleaned: Vec<&ExecutableEntry> = list
            .iter()
            .filter(|e| !e.name.trim().is_empty() && !e.path.trim().is_empty())
            .collect();
        if cleaned.is_empty() {
            entry["executables"] = serde_json::Value::Null;
        } else {
            entry["executables"] = serde_json::to_value(&cleaned)
                .map_err(|e| format!("serialize executables: {}", e))?;
        }
    }

    let serialized = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    atomic_write(&registry, &serialized)?;
    Ok(UpdateProjectResult {
        success: true,
        id: p.id,
    })
}

// ---------------------------------------------------------------------------
// v2.6.2 — Quick Launch executable dispatch.
// ---------------------------------------------------------------------------

/// Spawn a Quick Launch executable. We validate the same security envelope as
/// the `exe` launcher chip (`path_ps_safe`) and prefer a direct
/// `Command::new(path)` spawn for `.exe` so we never enter a shell. Other
/// extensions (.lnk / .bat / .cmd / .url) need ShellExecute via PowerShell
/// Start-Process — same code path as `open_project_inner`.
pub async fn launch_project_executable_inner(
    app: &tauri::AppHandle,
    path: String,
) -> Result<ProjectActionResult, String> {
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
    // ShellExecute path for .lnk / .bat / .cmd / .url / .pdf / .html — quoted
    // PowerShell argument, same hardening as `open_project_inner` Path 1.
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

/// Single-field patch for `default_provider`. Used by the icon-only chip
/// inline radio in the Projects tab — cheaper than threading every other
/// Option through `update_project_inner` just to flip this one bit, and
/// keeps the on-disk write surgical (only `default_provider` is touched).
pub fn set_default_provider_inner(
    project_id: String,
    provider: String,
) -> Result<UpdateProjectResult, String> {
    if project_id.trim().is_empty() {
        return Err("project_id is empty".to_string());
    }
    let normalised = normalise_provider(Some(provider.as_str()));
    let _guard = projects_lock()
        .lock()
        .map_err(|e| format!("projects write lock poisoned: {}", e))?;
    let (registry, mut root) = load_registry_mut()?;
    {
        let entry = find_entry_mut(&mut root, &project_id)?;
        entry["default_provider"] = serde_json::Value::String(normalised.clone());

        // v15.2.29: keep the row visually consistent. If the project does
        // not already have a launcher chip for the new provider but has at
        // least one AI chip (claude/codex/gemini), retarget the *first*
        // such chip to the new provider so the user actually sees the icon
        // they just picked. Projects that mix all three providers are left
        // alone — they already display every option and only the highlight
        // border moves.
        if let Some(items) = entry.get_mut("items").and_then(|v| v.as_array_mut()) {
            let providers = ["claude", "codex", "gemini"];
            let already_has_target = items.iter().any(|it| {
                it.get("kind").and_then(|k| k.as_str()) == Some(normalised.as_str())
            });
            if !already_has_target {
                for it in items.iter_mut() {
                    let kind = it
                        .get("kind")
                        .and_then(|k| k.as_str())
                        .unwrap_or("")
                        .to_string();
                    if providers.contains(&kind.as_str()) {
                        it["kind"] = serde_json::Value::String(normalised.clone());
                        break;
                    }
                }
            }
        }
    }
    let serialized =
        serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    atomic_write(&registry, &serialized)?;
    Ok(UpdateProjectResult {
        success: true,
        id: project_id,
    })
}

/// Remove an entry from projects.json by id. Returns success even if the id
/// didn't exist (idempotent), but with a marker so the UI can show a notice.
pub fn delete_project_inner(id: String) -> Result<DeleteProjectResult, String> {
    if id.trim().is_empty() {
        return Err("id is empty".to_string());
    }
    let _guard = projects_lock()
        .lock()
        .map_err(|e| format!("projects write lock poisoned: {}", e))?;
    let registry = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/cockpit/projects.json");
    let raw = std::fs::read_to_string(&registry)
        .map_err(|e| format!("read projects.json: {}", e))?;
    let mut root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    let projects = root
        .get_mut("projects")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "projects.json has no projects[]".to_string())?;
    let before = projects.len();
    projects.retain(|p| p.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
    let after = projects.len();

    let serialized = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    atomic_write(&registry, &serialized)?;

    Ok(DeleteProjectResult {
        success: before != after,
        id,
    })
}

/// Run the project scanner and return the rescanned project list. v15.4:
/// invokes `uv run python scan_projects.py` directly instead of routing
/// through the legacy `ultron.ps1 scan` dispatcher. The Python scanner
/// remains the source of truth for the IDE-detection / tag-inference
/// matrix; this just removes the PowerShell hop.
pub async fn scan_projects_inner(app: &tauri::AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let py = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit/scan_projects.py");
    let py_str = py.to_string_lossy().to_string();
    let _output = app
        .shell()
        .command("uv")
        .args(["run", "python", &py_str])
        .output()
        .await
        .map_err(|e| format!("spawn uv run scan_projects.py: {}", e))?;
    // Re-read the registry — the scan rewrites projects.json
    list_projects_inner()
}

pub fn list_projects_inner() -> Result<Vec<ProjectInfo>, String> {
    let path = registry_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read projects.json: {} ({})", e, path.display()))?;
    let root: ProjectsRoot =
        serde_json::from_str(&raw).map_err(|e| format!("parse projects.json: {}", e))?;

    let mut out: Vec<ProjectInfo> = Vec::with_capacity(root.projects.len());
    for p in root.projects.into_iter() {
        // Backwards-compat synthesis: an old-style entry with no `items[]`
        // but a real `path` gets a default `[folder, claude]` pair so the
        // UI can present launch buttons without forcing the user to migrate.
        // The on-disk file is NOT rewritten — this keeps projects.json
        // portable for the python scanner.
        let synthesised_items = match (&p.items, p.path.as_deref()) {
            (Some(items), _) if !items.is_empty() => Some(items.clone()),
            (Some(_), _) => Some(Vec::new()),
            (None, Some(path)) if !path.trim().is_empty() => Some(vec![
                LauncherItem {
                    kind: "folder".to_string(),
                    path: Some(path.to_string()),
                    cwd: None,
                    args: None,
                    label: Some("Open folder".to_string()),
                    provider: None,
                },
                LauncherItem {
                    kind: "claude".to_string(),
                    path: None,
                    cwd: Some(path.to_string()),
                    args: None,
                    label: Some("New Claude session".to_string()),
                    provider: None,
                },
            ]),
            _ => None,
        };

        // Backwards-compat: registry entries written before v15.x carry no
        // `default_provider`. Normalise to "claude" so the frontend always
        // gets a usable value and never has to defend itself against `None`.
        let default_provider = Some(normalise_provider(p.default_provider.as_deref()));
        // Normalise the editor slug so the frontend dropdown shows a
        // canonical value (or "none" when the registry holds a legacy /
        // unsupported string like "external" or "").
        let ide = normalise_ide(p.ide.as_deref());
        // fb-016 — pass through the new optional fields. `default_shell`
        // is normalised so a typo on disk (e.g. "pwsh") still surfaces as
        // a clean canonical value to the UI.
        let default_shell = normalise_shell(p.default_shell.as_deref());
        let parent_folder_override = p
            .parent_folder_override
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let notes = p
            .notes
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // v2.6.2 — pass through the executables list verbatim. Filter out
        // entries with an empty name or path so a manually-edited registry
        // doesn't render dead buttons.
        let executables = p.executables.map(|list| {
            list.into_iter()
                .filter(|e| !e.name.trim().is_empty() && !e.path.trim().is_empty())
                .collect::<Vec<_>>()
        });
        out.push(ProjectInfo {
            id: p.id,
            name: p.name,
            path: p.path,
            ide,
            language: p.language,
            type_: p.type_,
            status: p.status,
            last_active: p.last_active,
            tags: p.tags,
            items: synthesised_items,
            default_provider,
            default_shell,
            parent_folder_override,
            notes,
            executables,
        });
    }
    // v2.x: synthesise a "Home" entry pointing at the user's home directory
    // if the registry doesn't already cover it. USER uses ~/ as a frequent
    // base for ad-hoc work; the synthetic entry has a stable id ("__home")
    // and shows up alongside scanned projects so the AI/Terminal launch path
    // is one click away. We do NOT persist it to projects.json — it's purely
    // computed at read time so users on different machines see their own
    // home folder without any seed step.
    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy().to_string();
        let already_present = out
            .iter()
            .any(|p| matches!(p.path.as_deref(), Some(p) if p.trim_end_matches('\\').trim_end_matches('/') == home_str.trim_end_matches('\\').trim_end_matches('/')));
        if !already_present {
            out.push(ProjectInfo {
                id: "__home".to_string(),
                name: Some("Home".to_string()),
                path: Some(home_str.clone()),
                ide: None,
                language: None,
                type_: Some("home".to_string()),
                status: Some("manual".to_string()),
                last_active: None,
                tags: vec!["home".to_string()],
                items: Some(vec![
                    LauncherItem {
                        kind: "folder".to_string(),
                        path: Some(home_str.clone()),
                        cwd: None,
                        args: None,
                        label: Some("Open folder".to_string()),
                        provider: None,
                    },
                    LauncherItem {
                        kind: "claude".to_string(),
                        path: None,
                        cwd: Some(home_str),
                        args: None,
                        label: Some("New Claude session".to_string()),
                        provider: None,
                    },
                ]),
                default_provider: Some("claude".to_string()),
                default_shell: None,
                parent_folder_override: None,
                notes: None,
                executables: None,
            });
        }
    }

    // Sort by last_active desc (ISO yyyy-mm-dd compares lexicographically).
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Launcher item management
// ---------------------------------------------------------------------------

/// Tmp-file + rename atomic write. Used everywhere we touch projects.json
/// so a crash between two writes never leaves the registry truncated.
fn atomic_write(registry: &PathBuf, content: &str) -> Result<(), String> {
    let tmp = registry.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, registry).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

/// Validate a launcher item before persisting it. Centralised so add/edit
/// share the same security envelope.
fn validate_launcher_item(item: &LauncherItem) -> Result<(), String> {
    match item.kind.as_str() {
        "exe" | "folder" => {
            let path = item
                .path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("{} item missing path", item.kind))?;
            if path.starts_with(r"\\") || path.starts_with("//") {
                return Err("UNC paths are not allowed".into());
            }
            // CC-08: reject control chars / traversal segments at write time
            // so a malformed payload can't reach the registry in the first
            // place. dispatch_item enforces the same gate at launch time
            // for defence in depth.
            path_ps_safe(path)?;
            // We don't require the path to exist at validation time — the
            // user may be authoring an entry before the binary is installed
            // (e.g. on a fresh Windows box). At launch time the missing-
            // path error surfaces naturally.
        }
        "claude" | "codex" | "gemini" | "session" => {
            // v15.4.11 — `session` (consolidated kind) follows the same
            // shape as the legacy claude/codex/gemini kinds: cwd is
            // mandatory. The actual provider is carried in the `kind`
            // for legacy items, or in the `provider` field for new
            // `session` items. Both shapes coexist for backward compat.
            let cwd = item
                .cwd
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("{} item missing cwd", item.kind))?;
            if cwd.starts_with(r"\\") || cwd.starts_with("//") {
                return Err("UNC paths are not allowed".into());
            }
            path_ps_safe(cwd)?;
        }
        "ide" => {
            // v15.4.11 — `ide` kind: open the project's path in its
            // preferred IDE. No explicit path on the item — the
            // dispatch_item resolver pulls it from the parent project
            // entry. Nothing to validate here beyond the kind itself.
        }
        other => return Err(format!("unknown launcher kind '{}'", other)),
    }
    Ok(())
}

fn load_registry_mut() -> Result<(PathBuf, serde_json::Value), String> {
    let registry = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/cockpit/projects.json");
    let raw = std::fs::read_to_string(&registry)
        .map_err(|e| format!("read projects.json: {}", e))?;
    let root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    Ok((registry, root))
}

fn find_entry_mut<'a>(
    root: &'a mut serde_json::Value,
    id: &str,
) -> Result<&'a mut serde_json::Value, String> {
    let projects = root
        .get_mut("projects")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "projects.json has no projects[]".to_string())?;
    projects
        .iter_mut()
        .find(|v| v.get("id").and_then(|x| x.as_str()) == Some(id))
        .ok_or_else(|| format!("project '{}' not found", id))
}

#[derive(Debug, _Deserialize)]
pub struct AddLauncherItemPayload {
    pub project_id: String,
    pub item: LauncherItem,
}

/// Append a new launcher item to `project.items[]`. Creates the array if
/// it doesn't exist on disk yet (old-style entries).
///
/// v15.4.1 fix: when the project still has empty `items[]` but a non-empty
/// `path`, `load_items_for()` synthesises virtual `folder` + `claude`
/// chips so the UI never looks empty. Appending a new item without first
/// materialising those virtual chips silently drops them (the synthesise
/// branch only triggers when `items` is empty). We now materialise them
/// here so the user's first added item joins the existing folder + claude
/// pair instead of replacing it — matches the behaviour the user expected.
pub fn add_launcher_item_inner(p: AddLauncherItemPayload) -> Result<UpdateProjectResult, String> {
    if p.project_id.trim().is_empty() {
        return Err("project_id is empty".to_string());
    }
    validate_launcher_item(&p.item)?;
    let _guard = projects_lock()
        .lock()
        .map_err(|e| format!("projects write lock poisoned: {}", e))?;
    let (registry, mut root) = load_registry_mut()?;
    {
        let entry = find_entry_mut(&mut root, &p.project_id)?;
        // Capture path before mutably borrowing items — needed to seed the
        // fallback chips when materialising.
        let project_path = entry
            .get("path")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .unwrap_or_default();

        let items = match entry.get_mut("items").and_then(|v| v.as_array_mut()) {
            Some(arr) => arr,
            None => {
                entry["items"] = serde_json::Value::Array(Vec::new());
                entry
                    .get_mut("items")
                    .and_then(|v| v.as_array_mut())
                    .ok_or_else(|| "items array missing after init".to_string())?
            }
        };

        // Materialise the virtual folder + claude chips before appending so
        // the user's first added item joins them instead of replacing them.
        // Only do this when items is empty AND we have a path to seed from
        // AND the incoming item is NOT one of those two chips (else we'd
        // duplicate). When the user adds a folder or a claude chip
        // explicitly we let it stand alone — they signalled intent.
        let is_folder_seed_dup = p.item.kind == "folder";
        let is_claude_seed_dup = p.item.kind == "claude";
        if items.is_empty() && !project_path.trim().is_empty() {
            if !is_folder_seed_dup {
                let folder = LauncherItem {
                    kind: "folder".to_string(),
                    path: Some(project_path.clone()),
                    cwd: None,
                    args: None,
                    label: Some("Open folder".to_string()),
                    provider: None,
                };
                items.push(
                    serde_json::to_value(&folder)
                        .map_err(|e| format!("serialize folder seed: {}", e))?,
                );
            }
            if !is_claude_seed_dup {
                let claude = LauncherItem {
                    kind: "claude".to_string(),
                    path: None,
                    cwd: Some(project_path),
                    args: None,
                    label: Some("New Claude session".to_string()),
                    provider: None,
                };
                items.push(
                    serde_json::to_value(&claude)
                        .map_err(|e| format!("serialize claude seed: {}", e))?,
                );
            }
        }

        items.push(serde_json::to_value(&p.item).map_err(|e| format!("serialize item: {}", e))?);
    }
    let serialized =
        serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    atomic_write(&registry, &serialized)?;
    Ok(UpdateProjectResult {
        success: true,
        id: p.project_id,
    })
}

/// Drop the launcher item at the given index. No-op if out of range, which
/// keeps the UI optimistic-update behaviour predictable.
pub fn remove_launcher_item_inner(
    project_id: String,
    index: usize,
) -> Result<UpdateProjectResult, String> {
    if project_id.trim().is_empty() {
        return Err("project_id is empty".to_string());
    }
    let _guard = projects_lock()
        .lock()
        .map_err(|e| format!("projects write lock poisoned: {}", e))?;
    let (registry, mut root) = load_registry_mut()?;
    {
        let entry = find_entry_mut(&mut root, &project_id)?;
        if let Some(arr) = entry.get_mut("items").and_then(|v| v.as_array_mut()) {
            if index < arr.len() {
                arr.remove(index);
            }
        }
    }
    let serialized =
        serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    atomic_write(&registry, &serialized)?;
    Ok(UpdateProjectResult {
        success: true,
        id: project_id,
    })
}

/// Move an item from `from` to `to` inside the same project. Clamps both
/// indices to the array length so a stale UI can't desync the file.
pub fn reorder_launcher_items_inner(
    project_id: String,
    from: usize,
    to: usize,
) -> Result<UpdateProjectResult, String> {
    if project_id.trim().is_empty() {
        return Err("project_id is empty".to_string());
    }
    let _guard = projects_lock()
        .lock()
        .map_err(|e| format!("projects write lock poisoned: {}", e))?;
    let (registry, mut root) = load_registry_mut()?;
    {
        let entry = find_entry_mut(&mut root, &project_id)?;
        if let Some(arr) = entry.get_mut("items").and_then(|v| v.as_array_mut()) {
            let n = arr.len();
            if n == 0 {
                return Ok(UpdateProjectResult {
                    success: true,
                    id: project_id,
                });
            }
            let from = from.min(n - 1);
            let to = to.min(n - 1);
            if from != to {
                let item = arr.remove(from);
                arr.insert(to, item);
            }
        }
    }
    let serialized =
        serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    atomic_write(&registry, &serialized)?;
    Ok(UpdateProjectResult {
        success: true,
        id: project_id,
    })
}

// ---------------------------------------------------------------------------
// Launch dispatch
// ---------------------------------------------------------------------------

/// Read the live items[] for a project, applying the same backwards-compat
/// synthesis as `list_projects_inner` so launch_item works on legacy entries.
fn load_items_for(project_id: &str) -> Result<Vec<LauncherItem>, String> {
    let registry = registry_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = std::fs::read_to_string(&registry)
        .map_err(|e| format!("read projects.json: {}", e))?;
    let root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    let arr = root
        .get("projects")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "projects.json has no projects[]".to_string())?;
    let entry = arr
        .iter()
        .find(|p| p.get("id").and_then(|x| x.as_str()) == Some(project_id))
        .ok_or_else(|| format!("project '{}' not found", project_id))?;
    // First try the explicit items[] field.
    if let Some(items_v) = entry.get("items").and_then(|v| v.as_array()) {
        if !items_v.is_empty() {
            let items: Vec<LauncherItem> = items_v
                .iter()
                .map(|v| serde_json::from_value(v.clone()))
                .collect::<Result<_, _>>()
                .map_err(|e| format!("parse items: {}", e))?;
            return Ok(items);
        }
    }
    // Backwards-compat fallback.
    if let Some(path) = entry.get("path").and_then(|v| v.as_str()) {
        if !path.trim().is_empty() {
            return Ok(vec![
                LauncherItem {
                    kind: "folder".to_string(),
                    path: Some(path.to_string()),
                    cwd: None,
                    args: None,
                    label: Some("Open folder".to_string()),
                    provider: None,
                },
                LauncherItem {
                    kind: "claude".to_string(),
                    path: None,
                    cwd: Some(path.to_string()),
                    args: None,
                    label: Some("New Claude session".to_string()),
                    provider: None,
                },
            ]);
        }
    }
    Ok(Vec::new())
}

/// Spawn a single launcher item. Returns Ok(()) on success; per-item errors
/// surface up so the UI can render a toast. Used both directly (single-item
/// "Open" button) and as the loop body of `launch_all_items_inner`.
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
/// successfully. The UI surfaces this so the user knows "3 of 4 started".
///
/// v15.2.x semantics:
///   - `folder` items are SKIPPED. Opening Explorer alongside the IDE was
///     redundant and the user wanted a clean "providers + IDE" launch.
///     The folder chip still works when clicked individually.
///   - When the project has a preferred `ide` set, we additionally invoke
///     the IDE opener with that explicit preference. Projects with no
///     `ide` set get nothing extra (the IDE button is still available on
///     each row).
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
        // Skip folder chips — the user wanted "Launch all" to fire only
        // providers + IDE, never Explorer. Folder remains launchable via
        // its own chip click.
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

    // Additionally, if the project has a preferred IDE set, fire it. We
    // do this best-effort: failures (no IDE on PATH, missing project path)
    // are logged but don't subtract from `launched`. The chip-based count
    // already reflects providers; the IDE is the "+ implicit" launch.
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
/// both are non-empty and the path exists on disk. Used by
/// `launch_all_items_inner` to decide whether to fire the IDE opener.
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
/// Mirrors the logic in `lib.rs::open_project_in_ide` but lives here so
/// `launch_all_items_inner` doesn't need an AppHandle round-trip. The
/// frontend command still goes through lib.rs.
pub async fn open_in_ide(path: &str, preferred: Option<&str>) -> Result<(), String> {
    let p = std::path::PathBuf::from(path);
    if !p.is_dir() && !p.is_file() {
        return Err(format!("path not found: {}", path));
    }
    let canonical = p.canonicalize().map_err(|e| format!("canonicalize: {}", e))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    let cleaned = canonical_str
        .strip_prefix(r"\\?\")
        .unwrap_or(&canonical_str)
        .to_string();

    // Map our slug to the CLI binary name on PATH. "vscode" maps to
    // `code`; cursor and code-insiders ship the CLI under their own name.
    // JetBrains IDEs ship `idea64.exe` / `rider64.exe` / etc. when the
    // "Generate shell scripts" option is enabled in Toolbox; we accept
    // the short forms here. Sublime is `subl`, neovim is `nvim`.
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

    // Build the ordered list of CLIs to try. With a preference set, that
    // CLI is tried first and the rest of the catalogue acts as fallback so
    // the user always gets *some* editor instead of an error.
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
/// implementation and we only have one place to update when a new kind
/// joins the family.
async fn dispatch_item(app: &tauri::AppHandle, item: &LauncherItem) -> Result<(), String> {
    validate_launcher_item(item)?;
    match item.kind.as_str() {
        "exe" => {
            let path = item.path.as_deref().unwrap_or("").trim();
            // CC-08 hardening: defensive reject before path enters any PS
            // payload. Control chars / traversal segments get refused even
            // though single-quoted PS strings are literal — defence in depth.
            path_ps_safe(path)?;
            let exe_path = std::path::Path::new(path);
            if !exe_path.is_file() {
                return Err(format!("exe not found: {}", path));
            }
            let args = item.args.clone().unwrap_or_default();
            // arg-level control-char veto: a `\r\n` smuggled into args would
            // let an attacker break out of Start-Process's -ArgumentList.
            for a in &args {
                if a.chars().any(|c| c.is_control()) {
                    return Err("launcher argument contains control characters".into());
                }
            }
            // CC-08: bare .exe goes through std::process::Command directly —
            // no shell, no interpolation surface at all. Other extensions
            // (.lnk/.bat/.cmd/.url/.pdf/.html) need PS Start-Process for
            // ShellExecute association handling.
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
            // .lnk / .url / .bat / .cmd / .pdf / .html — Start-Process via PS.
            // Single-quoted PS strings keep `;`, `` ` ``, `$`, `&`, `|`
            // literal, so the path_ps_safe veto on control chars / traversal
            // is the meaningful defence here.
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
            // CC-08 hardening: vet the path before it lands in any PS payload.
            path_ps_safe(path)?;
            if !std::path::Path::new(path).is_dir() {
                return Err(format!("folder not found: {}", path));
            }
            // explorer.exe ignores its exit code in some scenarios; treat
            // spawn-success as enough. Quoting via PowerShell to keep the
            // path with spaces intact.
            let ps_path = format!("'{}'", path.replace('\'', "''"));
            let cmd = format!("Start-Process -FilePath explorer.exe -ArgumentList {}", ps_path);
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
        "claude" | "codex" | "gemini" => {
            // Legacy kinds — kind itself IS the provider.
            let cwd = item.cwd.clone();
            let kind = item.kind.clone();
            crate::sessions::spawn_session_inner(app, kind, None, cwd, None)
                .await
                .map(|_| ())
        }
        "session" => {
            // v15.4.11 — consolidated kind: provider field elige binario.
            // Fallback a claude si el campo no está poblado (mismo
            // default que el resto del sistema).
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
            // v15.4.11 — `ide` kind: open the project's path in its
            // preferred IDE. We need the parent project id, but
            // dispatch_item doesn't carry it directly. Read items from
            // the registry to find the project that owns this item and
            // use its path + preferred_ide. As a fast path, if the
            // item has a `path` field set, use that directly.
            let direct_path = item
                .path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if let Some(p) = direct_path {
                return open_in_ide(p, item.cwd.as_deref()).await;
            }
            Err(
                "ide item needs `path` (or move it onto the project's preferred_ide)"
                    .into(),
            )
        }
        other => Err(format!("unknown launcher kind '{}'", other)),
    }
}

// ---------------------------------------------------------------------------
// Emit-aware wrappers (project.created / project.deleted alerts)
// ---------------------------------------------------------------------------

/// Wrapper that calls `create_project_inner` and, on success, fires an
/// info alert through `toast_emit`. Kept separate so the original
/// inner stays callable from places (e.g. scripts) that don't want
/// notification side-effects.
pub fn create_project_inner_with_emit(
    app: &tauri::AppHandle,
    p: CreateProjectPayload,
) -> Result<CreateProjectResult, String> {
    let name = p.name.trim().to_string();
    let res = create_project_inner(p)?;
    if res.success {
        crate::toast_emit::record_alert_and_maybe_toast(
            app,
            "project.created",
            "info",
            &format!("Project created: {} ({})", name, res.id),
        );
    }
    Ok(res)
}

/// Wrapper that calls `delete_project_inner` and, on actual removal
/// (success=true, i.e. an entry was found), fires an info alert.
pub fn delete_project_inner_with_emit(
    app: &tauri::AppHandle,
    id: String,
) -> Result<DeleteProjectResult, String> {
    let res = delete_project_inner(id.clone())?;
    if res.success {
        crate::toast_emit::record_alert_and_maybe_toast(
            app,
            "project.deleted",
            "info",
            &format!("Project deleted: {}", id),
        );
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalise_ide_accepts_vscode_cursor_insiders() {
        assert_eq!(normalise_ide(Some("vscode")).as_deref(), Some("vscode"));
        // alias: "code" → vscode
        assert_eq!(normalise_ide(Some("code")).as_deref(), Some("vscode"));
        assert_eq!(normalise_ide(Some("VS Code")).as_deref(), Some("vscode"));
        assert_eq!(normalise_ide(Some("cursor")).as_deref(), Some("cursor"));
        assert_eq!(normalise_ide(Some("CURSOR")).as_deref(), Some("cursor"));
        assert_eq!(
            normalise_ide(Some("code-insiders")).as_deref(),
            Some("code-insiders")
        );
        assert_eq!(
            normalise_ide(Some("insiders")).as_deref(),
            Some("code-insiders")
        );
    }

    #[test]
    fn normalise_ide_rejects_unknown() {
        assert!(normalise_ide(Some("emacs")).is_none());
        assert!(normalise_ide(Some("vim")).is_none());
        // Legacy registry values used to land here — they all collapse to None.
        assert!(normalise_ide(Some("external")).is_none());
        assert!(normalise_ide(Some("app")).is_none());
        assert!(normalise_ide(Some("game")).is_none());

        // Empty / whitespace-only / None all return None.
        assert!(normalise_ide(Some("")).is_none());
        assert!(normalise_ide(Some("   ")).is_none());
        assert!(normalise_ide(None).is_none());
    }

    #[test]
    fn launch_all_filters_folder_items() {
        // launch_all_items_inner walks the registry, which we can't easily
        // mock here. Instead we replicate the documented invariant in a
        // doc-style test: a slice of LauncherItems should yield exactly the
        // non-folder kinds when filtered the same way as the inner loop.
        let items = [LauncherItem {
                kind: "folder".into(),
                path: Some(r"C:\proj".into()),
                cwd: None, args: None, label: None,
                    provider: None,
            },
            LauncherItem {
                kind: "claude".into(),
                path: None,
                cwd: Some(r"C:\proj".into()),
                args: None, label: None,
                    provider: None,
            },
            LauncherItem {
                kind: "codex".into(),
                path: None,
                cwd: Some(r"C:\proj".into()),
                args: None, label: None,
                    provider: None,
            },
            LauncherItem {
                kind: "folder".into(),
                path: Some(r"C:\proj\sub".into()),
                cwd: None, args: None, label: None,
                    provider: None,
            }];

        // Match the predicate in launch_all_items_inner — skip kind=="folder".
        let dispatched: Vec<&str> = items
            .iter()
            .filter(|i| i.kind != "folder")
            .map(|i| i.kind.as_str())
            .collect();
        assert_eq!(dispatched, vec!["claude", "codex"]);
    }

    #[test]
    fn normalise_provider_falls_back_to_claude() {
        assert_eq!(normalise_provider(Some("claude")), "claude");
        assert_eq!(normalise_provider(Some("codex")), "codex");
        assert_eq!(normalise_provider(Some("gemini")), "gemini");
        // Unknown → claude
        assert_eq!(normalise_provider(Some("foo")), "claude");
        assert_eq!(normalise_provider(None), "claude");
        assert_eq!(normalise_provider(Some("   ")), "claude");
        // Case insensitive
        assert_eq!(normalise_provider(Some("CLAUDE")), "claude");
    }
}

// LIB_RS_WIRING:
//   1. Existing emit-aware wrappers (kept for reference):
//
//     #[tauri::command]
//     async fn create_project(
//         app: tauri::AppHandle,
//         name: String,
//         path: String,
//         ide: Option<String>,
//         language: Option<String>,
//         tags: Option<Vec<String>>,
//         default_provider: Option<String>,
//     ) -> Result<projects::CreateProjectResult, String> {
//         projects::create_project_inner_with_emit(
//             &app,
//             projects::CreateProjectPayload {
//                 name, path, ide, language, tags, default_provider,
//             },
//         )
//     }
//
//     #[tauri::command]
//     async fn delete_project(
//         app: tauri::AppHandle,
//         id: String,
//     ) -> Result<projects::DeleteProjectResult, String> {
//         projects::delete_project_inner_with_emit(&app, id)
//     }
//
//   2. New command for the inline default-provider selector. Add this
//      function next to `update_project` in lib.rs and reference it in the
//      `tauri::generate_handler![...]` invocation:
//
//     #[tauri::command]
//     async fn set_default_provider(
//         project_id: String,
//         provider: String,
//     ) -> Result<projects::UpdateProjectResult, String> {
//         projects::set_default_provider_inner(project_id, provider)
//     }
//
//      Handler list addition:
//          set_default_provider,
//
//   3. `update_project` now also accepts an optional `default_provider`
//      arg; thread it through `UpdateProjectPayload`:
//
//     #[tauri::command]
//     async fn update_project(
//         id: String,
//         name: Option<String>,
//         path: Option<String>,
//         ide: Option<String>,
//         language: Option<String>,
//         tags: Option<Vec<String>>,
//         default_provider: Option<String>,
//     ) -> Result<projects::UpdateProjectResult, String> {
//         projects::update_project_inner(projects::UpdateProjectPayload {
//             id, name, path, ide, language, tags, default_provider,
//         })
//     }
