// mcps/discovery.rs — MCP source discovery and list aggregation.

use std::fs;
use std::path::PathBuf;

use super::types_io::{
    build_mcp_info, normalize_mcp_name, parse_fallbacks, parse_inline_plugin_manifest_mcp,
    parse_mcp_file, parse_plugin_mcp_file, parse_settings, read_enabled_plugins, read_health,
    read_installed_plugins, select_enabled_plugin_paths, McpInfo, McpServerCfg, SettingsRoot,
};

/// Una entrada de servidor MCP con su procedencia. La comparten el listado
/// de la pestaña, el botón «Test» y el chequeo de salud, para que los tres
/// vean exactamente los mismos servidores (H15).
#[derive(Debug, Clone)]
pub(super) struct McpSource {
    pub(super) origin: String,
    /// Etiqueta del proyecto o slug del plugin (`McpInfo.plugin`).
    pub(super) plugin: Option<String>,
    pub(super) name: String,
    pub(super) cfg: McpServerCfg,
    /// Carpeta del proyecto en los de ámbito proyecto: Claude Code los
    /// arranca con ese directorio de trabajo.
    pub(super) cwd: Option<PathBuf>,
    /// Viene de un `.mcp.json` de proyecto (lo controla el repositorio, no el
    /// usuario): no se lanza sin aprobación (`mcps::confianza`).
    pub(super) requiere_aprobacion: bool,
}

/// Origen del `mcpServers` legado de `~/.claude/settings.json`, que Claude
/// Code no lee para MCP (H14).
pub(super) const ORIGIN_SETTINGS: &str = "settings";

/// Prioridad al colapsar duplicados y al resolver un nombre: el ámbito de
/// usuario real primero y el legado de settings.json el último.
pub(super) fn editability_rank(origin: &str) -> u8 {
    if origin == "user" {
        0
    } else if origin.starts_with("project:") {
        1
    } else if origin.starts_with("plugin:") {
        2
    } else if origin == ORIGIN_SETTINGS {
        3
    } else {
        4
    }
}

/// Servidores de un `~/.claude.json` ya parseado:
///   - `mcpServers` de primer nivel  -> origin "user" (ámbito de usuario)
///   - `projects.<path>.mcpServers` -> origin "project:<basename(path)>"
pub(super) fn claude_json_sources_from_value(value: &serde_json::Value) -> Vec<McpSource> {
    let mut out: Vec<McpSource> = Vec::new();
    if let Some(obj) = value.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, cfg_val) in obj.iter() {
            if let Ok(cfg) = serde_json::from_value::<McpServerCfg>(cfg_val.clone()) {
                out.push(McpSource {
                    origin: "user".to_string(),
                    plugin: None,
                    name: name.clone(),
                    cfg,
                    cwd: None,
                    requiere_aprobacion: false,
                });
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
                .unwrap_or(proj_path.as_str())
                .to_string();
            for (name, cfg_val) in servers.iter() {
                if let Ok(cfg) = serde_json::from_value::<McpServerCfg>(cfg_val.clone()) {
                    out.push(McpSource {
                        origin: format!("project:{}", basename),
                        plugin: Some(basename.clone()),
                        name: name.clone(),
                        cfg,
                        cwd: Some(PathBuf::from(proj_path)),
                        requiere_aprobacion: false,
                    });
                }
            }
        }
    }
    out
}

/// Read `~/.claude.json` and extract every MCP server declared there (see
/// [`claude_json_sources_from_value`]). Missing or malformed file -> empty.
pub(super) fn collect_claude_json_mcps() -> Vec<McpSource> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(home.join(".claude.json")) else {
        return Vec::new();
    };
    let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
        return Vec::new();
    };
    claude_json_sources_from_value(&value)
}

/// Discover MCP servers contributed by installed, **enabled** plugins.
///
/// Source of truth: `~/.claude/plugins/installed_plugins.json` (what the
/// user actually installed) filtered by `~/.claude/settings.json` ->
/// `enabledPlugins`. This deliberately does NOT walk
/// `~/.claude/plugins/marketplaces/`: that tree is the catalogue of every
/// plugin a marketplace *offers* (`external_plugins/discord`,
/// `external_plugins/telegram`, ...), not what's installed — treating it as
/// a source was the bug (uninstalled marketplace plugins showing as MCPs).
pub(super) fn collect_plugin_mcps() -> Vec<(String, String, McpServerCfg)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    collect_plugin_mcps_from(&home)
}

/// FS-parameterised core of [`collect_plugin_mcps`] — takes `home` as an
/// argument so tests can point it at a `tempfile::TempDir` instead of the
/// real `~` (hermetic, no dependency on this machine's actual plugins).
pub(super) fn collect_plugin_mcps_from(
    home: &std::path::Path,
) -> Vec<(String, String, McpServerCfg)> {
    let mut out: Vec<(String, String, McpServerCfg)> = Vec::new();
    let installed = read_installed_plugins(home);
    let enabled_plugins = read_enabled_plugins(home);

    for (slug, install_path) in select_enabled_plugin_paths(&installed, &enabled_plugins) {
        let mcp_path = install_path.join(".mcp.json");
        for (name, cfg) in parse_plugin_mcp_file(&mcp_path).into_iter() {
            out.push((slug.clone(), name, cfg));
        }

        let manifest_path = install_path.join(".claude-plugin").join("plugin.json");
        for (name, cfg) in parse_inline_plugin_manifest_mcp(&manifest_path).into_iter() {
            out.push((slug.clone(), name, cfg));
        }
    }
    out
}

/// Discover MCP servers declared in project-level `.mcp.json` files.
pub(super) fn collect_project_mcps() -> Vec<McpSource> {
    let mut out: Vec<McpSource> = Vec::new();
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
            out.push(McpSource {
                origin: format!("project:{}", proj_label),
                plugin: Some(proj_label.clone()),
                name,
                cfg,
                cwd: Some(PathBuf::from(path_str)),
                requiere_aprobacion: true,
            });
        }
    }
    out
}

/// Todas las fuentes de MCP, en orden de prioridad: `~/.claude.json`
/// (usuario y proyectos), plugins, `.mcp.json` de proyectos y, al final, el
/// `mcpServers` legado de settings.json.
pub(super) fn collect_all_sources(settings: &SettingsRoot) -> Vec<McpSource> {
    let mut out: Vec<McpSource> = collect_claude_json_mcps();
    for (plugin, name, cfg) in collect_plugin_mcps().into_iter() {
        out.push(McpSource {
            origin: format!("plugin:{}", plugin),
            plugin: Some(plugin),
            name,
            cfg,
            cwd: None,
            requiere_aprobacion: false,
        });
    }
    out.extend(collect_project_mcps());
    for (name, cfg) in settings.mcp_servers.iter() {
        out.push(McpSource {
            origin: ORIGIN_SETTINGS.to_string(),
            plugin: None,
            name: name.clone(),
            cfg: cfg.clone(),
            cwd: None,
            requiere_aprobacion: false,
        });
    }
    out
}

/// La entrada que representa a `name`: coincidencia exacta de nombre y, si
/// hay varias, la de mayor prioridad (la misma que la pestaña muestra al
/// colapsar duplicados). `disabledMcpjsonServers` cuenta como deshabilitado,
/// igual que en el listado.
pub(super) fn resolve_server(
    sources: &[McpSource],
    disabled_list: &[String],
    name: &str,
) -> Option<McpSource> {
    let mut found = sources
        .iter()
        .filter(|s| s.name == name)
        .min_by_key(|s| editability_rank(&s.origin))
        .cloned()?;
    if disabled_list.iter().any(|d| d == name) {
        found.cfg.disabled = true;
    }
    Some(found)
}

pub fn list_mcps_inner() -> Result<Vec<McpInfo>, String> {
    let settings = parse_settings()?;
    let health = read_health();
    let fallbacks = parse_fallbacks();

    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let mut out: Vec<McpInfo> = Vec::new();

    for src in collect_all_sources(&settings).into_iter() {
        let key = (src.name.clone(), src.origin.clone());
        if seen.insert(key) {
            out.push(build_mcp_info(
                &src.name, &src.cfg, src.origin, src.plugin, &health, &fallbacks,
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
        editability_rank(&a.origin)
            .cmp(&editability_rank(&b.origin))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}
