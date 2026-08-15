// projects/write_ops.rs — Create, update, delete, touch operations on projects.json.

use super::normalise::{normalise_color, normalise_ide, normalise_provider, normalise_shell};
use super::registry::{atomic_write, find_entry_mut, load_registry_mut, projects_lock, slugify};
use super::types::{
    AddLauncherItemPayload, CreateProjectPayload, CreateProjectResult, DeleteProjectResult,
    ExecutableEntry, LauncherItem, UpdateProjectPayload, UpdateProjectResult,
};

/// Append a new project to ~/.ultron/cockpit/projects.json directly. Avoids
/// invoking project_editor.py (which routes through an LLM for description
/// generation we don't need here). Idempotency: if the id collides, we
/// suffix -2, -3, etc.
pub fn create_project_inner(p: CreateProjectPayload) -> Result<CreateProjectResult, String> {
    use std::path::Path;
    if p.name.trim().is_empty() {
        return Err("name is empty".to_string());
    }
    let raw_path = p.path.trim().to_string();
    let path_provided = !raw_path.is_empty();
    if path_provided {
        let path = Path::new(&raw_path);
        let path_str = path.to_string_lossy();
        if path_str.starts_with(r"\\") || path_str.starts_with("//") {
            return Err("UNC paths are not allowed".into());
        }
        if !path.is_dir() && !path.is_file() {
            return Err(format!("path does not exist: {}", raw_path));
        }
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
    let raw =
        std::fs::read_to_string(&registry).map_err(|e| format!("read projects.json: {}", e))?;
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

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

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
    if let Some(shell) = default_shell {
        new_entry["default_shell"] = serde_json::Value::String(shell);
    }
    if let Some(folder) = parent_folder_override {
        new_entry["parent_folder_override"] = serde_json::Value::String(folder);
    }
    if let Some(n) = notes {
        new_entry["notes"] = serde_json::Value::String(n);
    }
    if let Some(c) = normalise_color(p.color.as_deref()) {
        new_entry["color"] = serde_json::Value::String(c);
    }
    projects.push(new_entry);

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

/// Patch an existing entry in projects.json. Only fields explicitly provided
/// (Some) get touched; the rest are preserved. Atomic write through a temp
/// file so a crash mid-write doesn't corrupt the registry.
/// Id del proyecto sintético que `list_projects_inner` inventa para el home.
pub(crate) const HOME_ID: &str = "__home";

/// Añade la entrada real del home al registro. Se llama solo cuando el usuario
/// edita el proyecto sintético (ponerle color, notas, shell): hasta entonces no
/// existe en projects.json y el update moría con "project '__home' not found".
/// El loader deja de sintetizarlo en cuanto ve una entrada con ese path, así
/// que materializarlo no duplica la tarjeta.
pub(crate) fn materialise_home_entry(projects: &mut Vec<serde_json::Value>, home: &str) {
    projects.push(serde_json::json!({
        "id": HOME_ID,
        "name": "Home",
        "path": home,
        "ide": "",
        "language": "",
        "type": "home",
        "deadline": "",
        "last_active": chrono::Utc::now().format("%Y-%m-%d").to_string(),
        "status": "manual",
        "tags": ["home"],
        "auto_tags": [],
        "items": [],
        "default_provider": "claude",
    }));
}

pub fn update_project_inner(p: UpdateProjectPayload) -> Result<UpdateProjectResult, String> {
    use std::path::Path;
    if p.id.trim().is_empty() {
        return Err("id is empty".to_string());
    }
    let _guard = projects_lock()
        .lock()
        .map_err(|e| format!("projects write lock poisoned: {}", e))?;
    let (registry, mut root) = load_registry_mut()?;
    {
        let projects = root
            .get_mut("projects")
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| "projects.json has no projects[]".to_string())?;

        let target = projects
            .iter_mut()
            .find(|v| v.get("id").and_then(|x| x.as_str()).map(String::from) == Some(p.id.clone()));
        let entry = match target {
            Some(e) => e,
            // `__home` es un proyecto SINTÉTICO: `list_projects_inner` lo
            // inventa cuando el registro no cubre el home del usuario, así que
            // la UI lo muestra pero no existe nada que actualizar y editarlo
            // moría con "project '__home' not found" (reportado 2026-08-15 al
            // ponerle color). Al guardar se materializa como entrada real; el
            // loader detecta que ya está por path y deja de sintetizarlo, así
            // que no hay duplicado.
            None if p.id == HOME_ID => {
                let home = dirs::home_dir()
                    .ok_or_else(|| "no HOME".to_string())?
                    .to_string_lossy()
                    .to_string();
                materialise_home_entry(projects, &home);
                projects
                    .last_mut()
                    .ok_or_else(|| "no se pudo materializar __home".to_string())?
            }
            None => return Err(format!("project '{}' not found", p.id)),
        };

        if let Some(name) = p.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            entry["name"] = serde_json::Value::String(name.to_string());
        }
        if let Some(path) = p.path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let _ = Path::new(path);
            entry["path"] = serde_json::Value::String(path.to_string());
        }
        if let Some(ide) = p.ide.as_deref() {
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
            entry["default_provider"] = serde_json::Value::String(normalise_provider(Some(prov)));
        }
        if let Some(raw) = p.default_shell.as_deref() {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                entry["default_shell"] = serde_json::Value::Null;
            } else if let Some(canonical) = normalise_shell(Some(trimmed)) {
                entry["default_shell"] = serde_json::Value::String(canonical);
            } else {
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
        // Colour: empty string is an explicit "clear it"; a malformed hex is
        // ignored so a typo in the picker can't silently wipe a good value.
        if let Some(raw) = p.color.as_deref() {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                entry["color"] = serde_json::Value::Null;
            } else if let Some(hex) = normalise_color(Some(trimmed)) {
                entry["color"] = serde_json::Value::String(hex);
            }
        }
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
    }

    let serialized =
        serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
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
    let _guard = projects_lock()
        .lock()
        .map_err(|e| format!("projects write lock poisoned: {}", e))?;
    let registry = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/cockpit/projects.json");
    let raw =
        std::fs::read_to_string(&registry).map_err(|e| format!("read projects.json: {}", e))?;
    let mut root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    let projects = root
        .get_mut("projects")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "projects.json has no projects[]".to_string())?;
    let before = projects.len();
    projects.retain(|p| p.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
    let after = projects.len();

    let serialized =
        serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    atomic_write(&registry, &serialized)?;

    Ok(DeleteProjectResult {
        success: before != after,
        id,
    })
}

/// Single-field patch for `default_provider`. Used by the icon-only chip
/// inline radio in the Projects tab.
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

        if let Some(items) = entry.get_mut("items").and_then(|v| v.as_array_mut()) {
            let providers = ["claude", "codex", "gemini"];
            let already_has_target = items
                .iter()
                .any(|it| it.get("kind").and_then(|k| k.as_str()) == Some(normalised.as_str()));
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

/// Stamp a project's `last_active` to the current instant so the "Most recent"
/// ordering reflects real usage.
///
/// Forgiving by design: an empty id, a missing registry, or an unknown id are
/// all no-op successes — a stamp failure must never block the actual open/launch.
pub fn touch_project_inner(id: &str) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(());
    }
    let _guard = projects_lock()
        .lock()
        .map_err(|e| format!("projects write lock poisoned: {}", e))?;
    let registry = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/cockpit/projects.json");
    let raw = match std::fs::read_to_string(&registry) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    let mut root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse projects.json: {}", e))?;
    let projects = match root.get_mut("projects").and_then(|v| v.as_array_mut()) {
        Some(p) => p,
        None => return Ok(()),
    };
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut found = false;
    for entry in projects.iter_mut() {
        if entry.get("id").and_then(|x| x.as_str()) == Some(id) {
            entry["last_active"] = serde_json::Value::String(now.clone());
            found = true;
            break;
        }
    }
    if !found {
        return Ok(());
    }
    let serialized =
        serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    atomic_write(&registry, &serialized)
}

// ---------------------------------------------------------------------------
// Launcher item management
// ---------------------------------------------------------------------------

/// Validate a launcher item before persisting it. Centralised so add/edit
/// share the same security envelope.
pub(crate) fn validate_launcher_item(item: &LauncherItem) -> Result<(), String> {
    use super::registry::path_ps_safe;
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
            path_ps_safe(path)?;
        }
        "claude" | "codex" | "session" => {
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
            // No explicit path validation — the dispatch_item resolver pulls
            // it from the parent project entry. Nothing to validate here
            // beyond the kind itself.
        }
        other => return Err(format!("unknown launcher kind '{}'", other)),
    }
    Ok(())
}

/// Append a new launcher item to `project.items[]`. Creates the array if
/// it doesn't exist on disk yet (old-style entries).
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

/// Drop the launcher item at the given index. No-op if out of range.
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
