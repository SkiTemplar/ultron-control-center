// mcps/mutations_gen.rs — CRUD mutations.
//
// «Generate MCP from prompt» se retiró el 2026-10-17: el modal no tenía
// botón de entrada. El alta asistida va por el button prompt
// `mcps.add_with_ai`.
//
// H14 (2026-10-17): el alta, la edición y el borrado escriben en el
// `mcpServers` de primer nivel de `~/.claude.json` (ámbito de usuario que lee
// Claude Code), con copia de seguridad y escritura atómica
// (`claude_json::ClaudeJsonStore`). El `mcpServers` de settings.json, que
// Claude Code no lee, solo se puede borrar (limpieza del legado).

use super::claude_json::ClaudeJsonStore;
use super::types_io::McpMutationResult;
use crate::settings;

// ---------------------------------------------------------------------------
// CRUD mutations on ~/.claude.json mcpServers
// ---------------------------------------------------------------------------

/// Names that round-trip safely as JSON object keys and as mcp ids in
/// CLI commands. Lower-case kebab/underscore, starts with alnum, 2–61
/// chars total. Conservative on purpose — matches what Claude Code
/// itself uses for mcpServers entries.
fn validate_mcp_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 61 || name.len() < 2 {
        return Err("name must be 2-61 chars".to_string());
    }
    let bytes = name.as_bytes();
    let first = bytes[0];
    let first_ok = first.is_ascii_lowercase() || first.is_ascii_digit();
    if !first_ok {
        return Err("name must start with a lowercase letter or digit".to_string());
    }
    for &b in &bytes[1..] {
        let ok = b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-';
        if !ok {
            return Err("name may only contain lowercase letters, digits, '_' or '-'".to_string());
        }
    }
    Ok(())
}

/// Nombre de una entrada que YA existe (editar, borrar, leer): basta con que
/// sea una clave razonable. Claude Code admite mayúsculas (`claude mcp add
/// MiServidor`), así que la regla estricta de `validate_mcp_name` solo se
/// aplica a las altas.
pub(super) fn validate_existing_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.len() > 200 || name.chars().any(char::is_control) {
        return Err("invalid MCP name".to_string());
    }
    Ok(())
}

fn mutate_user_servers<F>(name: &str, f: F) -> Result<McpMutationResult, String>
where
    F: FnMut(&mut serde_json::Map<String, serde_json::Value>) -> Result<(), String>,
{
    let backup_path = ClaudeJsonStore::user()?.mutate(f)?;
    Ok(McpMutationResult {
        success: true,
        name: name.to_string(),
        backup_path,
    })
}

/// `true` si `name` está en el `mcpServers` legado de settings.json.
fn in_legacy_settings(name: &str) -> Result<bool, String> {
    let snapshot = settings::settings_read_inner()?;
    Ok(snapshot
        .content
        .get("mcpServers")
        .and_then(|v| v.get(name))
        .is_some())
}

/// Borra `name` del `mcpServers` legado de settings.json (backup + escritura
/// atómica de `settings_save_inner`).
fn delete_from_legacy_settings(name: &str) -> Result<McpMutationResult, String> {
    let snapshot = settings::settings_read_inner()?;
    let mut content = snapshot.content;
    let removed = content
        .get_mut("mcpServers")
        .and_then(|v| v.as_object_mut())
        .and_then(|servers| servers.remove(name))
        .is_some();
    if !removed {
        return Err(format!("mcpServers['{}'] does not exist", name));
    }
    let save = settings::settings_save_inner(settings::SettingsSavePayload { content })?;
    Ok(McpMutationResult {
        success: save.success,
        name: name.to_string(),
        backup_path: save.backup_path,
    })
}

/// Configuración en bruto de un servidor de ámbito de usuario (con `env`),
/// para rellenar el formulario de edición.
pub fn mcp_get_config_inner(name: String) -> Result<serde_json::Value, String> {
    validate_existing_name(&name)?;
    ClaudeJsonStore::user()?
        .server(&name)?
        .ok_or_else(|| format!("'{}' no está en el mcpServers de ~/.claude.json", name))
}

pub fn set_mcpjson_disabled_inner(
    name: String,
    disabled: bool,
) -> Result<McpMutationResult, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || name.len() > 200 || name.contains(['\n', '\r', '\0']) {
        return Err("invalid MCP name".to_string());
    }

    let snapshot = settings::settings_read_inner()?;
    let mut content = snapshot.content;
    let root = content
        .as_object_mut()
        .ok_or_else(|| "settings.json root is not an object".to_string())?;

    let mut list: Vec<String> = root
        .get("disabledMcpjsonServers")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let present = list.iter().any(|n| n == &name);
    if disabled && !present {
        list.push(name.clone());
    } else if !disabled && present {
        list.retain(|n| n != &name);
    }

    root.insert(
        "disabledMcpjsonServers".to_string(),
        serde_json::Value::Array(list.into_iter().map(serde_json::Value::String).collect()),
    );

    let save = settings::settings_save_inner(settings::SettingsSavePayload { content })?;
    Ok(McpMutationResult {
        success: save.success,
        name,
        backup_path: save.backup_path,
    })
}

// Hard allowlist of MCP launcher commands.
const MCP_COMMAND_ALLOWLIST: &[&str] = &[
    "npx",
    "npm",
    "node",
    "uvx",
    "uv",
    "python",
    "python.exe",
    "deno",
    "bun",
    "cargo",
    "go",
    "ruby",
    "java",
    "java.exe",
];

const MCP_FORBIDDEN_ARG_FRAGMENTS: &[&str] = &[
    "-EncodedCommand",
    "-encodedcommand",
    "-Command",
    "Invoke-Expression",
    "iex ",
    "DownloadString",
    "wget ",
    "curl -",
];

/// Nombre del lanzador sin `.exe`/`.cmd`, en minúsculas.
fn launcher_stem(cmd: &str) -> String {
    let lower = cmd.trim().to_ascii_lowercase();
    lower
        .strip_suffix(".exe")
        .or_else(|| lower.strip_suffix(".cmd"))
        .unwrap_or(&lower)
        .to_string()
}

/// Un lanzador permitido: nombre desnudo (sin ruta) y en la allowlist.
fn check_launcher(cmd: &str) -> Result<(), String> {
    let cmd_trimmed = cmd.trim();
    if cmd_trimmed.is_empty() {
        return Err("command is empty".into());
    }
    if cmd_trimmed.contains('\\') || cmd_trimmed.contains('/') {
        return Err(format!(
            "command must be a bare executable name, not a path: '{}'",
            cmd_trimmed
        ));
    }
    if !MCP_COMMAND_ALLOWLIST.contains(&launcher_stem(cmd_trimmed).as_str()) {
        return Err(format!(
            "command '{}' is not in the MCP allowlist (allowed: {}, or cmd /c <one of them>)",
            cmd_trimmed,
            MCP_COMMAND_ALLOWLIST.join(", ")
        ));
    }
    Ok(())
}

/// Valida `command` (+ `args` para la forma `cmd /c <lanzador>`, la que
/// Claude Code recomienda en Windows para `npx`). `trusted` es el comando
/// que ya tenía la entrada al editar: si no cambia, no se le exige la
/// allowlist (p. ej. `codegraph` o una ruta absoluta a `uvx.exe`), salvo
/// `cmd`, que siempre exige un lanzador permitido detrás.
fn check_command(
    cmd: &str,
    args: &[serde_json::Value],
    trusted: Option<&str>,
) -> Result<(), String> {
    let stem = launcher_stem(cmd);
    if stem == "cmd" {
        let first = args.first().and_then(|v| v.as_str()).unwrap_or("");
        if !first.eq_ignore_ascii_case("/c") {
            return Err("cmd only allowed as 'cmd /c <launcher> ...'".into());
        }
        // `cmd /c` vuelve a unir los argumentos en una línea de órdenes: un
        // `&`, `|` o redirección encadenaría otro programa fuera de la
        // allowlist.
        if let Some(bad) = args
            .iter()
            .filter_map(|v| v.as_str())
            .find(|a| a.contains(['&', '|', '<', '>', '^', '%']))
        {
            return Err(format!(
                "with cmd /c, args may not contain shell metacharacters (&|<>^%): '{}'",
                bad
            ));
        }
        let launcher = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
        return check_launcher(launcher);
    }
    if trusted.is_some_and(|t| t.trim() == cmd.trim()) {
        return Ok(());
    }
    check_launcher(cmd)
}

fn validate_mcp_config(config: &serde_json::Value) -> Result<(), String> {
    validate_mcp_config_with(config, None)
}

pub(super) fn validate_mcp_config_with(
    config: &serde_json::Value,
    trusted_command: Option<&str>,
) -> Result<(), String> {
    let obj = config
        .as_object()
        .ok_or_else(|| "config must be a JSON object".to_string())?;

    let has_command = obj.contains_key("command");
    let has_url = obj.contains_key("url");
    if !has_command && !has_url {
        return Err("config must have either 'command' or 'url'".into());
    }
    if has_command && has_url {
        return Err("config cannot have both 'command' and 'url'".into());
    }

    if let Some(cmd) = obj.get("command").and_then(|v| v.as_str()) {
        let args: &[serde_json::Value] = obj
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| a.as_slice())
            .unwrap_or(&[]);
        check_command(cmd, args, trusted_command)?;
    }

    if let Some(args) = obj.get("args") {
        let arr = args
            .as_array()
            .ok_or_else(|| "args must be an array".to_string())?;
        for (i, a) in arr.iter().enumerate() {
            let s = a
                .as_str()
                .ok_or_else(|| format!("args[{}] must be a string", i))?;
            for needle in MCP_FORBIDDEN_ARG_FRAGMENTS {
                if s.contains(needle) {
                    return Err(format!(
                        "args[{}] contains forbidden fragment '{}'",
                        i, needle
                    ));
                }
            }
        }
    }

    if let Some(url) = obj.get("url").and_then(|v| v.as_str()) {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("url must be http(s)://".into());
        }
    }

    if let Some(env) = obj.get("env") {
        if !env.is_object() {
            return Err("env must be a JSON object".into());
        }
    }

    Ok(())
}

pub fn add_mcp_inner(name: String, config: serde_json::Value) -> Result<McpMutationResult, String> {
    validate_mcp_name(&name)?;
    validate_mcp_config(&config)?;
    mutate_user_servers(&name, |servers| {
        if servers.contains_key(&name) {
            return Err(format!(
                "mcpServers['{}'] already exists in ~/.claude.json",
                name
            ));
        }
        servers.insert(name.clone(), config.clone());
        Ok(())
    })
}

/// Claves que el formulario controla. Al editar se sustituyen estas y se
/// conservan las demás de la entrada (`headers`, `timeout`, `alwaysAllow`…),
/// que el formulario no muestra.
const FORM_KEYS: &[&str] = &["command", "args", "env", "url", "type"];

pub(super) fn merge_edited_config(
    existing: &serde_json::Value,
    edited: &serde_json::Value,
) -> serde_json::Value {
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    for k in FORM_KEYS {
        merged.remove(*k);
    }
    if let Some(obj) = edited.as_object() {
        for (k, v) in obj {
            merged.insert(k.clone(), v.clone());
        }
    }
    serde_json::Value::Object(merged)
}

pub fn update_mcp_inner(
    name: String,
    config: serde_json::Value,
) -> Result<McpMutationResult, String> {
    validate_existing_name(&name)?;
    let store = ClaudeJsonStore::user()?;
    let Some(existing) = store.server(&name)? else {
        if in_legacy_settings(&name)? {
            return Err(format!(
                "'{}' está en ~/.claude/settings.json, que Claude Code no lee para MCP: bórralo y dalo de alta de nuevo",
                name
            ));
        }
        return Err(format!(
            "mcpServers['{}'] does not exist in ~/.claude.json",
            name
        ));
    };
    let trusted = existing.get("command").and_then(|v| v.as_str());
    validate_mcp_config_with(&config, trusted)?;
    mutate_user_servers(&name, |servers| {
        let Some(current) = servers.get(&name) else {
            return Err(format!(
                "mcpServers['{}'] does not exist in ~/.claude.json",
                name
            ));
        };
        let merged = merge_edited_config(current, &config);
        servers.insert(name.clone(), merged);
        Ok(())
    })
}

/// Borra del ámbito de usuario (`~/.claude.json`) y, si no está ahí, del
/// `mcpServers` legado de settings.json.
pub fn delete_mcp_inner(name: String) -> Result<McpMutationResult, String> {
    validate_existing_name(&name)?;
    if ClaudeJsonStore::user()?.server(&name)?.is_some() {
        return mutate_user_servers(&name, |servers| {
            if servers.remove(&name).is_none() {
                return Err(format!("mcpServers['{}'] does not exist", name));
            }
            Ok(())
        });
    }
    delete_from_legacy_settings(&name)
}
