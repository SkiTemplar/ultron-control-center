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

#[cfg(test)]
mod tests {
    use super::*;

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
