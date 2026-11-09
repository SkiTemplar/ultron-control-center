// sesiones/catalogo.rs — Paleta de comandos `/` (`sesiones_commands`) y
// resolución de `/x args` (contrato de estabilidad, §2.1-§2.3 y cambio de
// diseño del 2026-10-08).
//
// Fuentes, por orden de preferencia:
// 1. Lista viva `$.command.list()` del mod `ultron-puente` (evento
//    `commands`), guardada por sesión: es lo que la sesión puede ejecutar.
// 2. Metadatos estáticos (`catalogo_meta.rs`): clase, argumentos, inmediato,
//    alias y nota; se fusionan por nombre con la lista viva.
// 3. Sin puente (reserva): integrados de `BUILTIN_META`, comandos de los mods
//    activos (`CLAUDE_CODE_PLUGIN_DIRS`), skills activas
//    (`~/.claude/skills/*/SKILL.md`; `_disabled/` y `_archived/` no cargan),
//    comandos del usuario (`~/.claude/commands/**.md`) y del proyecto
//    (`<cwd>/.claude/commands/**.md`). Caché por cwd que se invalida si cambia
//    el número o la fecha de modificación de algún fichero de origen. Los
//    plugins del marketplace no se replican: la lista es parcial sin puente.
//
// Propiedad: WP-ESTADO.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use super::ajustes::{claude_settings_path, read_json};
use super::mods::{enabled_plugin_dirs, mod_commands};
use super::types::{CommandDef, CommandKind};

#[path = "catalogo_meta.rs"]
pub mod meta;
use meta::{Meta, BUILTIN_META, MOD_META};

#[path = "catalogo_viva.rs"]
mod viva;
#[cfg(test)]
pub use viva::fusionar_viva;
pub use viva::{guardar_viva, lista_viva, olvidar_viva, resolver, Resuelto};

const DESC_MAX: usize = 200;
/// Nota de un comando desconocido sin lista viva (§2.2).
pub const NOTA_NO_CATALOGADO: &str = "Comando no catalogado: se envía a Claude Code tal cual";
const NOTA_SIN_CLASIFICAR: &str = "Integrado sin clasificar: se abre como menú en el chat";

fn def(
    name: &str,
    desc: &str,
    hint: Option<&str>,
    source: &str,
    origin: Option<&str>,
) -> CommandDef {
    let mut d = CommandDef {
        name: name.to_string(),
        description: super::transcript::truncate_chars(desc.trim(), DESC_MAX),
        arg_hint: hint.map(str::to_string),
        source: source.to_string(),
        origin: origin.map(str::to_string),
        kind: CommandKind::Prompt,
        panel: None,
        needs_args: false,
        immediate: false,
        note: None,
        aliases: Vec::new(),
    };
    let m = match source {
        "builtin" => meta::builtin(name),
        "mod" => meta::de_mod(name),
        _ => None,
    };
    if let Some(m) = m {
        con_meta(&mut d, m);
    } else if source == "builtin" {
        d.kind = CommandKind::Menu;
        d.note = Some(NOTA_SIN_CLASIFICAR.to_string());
    }
    d
}

fn con_meta(d: &mut CommandDef, m: &Meta) {
    d.kind = m.kind;
    d.needs_args = m.needs_args;
    d.immediate = m.immediate;
    d.note = m.nota.map(str::to_string);
    d.aliases = m.aliases.iter().map(|a| (*a).to_string()).collect();
    if d.arg_hint.is_none() {
        d.arg_hint = m.hint.map(str::to_string);
    }
}

/// Clase sin argumentos de un comando por nombre o alias (integrados y mods
/// de ULTRON); `prompt` si no hay metadatos (skills, plugins, usuario, MCP).
pub fn kind_por_nombre(nombre: &str) -> CommandKind {
    let n = nombre.trim().trim_start_matches('/');
    let n = n.split_whitespace().next().unwrap_or_default();
    meta::builtin(n)
        .or_else(|| meta::de_mod(n))
        .map_or(CommandKind::Prompt, |m| m.kind)
}

/// Campos de primer nivel del frontmatter YAML de un markdown: `clave: valor`
/// y bloques `>` / `|` (líneas sangradas unidas con espacios).
pub fn frontmatter(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    // El BOM de UTF-8 no es espacio: sin quitarlo, `---` no se reconoce.
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim) != Some("---") {
        return out;
    }
    let mut block: Option<(String, Vec<String>)> = None;
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if line.starts_with(char::is_whitespace) {
            if let Some((_, acc)) = block.as_mut() {
                acc.push(line.trim().to_string());
            }
            continue;
        }
        if let Some((k, acc)) = block.take() {
            out.insert(k, acc.join(" ").trim().to_string());
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim();
        if v.starts_with('>') || v.starts_with('|') {
            block = Some((k.trim().to_string(), Vec::new()));
        } else if !v.is_empty() {
            let v = v.trim_matches(|c| c == '"' || c == '\'');
            out.insert(k.trim().to_string(), v.to_string());
        }
    }
    if let Some((k, acc)) = block {
        out.insert(k, acc.join(" ").trim().to_string());
    }
    out
}

fn skill_files(skills_dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(skills_dir) else {
        return Vec::new();
    };
    let mut v: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            let n = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            p.is_dir() && !n.starts_with('_') && !n.starts_with('.')
        })
        .map(|p| p.join("SKILL.md"))
        .filter(|p| p.is_file())
        .collect();
    v.sort();
    v
}

/// Ficheros `.md` de comandos con su nombre (`sub/x.md` → `sub:x`).
fn command_files(dir: &Path) -> Vec<(String, PathBuf)> {
    fn walk(dir: &Path, prefix: &str, depth: u8, out: &mut Vec<(String, PathBuf)>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for p in rd.filter_map(Result::ok).map(|e| e.path()) {
            let stem = p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if p.is_dir() && depth < 3 {
                walk(&p, &format!("{prefix}{stem}:"), depth + 1, out);
            } else if p.extension().is_some_and(|e| e == "md") {
                out.push((format!("{prefix}{stem}"), p));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, "", 0, &mut out);
    out.sort();
    out
}

fn hook_files(plugin_dirs: &[PathBuf]) -> Vec<PathBuf> {
    plugin_dirs
        .iter()
        .filter_map(|d| std::fs::read_dir(d.join("hooks")).ok())
        .flat_map(|rd| rd.filter_map(Result::ok).map(|e| e.path()))
        .collect()
}

/// Ficheros de los que sale el catálogo (para invalidar la caché).
fn source_files(home: &Path, cwd: &Path, plugin_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut v = vec![home.join(".claude").join("settings.json")];
    v.extend(skill_files(&home.join(".claude").join("skills")));
    v.extend(
        command_files(&home.join(".claude").join("commands"))
            .into_iter()
            .map(|c| c.1),
    );
    v.extend(
        command_files(&cwd.join(".claude").join("commands"))
            .into_iter()
            .map(|c| c.1),
    );
    v.extend(hook_files(plugin_dirs));
    v
}

fn stamp(files: &[PathBuf]) -> (usize, SystemTime) {
    let newest = files
        .iter()
        .filter_map(|f| std::fs::metadata(f).and_then(|m| m.modified()).ok())
        .max()
        .unwrap_or(SystemTime::UNIX_EPOCH);
    (files.len(), newest)
}

fn md_commands(dir: &Path, source: &str) -> Vec<CommandDef> {
    command_files(dir)
        .into_iter()
        .map(|(name, path)| {
            let fm = std::fs::read_to_string(&path)
                .map(|t| frontmatter(&t))
                .unwrap_or_default();
            let desc = fm.get("description").cloned().unwrap_or_default();
            def(
                &name,
                &desc,
                fm.get("argument-hint").map(String::as_str),
                source,
                None,
            )
        })
        .collect()
}

/// Catálogo completo para `home` y `cwd` con los plugins activos dados.
pub fn catalog_in(home: &Path, cwd: &Path, plugin_dirs: &[PathBuf]) -> Vec<CommandDef> {
    let mut out: Vec<CommandDef> = BUILTIN_META
        .iter()
        .map(|m| def(m.nombre, m.desc, m.hint, "builtin", None))
        .collect();
    for dir in plugin_dirs {
        out.extend(comandos_de_mod(dir));
    }
    for f in skill_files(&home.join(".claude").join("skills")) {
        let fm = std::fs::read_to_string(&f)
            .map(|t| frontmatter(&t))
            .unwrap_or_default();
        let folder = f
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned());
        let Some(name) = fm.get("name").cloned().or(folder) else {
            continue;
        };
        let desc = fm.get("description").cloned().unwrap_or_default();
        out.push(def(&name, &desc, None, "skill", Some(&name)));
    }
    out.extend(md_commands(&home.join(".claude").join("commands"), "user"));
    out.extend(md_commands(
        &cwd.join(".claude").join("commands"),
        "project",
    ));
    out
}

/// Comandos de un mod activo: los que atiende por `command.run` y, de los
/// mods de ULTRON, los de `MOD_META` que registra en bucle (ultron-atajos).
fn comandos_de_mod(dir: &Path) -> Vec<CommandDef> {
    let origin = dir.file_name().map(|n| n.to_string_lossy().into_owned());
    let mut out: Vec<CommandDef> = mod_commands(dir)
        .into_iter()
        .map(|c| {
            let desc = c.description.unwrap_or_default();
            def(
                &c.name,
                &desc,
                c.arg_hint.as_deref(),
                "mod",
                origin.as_deref(),
            )
        })
        .collect();
    let faltan: Vec<&Meta> = MOD_META
        .iter()
        .filter(|m| m.plugin == origin.as_deref())
        .filter(|m| !out.iter().any(|c| c.name == m.nombre))
        .collect();
    for m in faltan {
        out.push(def(m.nombre, m.desc, m.hint, "mod", origin.as_deref()));
    }
    out
}

type CacheEntry = ((usize, SystemTime), Vec<CommandDef>);

pub fn commands(cwd: &str) -> Result<Vec<CommandDef>, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    // `cwd` lo manda la ventana: un UNC no llega a `is_dir` (conexión SMB).
    if super::archivos::es_ruta_de_red(cwd) {
        return Err(super::archivos::ERROR_RUTA_DE_RED.to_string());
    }
    let cwd_path = Path::new(cwd.trim());
    if cwd.trim().is_empty() || !cwd_path.is_dir() {
        return Err(format!("el directorio no existe: '{cwd}'"));
    }
    let home = dirs::home_dir().ok_or_else(|| "no hay directorio personal".to_string())?;
    let settings = claude_settings_path().map_or(serde_json::Value::Null, |p| read_json(&p));
    let plugins = enabled_plugin_dirs(&settings, &home);
    let st = stamp(&source_files(&home, cwd_path, &plugins));
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((s, v)) = cache.lock().ok().and_then(|c| c.get(cwd).cloned()) {
        if s == st {
            return Ok(v);
        }
    }
    let fresh = catalog_in(&home, cwd_path, &plugins);
    if let Ok(mut c) = cache.lock() {
        c.insert(cwd.to_string(), (st, fresh.clone()));
    }
    Ok(fresh)
}

#[cfg(test)]
#[path = "tests_catalogo.rs"]
mod tests;
