// mcps/discovery.rs — MCP source discovery and list aggregation.

use std::fs;

use super::types_io::{
    build_mcp_info, normalize_mcp_name, parse_fallbacks, parse_mcp_file, parse_settings,
    read_health, McpInfo, McpServerCfg,
};

/// Read `~/.claude.json` and extract every MCP server declared there:
///   - top-level `mcpServers`            -> origin "user-claudejson"
///   - `projects.<path>.mcpServers`      -> origin "project:<basename(path)>"
pub(super) fn collect_claude_json_mcps() -> Vec<(String, String, McpServerCfg)> {
    let mut out: Vec<(String, String, McpServerCfg)> = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let path = home.join(".claude.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return out;
    };
    let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
        return out;
    };

    if let Some(obj) = value.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, cfg_val) in obj.iter() {
            if let Ok(cfg) = serde_json::from_value::<McpServerCfg>(cfg_val.clone()) {
                out.push(("user-claudejson".to_string(), name.clone(), cfg));
            }
        }
    }

    if let Some(projects) = value.get("projects").and_then(|v| v.as_object()) {
        for (proj_path, proj_val) in projects.iter() {
            let Some(servers) = proj_val.get("mcpServers").and_then(|v| v.as_object()) else {
                continue;
            };
            let basename = std::path::Path::new(proj_path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(proj_path.as_str());
            let origin = format!("project:{}", basename);
            for (name, cfg_val) in servers.iter() {
                if let Ok(cfg) = serde_json::from_value::<McpServerCfg>(cfg_val.clone()) {
                    out.push((origin.clone(), name.clone(), cfg));
                }
            }
        }
    }

    out
}

/// Discover MCP servers contributed by installed plugins.
pub(super) fn collect_plugin_mcps() -> Vec<(String, String, McpServerCfg)> {
    let mut out: Vec<(String, String, McpServerCfg)> = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let plugins_root = home.join(".claude").join("plugins");
    if !plugins_root.exists() {
        return out;
    }
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(plugins_root, 0)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 6 {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if name == "node_modules" || name.starts_with('.') {
                    continue;
                }
                stack.push((path, depth + 1));
            } else if path.file_name().and_then(|s| s.to_str()) == Some(".mcp.json") {
                let slug =
                    derive_plugin_slug(&path).unwrap_or_else(|| "unknown-plugin".to_string());
                for (name, cfg) in parse_mcp_file(&path).into_iter() {
                    out.push((slug.clone(), name, cfg));
                }
            }
        }
    }
    out
}

pub(super) fn derive_plugin_slug(mcp_path: &std::path::Path) -> Option<String> {
    let parts: Vec<&std::ffi::OsStr> = mcp_path.iter().collect::<Vec<_>>();
    let mut idx_plugins: Option<usize> = None;
    for (i, p) in parts.iter().enumerate() {
        if p.to_string_lossy() == "plugins" {
            idx_plugins = Some(i);
            break;
        }
    }
    let i = idx_plugins?;
    let after: Vec<String> = parts[i + 1..]
        .iter()
        .map(|s| s.to_string_lossy().to_string())
        .collect();
    match after.as_slice() {
        [first, _market, plugin, _ver, _file, ..] if first == "cache" => Some(plugin.clone()),
        [first, _market, plugin, _file, ..] if first == "marketplaces" => Some(plugin.clone()),
        [first, plugin, _file, ..] if first == "marketplaces" => Some(plugin.clone()),
        _ => after.first().cloned(),
    }
}

/// Discover MCP servers declared in project-level `.mcp.json` files.
pub(super) fn collect_project_mcps() -> Vec<(String, String, McpServerCfg)> {
    let mut out: Vec<(String, String, McpServerCfg)> = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let registry = home.join(".ultron").join("cockpit").join("projects.json");
    let Ok(raw) = fs::read_to_string(&registry) else {
        return out;
    };
    let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
        return out;
    };
    let projects = value
        .get("projects")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for proj in projects.iter() {
        let path_str = proj.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path_str.is_empty() {
            continue;
        }
        let candidate = std::path::Path::new(path_str).join(".mcp.json");
        if !candidate.exists() {
            continue;
        }
        let proj_label = proj
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                std::path::Path::new(path_str)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("project")
                    .to_string()
            });
        for (name, cfg) in parse_mcp_file(&candidate).into_iter() {
            out.push((proj_label.clone(), name, cfg));
        }
    }
    out
}

pub fn list_mcps_inner() -> Result<Vec<McpInfo>, String> {
    let settings = parse_settings()?;
    let health = read_health();
    let fallbacks = parse_fallbacks();

    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let mut out: Vec<McpInfo> = Vec::new();

    // Source 1: user settings.json
    for (name, cfg) in settings.mcp_servers.iter() {
        let key = (name.clone(), "user".to_string());
        if seen.insert(key) {
            out.push(build_mcp_info(
                name,
                cfg,
                "user".to_string(),
                None,
                &health,
                &fallbacks,
            ));
        }
    }

    // Source 2: plugin .mcp.json files
    for (plugin, name, cfg) in collect_plugin_mcps().into_iter() {
        let origin = format!("plugin:{}", plugin);
        let key = (name.clone(), origin.clone());
        if seen.insert(key) {
            out.push(build_mcp_info(
                &name,
                &cfg,
                origin,
                Some(plugin),
                &health,
                &fallbacks,
            ));
        }
    }

    // Source 3: project-level .mcp.json files
    for (project, name, cfg) in collect_project_mcps().into_iter() {
        let origin = format!("project:{}", project);
        let key = (name.clone(), origin.clone());
        if seen.insert(key) {
            out.push(build_mcp_info(
                &name,
                &cfg,
                origin,
                Some(project),
                &health,
                &fallbacks,
            ));
        }
    }

    // Source 4: ~/.claude.json
    for (origin, name, cfg) in collect_claude_json_mcps().into_iter() {
        let plugin = origin.strip_prefix("project:").map(|p| p.to_string());
        let key = (name.clone(), origin.clone());
        if seen.insert(key) {
            out.push(build_mcp_info(
                &name, &cfg, origin, plugin, &health, &fallbacks,
            ));
        }
    }

    // Reflect Claude Code's own disable list.
    if !settings.disabled_mcpjson_servers.is_empty() {
        let disabled_set: std::collections::HashSet<&str> = settings
            .disabled_mcpjson_servers
            .iter()
            .map(|s| s.as_str())
            .collect();
        for info in out.iter_mut() {
            if disabled_set.contains(info.name.as_str()) {
                info.disabled = true;
            }
        }
    }

    fn editability_rank(origin: &str) -> u8 {
        if origin == "user" || origin == "user-claudejson" {
            0
        } else if origin.starts_with("project:") {
            1
        } else if origin.starts_with("plugin:") {
            2
        } else {
            3
        }
    }
    let mut deduped: Vec<McpInfo> = Vec::with_capacity(out.len());
    let mut idx_by_norm: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for info in out.into_iter() {
        let norm = normalize_mcp_name(&info.name);
        if let Some(&i) = idx_by_norm.get(&norm) {
            if editability_rank(&info.origin) < editability_rank(&deduped[i].origin) {
                let prev_count = deduped[i].duplicate_count;
                let prev_origins = std::mem::take(&mut deduped[i].duplicate_origins);
                let mut promoted = info;
                promoted.duplicate_count = prev_count + 1;
                for o in prev_origins {
                    if !promoted.duplicate_origins.contains(&o) {
                        promoted.duplicate_origins.push(o);
                    }
                }
                deduped[i] = promoted;
            } else {
                let canonical = &mut deduped[i];
                canonical.duplicate_count += 1;
                if !canonical.duplicate_origins.contains(&info.origin) {
                    canonical.duplicate_origins.push(info.origin.clone());
                }
            }
        } else {
            idx_by_norm.insert(norm, deduped.len());
            deduped.push(info);
        }
    }
    let mut out = deduped;

    out.sort_by(|a, b| {
        let bucket = |o: &str| -> u8 {
            if o == "user" || o == "user-claudejson" {
                0
            } else if o.starts_with("project:") {
                1
            } else if o.starts_with("plugin:") {
                2
            } else {
                3
            }
        };
        bucket(&a.origin)
            .cmp(&bucket(&b.origin))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}
