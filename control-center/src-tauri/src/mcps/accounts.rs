// mcps/accounts.rs — cuentas multi-token por plantilla de MCP.
//
// Problema (2026-08-17): servicios como Supabase limitan organizaciones por
// cuenta, así que el usuario reparte proyectos entre varios correos. El
// conector OAuth de claude.ai solo mantiene UNA sesión, y rotar exigía
// desconectar/reconectar a mano. Solución: N servers MCP locales (stdio), uno
// por cuenta, cada uno con su token — todos disponibles a la vez; el modelo
// elige el server por nombre según el proyecto mencionado.
//
// Este módulo escribe esas entradas en `mcpServers` (top-level) de
// `~/.claude.json` con backup + escritura atómica. El token viaja del
// formulario de la UI a ese JSON local: nunca pasa por un chat ni por logs.
// Solo se listan/eliminan servers que MATCHEAN una plantilla conocida (guard:
// esta UI no puede tocar MCPs ajenos). Claude Code lee `mcpServers` al abrir
// sesión: los cambios piden reiniciar la sesión, y así lo avisa la UI.

use std::path::PathBuf;

/// Plantilla de un MCP autenticado por token de cuenta.
#[derive(Debug, Clone, serde::Serialize)]
pub struct McpAccountTemplate {
    pub id: &'static str,
    pub label: &'static str,
    /// Nombre de la env var que el server espera con el token.
    pub env_key: &'static str,
    /// Paquete npx que identifica la plantilla (también en el guard de list/remove).
    pub package: &'static str,
    /// Flag opcional de solo-lectura que soporta el server (o None).
    pub read_only_flag: Option<&'static str>,
    /// Dónde genera el usuario el token de cada cuenta.
    pub docs_url: &'static str,
}

/// Catálogo de plantillas. Añadir aquí = aparece en la UI sin tocar nada más.
pub const TEMPLATES: &[McpAccountTemplate] = &[
    McpAccountTemplate {
        id: "supabase",
        label: "Supabase",
        env_key: "SUPABASE_ACCESS_TOKEN",
        package: "@supabase/mcp-server-supabase",
        read_only_flag: Some("--read-only"),
        docs_url: "https://supabase.com/dashboard/account/tokens",
    },
    // Mismo paquete que el server `github-pat` ya en uso en esta máquina:
    // coherencia antes que novedad (el server Go oficial exige docker).
    McpAccountTemplate {
        id: "github",
        label: "GitHub",
        env_key: "GITHUB_PERSONAL_ACCESS_TOKEN",
        package: "@modelcontextprotocol/server-github",
        read_only_flag: None,
        docs_url: "https://github.com/settings/tokens",
    },
];

fn template_by_id(id: &str) -> Option<&'static McpAccountTemplate> {
    TEMPLATES.iter().find(|t| t.id == id)
}

/// Una cuenta ya configurada, con el token SIEMPRE enmascarado.
#[derive(Debug, Clone, serde::Serialize)]
pub struct McpAccountRow {
    pub name: String,
    pub template_id: String,
    pub token_masked: String,
    pub read_only: bool,
}

/// Alias -> slug: minúsculas, espacios/underscores a '-', solo [a-z0-9-].
/// Devuelve Err con el motivo si tras limpiar no queda nada.
pub fn slugify_alias(alias: &str) -> Result<String, String> {
    let slug: String = alias
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c == ' ' || c == '_' { '-' } else { c })
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        return Err(format!("alias '{alias}' no produce un slug válido"));
    }
    Ok(slug)
}

/// Enmascara un token para la UI: 4+…+4, o todo asteriscos si es corto.
pub fn mask_token(token: &str) -> String {
    let t = token.trim();
    if t.len() <= 10 {
        return "*".repeat(t.len().max(4));
    }
    format!("{}…{}", &t[..4], &t[t.len() - 4..])
}

/// Construye la entrada `mcpServers.<name>` para una plantilla. En Windows los
/// stdio npx necesitan el wrapper `cmd /c` (gotcha conocido de Tauri/CC).
pub fn build_server_entry(
    tpl: &McpAccountTemplate,
    token: &str,
    read_only: bool,
) -> serde_json::Value {
    let mut args: Vec<String> = if cfg!(windows) {
        vec!["/c".into(), "npx".into()]
    } else {
        Vec::new()
    };
    args.extend(["-y".to_string(), format!("{}@latest", tpl.package)]);
    if read_only {
        if let Some(flag) = tpl.read_only_flag {
            args.push(flag.to_string());
        }
    }
    let command = if cfg!(windows) { "cmd" } else { "npx" };
    serde_json::json!({
        "type": "stdio",
        "command": command,
        "args": args,
        "env": { tpl.env_key: token.trim() },
    })
}

/// ¿Esta entrada de `mcpServers` pertenece a la plantilla? El guard exige las
/// DOS señales: prefijo `<id>-` en el nombre y el paquete en los args — así un
/// server ajeno que casualmente se llame `supabase-x` no es tocable desde aquí.
pub fn entry_matches_template(
    name: &str,
    cfg: &serde_json::Value,
    tpl: &McpAccountTemplate,
) -> bool {
    if !name.starts_with(&format!("{}-", tpl.id)) {
        return false;
    }
    cfg.get("args")
        .and_then(|a| a.as_array())
        .is_some_and(|args| {
            args.iter()
                .filter_map(|v| v.as_str())
                .any(|s| s.contains(tpl.package))
        })
}

fn claude_json_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".claude.json"))
        .ok_or_else(|| "sin home dir".to_string())
}

fn backups_dir() -> Result<PathBuf, String> {
    let dir = dirs::home_dir()
        .map(|h| h.join(".ultron").join("backups").join("claude-json"))
        .ok_or_else(|| "sin home dir".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir backups: {e}"))?;
    Ok(dir)
}

fn load_claude_json() -> Result<serde_json::Value, String> {
    let path = claude_json_path()?;
    let body =
        std::fs::read_to_string(&path).map_err(|e| format!("leer {}: {e}", path.display()))?;
    serde_json::from_str(&body).map_err(|e| format!("parsear {}: {e}", path.display()))
}

/// Backup con timestamp + escritura atómica (tmp + rename, mismo volumen).
/// El round-trip es sobre `serde_json::Value`: se preserva TODO lo que Claude
/// Code guarde ahí, conocido o no.
fn save_claude_json(value: &serde_json::Value) -> Result<String, String> {
    let path = claude_json_path()?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let backup = backups_dir()?.join(format!("claude.json.{stamp}.bak"));
    std::fs::copy(&path, &backup).map_err(|e| format!("backup: {e}"))?;
    let body = serde_json::to_string_pretty(value).map_err(|e| format!("serializar: {e}"))?;
    let tmp = path.with_extension(format!("json.tmp.{}", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| format!("escribir tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename atómico: {e}"))?;
    Ok(backup.display().to_string())
}

/// Cuentas configuradas (solo las que matchean plantilla; token enmascarado).
pub fn accounts_list_inner() -> Result<Vec<McpAccountRow>, String> {
    let root = load_claude_json()?;
    let Some(servers) = root.get("mcpServers").and_then(|v| v.as_object()) else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for (name, cfg) in servers {
        for tpl in TEMPLATES {
            if !entry_matches_template(name, cfg, tpl) {
                continue;
            }
            let token = cfg
                .get("env")
                .and_then(|e| e.get(tpl.env_key))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let read_only = tpl.read_only_flag.is_some_and(|flag| {
                cfg.get("args")
                    .and_then(|a| a.as_array())
                    .is_some_and(|args| args.iter().filter_map(|v| v.as_str()).any(|s| s == flag))
            });
            rows.push(McpAccountRow {
                name: name.clone(),
                template_id: tpl.id.to_string(),
                token_masked: mask_token(token),
                read_only,
            });
        }
    }
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(rows)
}

/// Alta de una cuenta. Devuelve (nombre_final, ruta_backup).
pub fn account_add_inner(
    template_id: &str,
    alias: &str,
    token: &str,
    read_only: bool,
) -> Result<(String, String), String> {
    let tpl = template_by_id(template_id)
        .ok_or_else(|| format!("plantilla desconocida: {template_id}"))?;
    if token.trim().is_empty() {
        return Err("token vacío".into());
    }
    let name = format!("{}-{}", tpl.id, slugify_alias(alias)?);
    let mut root = load_claude_json()?;
    let servers = root
        .as_object_mut()
        .ok_or("~/.claude.json no es un objeto JSON")?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    let servers = servers
        .as_object_mut()
        .ok_or("mcpServers no es un objeto")?;
    if servers.contains_key(&name) {
        return Err(format!(
            "ya existe un server '{name}' — elige otro alias o elimínalo antes"
        ));
    }
    servers.insert(name.clone(), build_server_entry(tpl, token, read_only));
    let backup = save_claude_json(&root)?;
    Ok((name, backup))
}

/// Baja de una cuenta. Solo elimina entradas que matchean plantilla (guard).
pub fn account_remove_inner(name: &str) -> Result<String, String> {
    let mut root = load_claude_json()?;
    let servers = root
        .get_mut("mcpServers")
        .and_then(|v| v.as_object_mut())
        .ok_or("sin mcpServers en ~/.claude.json")?;
    let Some(cfg) = servers.get(name) else {
        return Err(format!("no existe el server '{name}'"));
    };
    let managed = TEMPLATES
        .iter()
        .any(|tpl| entry_matches_template(name, cfg, tpl));
    if !managed {
        return Err(format!(
            "'{name}' no es una cuenta gestionada por plantilla — edítalo desde settings.json"
        ));
    }
    servers.remove(name);
    save_claude_json(&root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn supabase() -> &'static McpAccountTemplate {
        template_by_id("supabase").expect("plantilla supabase presente")
    }

    #[test]
    fn slugify_normaliza_y_rechaza_vacio() {
        assert_eq!(slugify_alias("Mi Tienda").unwrap(), "mi-tienda");
        assert_eq!(slugify_alias("  blog_2 ").unwrap(), "blog-2");
        // Caso negativo: sin material para un slug no hay alta silenciosa.
        assert!(slugify_alias("¡¡¡").is_err());
        assert!(slugify_alias("   ").is_err());
    }

    #[test]
    fn mask_nunca_expone_el_token_entero() {
        let m = mask_token("sbp_0123456789abcdef");
        assert!(m.starts_with("sbp_"));
        assert!(m.ends_with("cdef"));
        assert!(!m.contains("0123456789"));
        assert_eq!(mask_token("corto"), "*****");
    }

    #[test]
    fn entry_para_supabase_lleva_token_y_flag() {
        let e = build_server_entry(supabase(), " sbp_x ", true);
        assert_eq!(e["env"]["SUPABASE_ACCESS_TOKEN"], "sbp_x");
        let args: Vec<&str> = e["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(args
            .iter()
            .any(|a| a.contains("@supabase/mcp-server-supabase")));
        assert!(args.contains(&"--read-only"));
        // Sin read_only el flag no aparece.
        let e2 = build_server_entry(supabase(), "sbp_x", false);
        assert!(!e2["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "--read-only"));
    }

    #[test]
    fn guard_exige_prefijo_y_paquete() {
        let tpl = supabase();
        let real = build_server_entry(tpl, "sbp_x", false);
        assert!(entry_matches_template("supabase-tienda", &real, tpl));
        // Caso negativo 1: nombre correcto pero server ajeno (otro paquete).
        let ajeno = serde_json::json!({
            "type": "stdio", "command": "npx",
            "args": ["-y", "otra-cosa"], "env": {}
        });
        assert!(!entry_matches_template("supabase-tienda", &ajeno, tpl));
        // Caso negativo 2: paquete correcto pero sin el prefijo de plantilla.
        assert!(!entry_matches_template("mi-server", &real, tpl));
    }
}
