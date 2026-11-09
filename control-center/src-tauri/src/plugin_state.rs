//! Shared cross-check of settings.json `enabledPlugins` (casilla 2.2, gemela de 0.6).
//!
//! Hooks, Skills and Agents all surface items cached under
//! `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/{hooks|skills|agents}/`.
//! When a plugin is DISABLED in `settings.json`
//! (`enabledPlugins["<plugin>@<marketplace>"] = false`) its cached items are
//! INERT: they must be reported as `enabled = false`, never counted as active —
//! otherwise the Active counts in the Skills/Agents tabs lie (mand. 11/13).
//!
//! `hooks_admin::io` keeps an equivalent on the (already tested) hooks path;
//! this module is the shared home used by Skills and Agents.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// `<plugin>@<marketplace>` -> enabled, read from `~/.claude/settings.json`
/// `enabledPlugins`. A key that is absent, or present and `true`, means active;
/// only an explicit `false` marks the plugin (and its cached items) inert.
pub(crate) fn read_enabled_plugins() -> HashMap<String, bool> {
    let mut map = HashMap::new();
    let Some(home) = dirs::home_dir() else {
        return map;
    };
    let path = home.join(".claude").join("settings.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return map;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return map;
    };
    if let Some(obj) = value.get("enabledPlugins").and_then(|x| x.as_object()) {
        for (k, val) in obj {
            if let Some(b) = val.as_bool() {
                map.insert(k.clone(), b);
            }
        }
    }
    map
}

/// A plugin is inert only when `settings.json` marks it explicitly `false`
/// (key `<plugin>@<marketplace>`). Absent or `true` => active by default.
pub(crate) fn plugin_is_disabled(
    plugin: &str,
    marketplace: &str,
    enabled: &HashMap<String, bool>,
) -> bool {
    matches!(enabled.get(&format!("{plugin}@{marketplace}")), Some(false))
}

/// `<plugin>@<marketplace>` -> `installPath` de la primera instalación listada
/// en `~/.claude/plugins/installed_plugins.json`. `None` si el fichero falta o
/// no se puede leer: el llamante cae entonces al orden de la caché.
pub(crate) fn read_installed_paths() -> Option<HashMap<String, PathBuf>> {
    let home = dirs::home_dir()?;
    let path = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    parse_installed_paths(&raw)
}

pub(crate) fn parse_installed_paths(raw: &str) -> Option<HashMap<String, PathBuf>> {
    let value = match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("plugin_state: installed_plugins.json ilegible, se ignora: {e}");
            return None;
        }
    };
    let plugins = value.get("plugins")?.as_object()?;
    let map = plugins
        .iter()
        .filter_map(|(key, entries)| {
            let install = entries.as_array()?.first()?.get("installPath")?.as_str()?;
            Some((key.clone(), PathBuf::from(install)))
        })
        .collect();
    Some(map)
}

/// Directorio de versión de `<marketplace>/<plugin>` que hay que mostrar.
///
/// La caché guarda versiones viejas (hashes de commit que no ordenan como
/// semver), así que manda `installed_plugins.json`: la versión instalada si
/// existe en disco; ninguna si el plugin ya no está instalado (caché huérfana).
/// Sin manifiesto, o si la ruta instalada falta, el mayor nombre en orden
/// lexicográfico descendente.
pub(crate) fn pick_version_dir(
    plugin_dir: &Path,
    key: &str,
    installed: Option<&HashMap<String, PathBuf>>,
) -> Option<PathBuf> {
    if let Some(map) = installed {
        let install = map.get(key)?;
        if install.is_dir() {
            return Some(install.clone());
        }
    }
    let mut versions: Vec<PathBuf> = std::fs::read_dir(plugin_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    versions.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_version_dir_prefiere_la_instalada_al_orden_lexicografico() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = tmp.path().join("pr-review-toolkit");
        for v in ["1.0.1", "f61e6d15fc03", "41f619d61b99"] {
            std::fs::create_dir_all(plugin.join(v)).unwrap();
        }
        let raw = format!(
            r#"{{"version":2,"plugins":{{"pr-review-toolkit@mkt":[{{"installPath":{}}}]}}}}"#,
            serde_json::to_string(&plugin.join("1.0.1")).unwrap()
        );
        let installed = parse_installed_paths(&raw).unwrap();
        let key = "pr-review-toolkit@mkt";

        assert_eq!(
            pick_version_dir(&plugin, key, Some(&installed)),
            Some(plugin.join("1.0.1"))
        );
        // Sin manifiesto: orden lexicográfico (el hash gana a 1.0.1).
        assert_eq!(
            pick_version_dir(&plugin, key, None),
            Some(plugin.join("f61e6d15fc03"))
        );
        // Plugin no instalado: caché huérfana, no se muestra (caso negativo).
        assert_eq!(
            pick_version_dir(&plugin, "otro@mkt", Some(&installed)),
            None
        );
    }

    #[test]
    fn pick_version_dir_cae_a_la_cache_si_falta_la_ruta_instalada() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = tmp.path().join("codex");
        std::fs::create_dir_all(plugin.join("1.0.4")).unwrap();
        let mut installed = HashMap::new();
        installed.insert("codex@mkt".to_string(), plugin.join("1.0.6"));

        assert_eq!(
            pick_version_dir(&plugin, "codex@mkt", Some(&installed)),
            Some(plugin.join("1.0.4"))
        );
    }

    #[test]
    fn parse_installed_paths_rechaza_json_corrupto() {
        assert!(parse_installed_paths("{ no es json").is_none());
    }

    #[test]
    fn plugin_is_disabled_only_on_explicit_false() {
        let mut map = HashMap::new();
        map.insert("ecc@ecc".to_string(), false);
        map.insert("superpowers@obra".to_string(), true);

        // explicit false => inert
        assert!(plugin_is_disabled("ecc", "ecc", &map));
        // explicit true => active
        assert!(!plugin_is_disabled("superpowers", "obra", &map));
        // absent => active by default (negative case, mand. 7)
        assert!(!plugin_is_disabled("unknown", "mkt", &map));
        // marketplace mismatch => different key => active (not the disabled one)
        assert!(!plugin_is_disabled("ecc", "other-mkt", &map));
    }
}
