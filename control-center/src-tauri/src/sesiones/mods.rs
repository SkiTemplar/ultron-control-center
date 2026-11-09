// sesiones/mods.rs — Mods de ULTRON: plugins activos y sus comandos para el
// catálogo de slash commands (`catalogo.rs`; contrato v0.2, E10). La lista
// de mods (`sesiones_mods`) se retiró el 2026-10-26 (sin consumidor en la UI).
//
// Un mod es una carpeta de `~/.ultron/mods/<nombre>` con
// `.claude-plugin/plugin.json`. Está activo si su ruta figura en
// `env.CLAUDE_CODE_PLUGIN_DIRS` de `~/.claude/settings.json` (lista separada
// por `;` en Windows, con `~/` permitido). Sus comandos son los que atiende con
// `on('command.run', { command: '<nombre>' }, …)` en `hooks/*.ts|tsx`; la
// descripción sale de `$.command.register({ name, description, argumentHint })`.
//
// Solo lectura: activar o desactivar mods desde Sesiones se retiró el
// 2026-10-14 junto con la pestaña Mods del inspector.

use std::path::{Path, PathBuf};

use serde_json::Value;

pub const PLUGIN_DIRS_KEY: &str = "CLAUDE_CODE_PLUGIN_DIRS";
const SEP: char = if cfg!(windows) { ';' } else { ':' };

/// Comando registrado por un mod.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModCommand {
    pub name: String,
    pub description: Option<String>,
    pub arg_hint: Option<String>,
}

fn expand(entry: &str, home: &Path) -> String {
    let e = entry.trim();
    match e.strip_prefix("~/").or_else(|| e.strip_prefix("~\\")) {
        Some(rest) => home.join(rest).to_string_lossy().into_owned(),
        None => e.to_string(),
    }
}

/// Entradas de `CLAUDE_CODE_PLUGIN_DIRS` de un settings.
pub fn plugin_dir_entries(settings: &Value) -> Vec<String> {
    settings
        .pointer(&format!("/env/{PLUGIN_DIRS_KEY}"))
        .and_then(Value::as_str)
        .map(|s| {
            s.split(SEP)
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Rutas absolutas de los plugins activos.
pub fn enabled_plugin_dirs(settings: &Value, home: &Path) -> Vec<PathBuf> {
    plugin_dir_entries(settings)
        .iter()
        .map(|e| PathBuf::from(expand(e, home)))
        .collect()
}

/// Valor literal de `key: '…'` (comillas simples, dobles o invertidas).
pub fn string_field(block: &str, key: &str) -> Option<String> {
    let re = regex::Regex::new(&format!(r#"\b{key}\s*:\s*(['"`])"#)).ok()?;
    let m = re.captures(block)?;
    let quote = m.get(1)?.as_str().chars().next()?;
    let mut out = String::new();
    let mut chars = block[m.get(0)?.end()..].chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.push(chars.next()?),
            c if c == quote => return Some(out),
            c => out.push(c),
        }
    }
    None
}

fn hook_sources(mod_dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(mod_dir.join("hooks")) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            let n = p
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            (n.ends_with(".ts") || n.ends_with(".tsx"))
                && !n.contains(".test.")
                && !n.ends_with(".d.ts")
        })
        .collect();
    files.sort();
    files
        .iter()
        .filter_map(|f| std::fs::read_to_string(f).ok())
        .collect()
}

/// Comandos que atiende un mod, con su descripción si la registra.
pub fn mod_commands(mod_dir: &Path) -> Vec<ModCommand> {
    let run_re = regex::Regex::new(
        r#"on\(\s*['"]command\.run['"]\s*,\s*\{\s*command\s*:\s*['"]([A-Za-z0-9][A-Za-z0-9:_-]*)['"]"#,
    );
    let reg_re = regex::Regex::new(r"command\.register\(\s*\{([^}]*)\}");
    let (Ok(run_re), Ok(reg_re)) = (run_re, reg_re) else {
        return Vec::new();
    };
    let mut out: Vec<ModCommand> = Vec::new();
    for src in hook_sources(mod_dir) {
        let regs: Vec<&str> = reg_re
            .captures_iter(&src)
            .filter_map(|c| c.get(1).map(|m| m.as_str()))
            .collect();
        for c in run_re.captures_iter(&src) {
            let Some(name) = c.get(1).map(|m| m.as_str().to_string()) else {
                continue;
            };
            if out.iter().any(|m| m.name == name) {
                continue;
            }
            let reg = regs
                .iter()
                .find(|b| string_field(b, "name").as_deref() == Some(name.as_str()));
            out.push(ModCommand {
                description: reg.and_then(|b| string_field(b, "description")),
                arg_hint: reg.and_then(|b| string_field(b, "argumentHint")),
                name,
            });
        }
    }
    out
}

#[cfg(test)]
#[path = "tests_mods.rs"]
mod tests;
