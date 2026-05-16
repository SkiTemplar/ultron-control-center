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

use serde::{Deserialize, Serialize};

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

fn ultron_ps1_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/scripts/cockpit/ultron.ps1"))
}

/// Spawn `ultron.ps1 open <id>` and return the result. Validates id against
/// a tight charset on the Rust side so the capability layer just needs the
/// generic shape.
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
    // Look up the entry first. If `ide` is empty AND path points to a file
    // (.exe / .lnk / .bat / .url), bypass ultron.ps1 (which assumes an IDE
    // workflow) and just Start-Process the binary. This lets the registry
    // hold games, GUI apps, and other arbitrary launchers — not just code
    // projects.
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
        .cloned();

    if let Some(entry) = entry {
        let ide = entry.get("ide").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let path = entry.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let path_ref = std::path::Path::new(&path);
        let is_file = path_ref.is_file();
        let is_external_kind = matches!(
            ide.to_lowercase().as_str(),
            "external" | "app" | "game" | "browser"
        );

        if !path.is_empty() && (is_file || is_external_kind) {
            // Start-Process handles .exe, .lnk, .url, .bat, and protocol
            // handlers via ShellExecute. The arg gets wrapped in single
            // quotes inside PowerShell to survive paths with spaces.
            let ps_quoted = format!("'{}'", path.replace('\'', "''"));
            let cmd = format!("Start-Process -FilePath {}", ps_quoted);
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
                .map_err(|e| format!("spawn ps: {}", e))?;
            return Ok(ProjectActionResult {
                success: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                exit_code: output.status.code(),
            });
        }
    }

    let ps = ultron_ps1_path().ok_or_else(|| "no HOME".to_string())?;
    let ps_str = ps.to_string_lossy().to_string();
    let output = app
        .shell()
        .command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &ps_str,
            "open",
            &id,
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

    let new_entry = serde_json::json!({
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
    });
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
        entry["ide"] = serde_json::Value::String(ide.trim().to_string());
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

    let serialized = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    atomic_write(&registry, &serialized)?;
    Ok(UpdateProjectResult {
        success: true,
        id: p.id,
    })
}

/// Remove an entry from projects.json by id. Returns success even if the id
/// didn't exist (idempotent), but with a marker so the UI can show a notice.
pub fn delete_project_inner(id: String) -> Result<DeleteProjectResult, String> {
    if id.trim().is_empty() {
        return Err("id is empty".to_string());
    }
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

/// Run `ultron.ps1 scan` and return the rescanned project list.
pub async fn scan_projects_inner(app: &tauri::AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let ps = ultron_ps1_path().ok_or_else(|| "no HOME".to_string())?;
    let ps_str = ps.to_string_lossy().to_string();
    let _output = app
        .shell()
        .command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &ps_str,
            "scan",
        ])
        .output()
        .await
        .map_err(|e| format!("spawn ps: {}", e))?;
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
                },
                LauncherItem {
                    kind: "claude".to_string(),
                    path: None,
                    cwd: Some(path.to_string()),
                    args: None,
                    label: Some("New Claude session".to_string()),
                },
            ]),
            _ => None,
        };

        out.push(ProjectInfo {
            id: p.id,
            name: p.name,
            path: p.path,
            ide: p.ide,
            language: p.language,
            type_: p.type_,
            status: p.status,
            last_active: p.last_active,
            tags: p.tags,
            items: synthesised_items,
        });
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
            // We don't require the path to exist at validation time — the
            // user may be authoring an entry before the binary is installed
            // (e.g. on a fresh Windows box). At launch time the missing-
            // path error surfaces naturally.
        }
        "claude" | "codex" => {
            let cwd = item
                .cwd
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("{} item missing cwd", item.kind))?;
            if cwd.starts_with(r"\\") || cwd.starts_with("//") {
                return Err("UNC paths are not allowed".into());
            }
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
pub fn add_launcher_item_inner(p: AddLauncherItemPayload) -> Result<UpdateProjectResult, String> {
    if p.project_id.trim().is_empty() {
        return Err("project_id is empty".to_string());
    }
    validate_launcher_item(&p.item)?;
    let (registry, mut root) = load_registry_mut()?;
    {
        let entry = find_entry_mut(&mut root, &p.project_id)?;
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
                },
                LauncherItem {
                    kind: "claude".to_string(),
                    path: None,
                    cwd: Some(path.to_string()),
                    args: None,
                    label: Some("New Claude session".to_string()),
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
        match dispatch_item(&app, item).await {
            Ok(_) => launched += 1,
            Err(e) => {
                eprintln!("[projects] launch_all_items[{}] {}: {}", project_id, i, e);
            }
        }
    }
    Ok(launched)
}

/// Per-kind dispatch. Pulled out so launch_item / launch_all share one
/// implementation and we only have one place to update when a new kind
/// joins the family.
async fn dispatch_item(app: &tauri::AppHandle, item: &LauncherItem) -> Result<(), String> {
    validate_launcher_item(item)?;
    match item.kind.as_str() {
        "exe" => {
            let path = item.path.as_deref().unwrap_or("").trim();
            let exe_path = std::path::Path::new(path);
            if !exe_path.is_file() {
                return Err(format!("exe not found: {}", path));
            }
            // We hand the args[] as a Vec<String> to PowerShell's Start-Process
            // via -ArgumentList; that side wraps each argument in single
            // quotes, so embedded spaces/quotes survive. The alternative —
            // CreateProcess directly with std::process::Command — works too
            // but loses Start-Process's ShellExecute semantics (handy for .lnk).
            let args = item.args.clone().unwrap_or_default();
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
        "claude" | "codex" => {
            let cwd = item.cwd.clone();
            let kind = item.kind.clone();
            crate::sessions::spawn_session_inner(app, kind, None, cwd, None)
                .await
                .map(|_| ())
        }
        other => Err(format!("unknown launcher kind '{}'", other)),
    }
}
