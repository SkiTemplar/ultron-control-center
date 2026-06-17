// projects/read_ops.rs — Read-only operations: list projects, load items.

use std::fs;

use super::normalise::{normalise_ide, normalise_provider, normalise_shell};
use super::registry::registry_path;
use super::types::{LauncherItem, ProjectInfo, ProjectsRoot};

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

        let default_provider = Some(normalise_provider(p.default_provider.as_deref()));
        let ide = normalise_ide(p.ide.as_deref());
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
    // if the registry doesn't already cover it.
    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy().to_string();
        let already_present = out.iter().any(|p| {
            matches!(p.path.as_deref(), Some(p)
                if p.trim_end_matches('\\').trim_end_matches('/') ==
                   home_str.trim_end_matches('\\').trim_end_matches('/'))
        });
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

/// Read the live items[] for a project, applying the same backwards-compat
/// synthesis as `list_projects_inner` so launch_item works on legacy entries.
pub(crate) fn load_items_for(project_id: &str) -> Result<Vec<LauncherItem>, String> {
    let registry = registry_path().ok_or_else(|| "no HOME".to_string())?;
    let raw =
        std::fs::read_to_string(&registry).map_err(|e| format!("read projects.json: {}", e))?;
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
