// hooks_admin/io.rs — Settings I/O: read, flatten, mutate, discover plugin hooks.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use super::types::Hook;
use crate::settings;

pub(crate) fn settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/settings.json"))
}

/// Stable ID — same (event, matcher, command) always hashes to the same
/// string regardless of array index. We include the command verbatim so a
/// rename of the underlying script invalidates the ID (intentional: that
/// "is" a new hook from a user's perspective).
pub(crate) fn compute_id(event: &str, matcher: Option<&str>, command: &str) -> String {
    let mut hasher = DefaultHasher::new();
    event.hash(&mut hasher);
    matcher.unwrap_or("").hash(&mut hasher);
    command.hash(&mut hasher);
    let h = hasher.finish();
    // 12 hex chars is plenty for the few dozen hooks a user will have.
    format!("hk_{:012x}", h & 0x0000_FFFF_FFFF_FFFF)
}

pub(crate) fn read_settings_value() -> Result<serde_json::Value, String> {
    let path = settings_path().ok_or_else(|| "no HOME".to_string())?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read settings.json: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse settings.json: {}", e))
}

/// Extract a Vec of Hook records from a settings.json `Value`. Tolerant
/// of missing keys — returns an empty Vec if there is no "hooks" key.
pub(crate) fn flatten_hooks(root: &serde_json::Value) -> Vec<Hook> {
    let mut out: Vec<Hook> = Vec::new();
    let Some(hooks_obj) = root.get("hooks").and_then(|v| v.as_object()) else {
        return out;
    };
    for (event_name, groups) in hooks_obj.iter() {
        let Some(arr) = groups.as_array() else {
            continue;
        };
        for group in arr.iter() {
            let Some(group_obj) = group.as_object() else {
                continue;
            };
            let matcher = group_obj
                .get("matcher")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let group_description = group_obj
                .get("description")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string());
            let Some(inner_arr) = group_obj.get("hooks").and_then(|v| v.as_array()) else {
                continue;
            };
            for entry in inner_arr.iter() {
                let Some(entry_obj) = entry.as_object() else {
                    continue;
                };
                let type_str = entry_obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let enabled = match type_str {
                    "command" => true,
                    "disabled-command" => false,
                    _ => continue,
                };
                let Some(command) = entry_obj.get("command").and_then(|v| v.as_str()) else {
                    continue;
                };
                let mut extra_obj = serde_json::Map::new();
                for (k, v) in entry_obj.iter() {
                    if k != "type" && k != "command" {
                        extra_obj.insert(k.clone(), v.clone());
                    }
                }
                let id = compute_id(event_name, matcher.as_deref(), command);
                out.push(Hook {
                    id,
                    event: event_name.clone(),
                    matcher: matcher.clone(),
                    command: command.to_string(),
                    enabled,
                    source: "user".to_string(),
                    description: group_description.clone(),
                    extra: serde_json::Value::Object(extra_obj),
                });
            }
        }
    }
    out
}

/// Walk `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/hooks/hooks.json`
/// and flatten each one into Hook records tagged with `source = "plugin:<mkt>/<plugin>"`.
/// Read-only and tolerant — a malformed plugin hooks.json is silently
/// skipped so it never breaks the whole listing.
pub(crate) fn discover_plugin_hooks() -> Vec<Hook> {
    let mut out: Vec<Hook> = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let cache_root = home.join(".claude").join("plugins").join("cache");
    if !cache_root.exists() {
        return out;
    }
    let Ok(marketplaces) = fs::read_dir(&cache_root) else {
        return out;
    };
    for mkt in marketplaces.flatten() {
        let mkt_path = mkt.path();
        if !mkt_path.is_dir() {
            continue;
        }
        let mkt_name = mkt.file_name().to_string_lossy().to_string();
        let Ok(plugins) = fs::read_dir(&mkt_path) else {
            continue;
        };
        for plugin in plugins.flatten() {
            let plugin_path = plugin.path();
            if !plugin_path.is_dir() {
                continue;
            }
            let plugin_name = plugin.file_name().to_string_lossy().to_string();
            let Ok(versions) = fs::read_dir(&plugin_path) else {
                continue;
            };
            for version in versions.flatten() {
                let version_path = version.path();
                if !version_path.is_dir() {
                    continue;
                }
                let hooks_file = version_path.join("hooks").join("hooks.json");
                if !hooks_file.exists() {
                    continue;
                }
                let Ok(raw) = fs::read_to_string(&hooks_file) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
                    continue;
                };
                let wrapped = if value.get("hooks").is_some() {
                    value
                } else {
                    serde_json::json!({ "hooks": value })
                };
                let source = format!("plugin:{}/{}", mkt_name, plugin_name);
                for mut hook in flatten_hooks(&wrapped) {
                    hook.source = source.clone();
                    out.push(hook);
                }
            }
        }
    }
    out
}

/// Mutation core: read settings, mutate the "hooks" object via `f`, save.
pub(crate) fn mutate_hooks<F>(f: F) -> Result<(serde_json::Value, Option<String>), String>
where
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<serde_json::Value, String>,
{
    let snapshot = settings::settings_read_inner().or_else(|_| {
        Ok::<_, String>(settings::SettingsSnapshot {
            path: settings_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            content: serde_json::json!({}),
            modified: None,
            size_bytes: 0,
            backup_dir: String::new(),
            recent_backups: Vec::new(),
        })
    })?;

    let mut content = snapshot.content;
    if !content.is_object() {
        content = serde_json::json!({});
    }
    let root = content
        .as_object_mut()
        .ok_or_else(|| "settings.json root is not an object".to_string())?;

    let entry = root
        .entry("hooks".to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let hooks_obj = entry
        .as_object_mut()
        .ok_or_else(|| "settings.json 'hooks' is not an object".to_string())?;

    let payload = f(hooks_obj)?;

    let save = settings::settings_save_inner(settings::SettingsSavePayload { content })?;
    Ok((payload, save.backup_path))
}

/// Locate and mutate a single entry in-place inside the nested hooks
/// structure. The callback receives the entry's JSON object so it can
/// replace fields. Returns the rebuilt `Hook` view on success.
pub(crate) fn mutate_entry_by_id<F>(
    hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
    target_id: &str,
    apply: F,
) -> Result<Hook, String>
where
    F: FnOnce(
        &mut serde_json::Map<String, serde_json::Value>,
        &mut Option<String>,
    ) -> Result<(), String>,
{
    for (event_name, groups) in hooks_obj.iter_mut() {
        let Some(arr) = groups.as_array_mut() else {
            continue;
        };
        for group in arr.iter_mut() {
            let Some(group_obj) = group.as_object_mut() else {
                continue;
            };
            let mut matcher: Option<String> = group_obj
                .get("matcher")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let target_idx: Option<usize> = match group_obj.get("hooks").and_then(|v| v.as_array())
            {
                Some(inner_arr) => {
                    let mut found: Option<usize> = None;
                    for (i, entry) in inner_arr.iter().enumerate() {
                        let Some(entry_obj) = entry.as_object() else {
                            continue;
                        };
                        let type_str = entry_obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if type_str != "command" && type_str != "disabled-command" {
                            continue;
                        }
                        let command = entry_obj
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let id = compute_id(event_name, matcher.as_deref(), command);
                        if id == target_id {
                            found = Some(i);
                            break;
                        }
                    }
                    found
                }
                None => None,
            };
            let Some(idx) = target_idx else { continue };

            let (new_command, new_type_str, extra_obj) = {
                let inner_arr = group_obj
                    .get_mut("hooks")
                    .and_then(|v| v.as_array_mut())
                    .ok_or_else(|| "group 'hooks' is not an array".to_string())?;
                let entry = inner_arr
                    .get_mut(idx)
                    .ok_or_else(|| "entry index out of range".to_string())?;
                let entry_obj = entry
                    .as_object_mut()
                    .ok_or_else(|| "entry is not an object".to_string())?;

                apply(entry_obj, &mut matcher)?;

                let new_command = entry_obj
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let new_type_str = entry_obj
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("command")
                    .to_string();
                let mut extra_obj = serde_json::Map::new();
                for (k, v) in entry_obj.iter() {
                    if k != "type" && k != "command" {
                        extra_obj.insert(k.clone(), v.clone());
                    }
                }
                (new_command, new_type_str, extra_obj)
            };

            match &matcher {
                Some(m) if !m.is_empty() => {
                    group_obj.insert("matcher".to_string(), serde_json::Value::String(m.clone()));
                }
                _ => {
                    group_obj.remove("matcher");
                }
            }

            let enabled = new_type_str == "command";
            let new_id = compute_id(event_name, matcher.as_deref(), &new_command);
            return Ok(Hook {
                id: new_id,
                event: event_name.clone(),
                matcher: matcher.clone(),
                command: new_command,
                enabled,
                source: "user".to_string(),
                description: None,
                extra: serde_json::Value::Object(extra_obj),
            });
        }
    }
    Err(format!("hook id '{}' not found", target_id))
}

/// Same as `mutate_entry_by_id` but removes the entry (and prunes empty
/// groups / empty event arrays so we don't leave dangling shells in
/// settings.json).
pub(crate) fn delete_entry_by_id(
    hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
    target_id: &str,
) -> Result<(), String> {
    let mut events_to_prune: Vec<String> = Vec::new();
    let mut deleted = false;

    for (event_name, groups) in hooks_obj.iter_mut() {
        let Some(arr) = groups.as_array_mut() else {
            continue;
        };
        let mut groups_to_remove: Vec<usize> = Vec::new();
        for (group_idx, group) in arr.iter_mut().enumerate() {
            let Some(group_obj) = group.as_object_mut() else {
                continue;
            };
            let matcher: Option<String> = group_obj
                .get("matcher")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let Some(inner_arr) = group_obj.get_mut("hooks").and_then(|v| v.as_array_mut()) else {
                continue;
            };
            let mut entry_idx_to_remove: Option<usize> = None;
            for (i, entry) in inner_arr.iter().enumerate() {
                let Some(entry_obj) = entry.as_object() else {
                    continue;
                };
                let type_str = entry_obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if type_str != "command" && type_str != "disabled-command" {
                    continue;
                }
                let command = entry_obj
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let id = compute_id(event_name, matcher.as_deref(), command);
                if id == target_id {
                    entry_idx_to_remove = Some(i);
                    break;
                }
            }
            if let Some(i) = entry_idx_to_remove {
                inner_arr.remove(i);
                deleted = true;
                if inner_arr.is_empty() {
                    groups_to_remove.push(group_idx);
                }
                break;
            }
        }
        // Remove emptied groups in reverse order so indexes stay valid.
        for &idx in groups_to_remove.iter().rev() {
            arr.remove(idx);
        }
        if arr.is_empty() {
            events_to_prune.push(event_name.clone());
        }
        if deleted {
            break;
        }
    }
    for k in events_to_prune {
        hooks_obj.remove(&k);
    }
    if !deleted {
        return Err(format!("hook id '{}' not found", target_id));
    }
    Ok(())
}
