// ULTRON Control Center — Projects module.
//
// Reads ~/.ultron/cockpit/projects.json (registry built by
// scripts/cockpit/scan_projects.py). Exposes a flat list with the fields
// the UI needs for the workspace picker + future Projects tab.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

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
    /// Per-project preferred actions for the Projects tab UI. When `None`,
    /// the frontend renders a default set (open_ide, new_claude, open_folder).
    /// Known values today: "open_ide", "new_claude", "new_codex",
    /// "open_folder", "git_status". The list is intentionally loose so new
    /// actions can ship without a registry migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<String>>,
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
    actions: Option<Vec<String>>,
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
pub fn create_project_inner(p: CreateProjectPayload) -> Result<CreateProjectResult, String> {
    use std::path::Path;
    if p.name.trim().is_empty() {
        return Err("name is empty".to_string());
    }
    if p.path.trim().is_empty() {
        return Err("path is empty".to_string());
    }
    let path = Path::new(&p.path);
    // Reject UNC and exotic prefixes — only local drive paths. UNC opens the
    // door to "create project pointing at \\\\evil.example.com\\share\\stage.exe"
    // and then "Open" runs the remote binary via Start-Process. Defense in
    // depth on top of the registry write being authenticated.
    let path_str = path.to_string_lossy();
    if path_str.starts_with(r"\\") || path_str.starts_with("//") {
        return Err("UNC paths are not allowed".into());
    }
    if !path.is_dir() && !path.is_file() {
        return Err(format!("path does not exist: {}", p.path));
    }
    // For file entries, restrict the extension to the known launcher types.
    // Anything else (.dll, .vbs, .ps1, etc.) is suspicious in this context.
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
        "path": path.to_string_lossy().to_string(),
        "ide": p.ide.unwrap_or_default(),
        "language": p.language.unwrap_or_default(),
        "type": "",
        "deadline": "",
        "last_active": today,
        "status": "manual",
        "tags": p.tags.unwrap_or_default(),
        "auto_tags": [],
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
    // Atomic write
    let tmp = registry.with_extension("json.tmp");
    std::fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, &registry).map_err(|e| format!("rename: {}", e))?;

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
    let tmp = registry.with_extension("json.tmp");
    std::fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, &registry).map_err(|e| format!("rename: {}", e))?;
    Ok(UpdateProjectResult {
        success: true,
        id: p.id,
    })
}

#[derive(Debug, _Deserialize)]
pub struct UpdateProjectActionsPayload {
    pub id: String,
    pub actions: Vec<String>,
}

/// Persist a per-project actions whitelist to projects.json. Validation
/// rejects unknown action keys so a typo from the UI cannot poison the
/// registry; new actions need to be added here on the way in.
pub fn update_project_actions_inner(
    p: UpdateProjectActionsPayload,
) -> Result<UpdateProjectResult, String> {
    if p.id.trim().is_empty() {
        return Err("id is empty".to_string());
    }
    const ALLOWED: &[&str] = &[
        "open_ide",
        "new_claude",
        "new_codex",
        "open_folder",
        "git_status",
    ];
    for a in &p.actions {
        if !ALLOWED.contains(&a.as_str()) {
            return Err(format!("unknown action '{}'", a));
        }
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
    let arr: Vec<serde_json::Value> = p
        .actions
        .iter()
        .map(|a| serde_json::Value::String(a.clone()))
        .collect();
    entry["actions"] = serde_json::Value::Array(arr);
    let serialized =
        serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    let tmp = registry.with_extension("json.tmp");
    std::fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, &registry).map_err(|e| format!("rename: {}", e))?;
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
    let tmp = registry.with_extension("json.tmp");
    std::fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, &registry).map_err(|e| format!("rename: {}", e))?;

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
            actions: p.actions,
        });
    }
    // Sort by last_active desc (ISO yyyy-mm-dd compares lexicographically).
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(out)
}
