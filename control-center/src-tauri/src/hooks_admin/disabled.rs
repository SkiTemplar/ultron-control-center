// hooks_admin/disabled.rs — hooks desactivados desde la UI, fuera de settings.json.
//
// Hasta el 2026-10-23 (hooks-8 de la auditoría) el interruptor escribía
// `type: "disabled-command"` en ~/.claude/settings.json. Claude Code valida
// cada entrada de `hooks` contra una unión cerrada de tipos (command, prompt,
// agent, http, mcp_tool), así que ese valor abría el diálogo «Settings Error»
// al arrancar y regen-manifest lo copiaba a la plantilla del instalador.
// Ahora desactivar saca la entrada de settings.json y la guarda en
// ~/.ultron/cockpit/hooks-disabled.json con su evento y su matcher; activarla
// la devuelve al grupo de su matcher. Las entradas `disabled-command` que
// queden de antes se siguen leyendo como desactivadas.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::io::compute_id;
use super::types::Hook;

/// Una entrada sacada de settings.json: el objeto tal cual y dónde vivía.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct DisabledHook {
    pub event: String,
    #[serde(default)]
    pub matcher: Option<String>,
    pub entry: Value,
}

impl DisabledHook {
    pub(crate) fn command(&self) -> &str {
        self.entry
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
    }

    pub(crate) fn id(&self) -> String {
        compute_id(&self.event, self.matcher.as_deref(), self.command())
    }

    /// Vista para la pantalla: desactivado y con el resto de campos en `extra`.
    pub(crate) fn to_hook(&self) -> Hook {
        let mut extra = Map::new();
        if let Some(obj) = self.entry.as_object() {
            for (k, v) in obj {
                if k != "type" && k != "command" {
                    extra.insert(k.clone(), v.clone());
                }
            }
        }
        Hook {
            id: self.id(),
            event: self.event.clone(),
            matcher: self.matcher.clone(),
            command: self.command().to_string(),
            enabled: false,
            source: "user".to_string(),
            description: None,
            extra: Value::Object(extra),
        }
    }
}

pub(crate) fn store_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| {
        h.join(".ultron")
            .join("cockpit")
            .join("hooks-disabled.json")
    })
}

/// Lee el almacén; ausente = vacío. Corrupto = error (no se pisa a ciegas).
pub(crate) fn read_store(path: &Path) -> Result<Vec<DisabledHook>, String> {
    match fs::read_to_string(path) {
        Ok(raw) if raw.trim().is_empty() => Ok(Vec::new()),
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Escritura atómica (tmp + rename).
pub(crate) fn write_store(path: &Path, items: &[DisabledHook]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    let body = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body + "\n").map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))
}

fn group_matcher(group: &Value) -> Option<String> {
    group
        .get("matcher")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Copia (sin quitarla) la entrada `id` de settings.json, con el tipo
/// normalizado a `command`. `None` si no está.
pub(crate) fn find_entry(hooks_obj: &Map<String, Value>, id: &str) -> Option<DisabledHook> {
    for (event, groups) in hooks_obj {
        for group in groups.as_array().into_iter().flatten() {
            let matcher = group_matcher(group);
            let entries = group.get("hooks").and_then(|v| v.as_array());
            for entry in entries.into_iter().flatten() {
                let command = entry.get("command").and_then(|v| v.as_str()).unwrap_or("");
                if compute_id(event, matcher.as_deref(), command) != id {
                    continue;
                }
                let mut entry = entry.clone();
                if let Some(obj) = entry.as_object_mut() {
                    obj.insert("type".into(), Value::String("command".into()));
                }
                return Some(DisabledHook {
                    event: event.clone(),
                    matcher,
                    entry,
                });
            }
        }
    }
    None
}

/// Devuelve la entrada al grupo de su matcher (o crea el grupo).
pub(crate) fn insert_entry(
    hooks_obj: &mut Map<String, Value>,
    item: &DisabledHook,
) -> Result<(), String> {
    let arr = hooks_obj
        .entry(item.event.clone())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| format!("'hooks.{}' is not an array", item.event))?;
    for group in arr.iter_mut() {
        if group_matcher(group) != item.matcher {
            continue;
        }
        let inner = group
            .get_mut("hooks")
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| "group 'hooks' is not an array".to_string())?;
        inner.push(item.entry.clone());
        return Ok(());
    }
    let mut group = Map::new();
    if let Some(m) = &item.matcher {
        group.insert("matcher".into(), Value::String(m.clone()));
    }
    group.insert("hooks".into(), Value::Array(vec![item.entry.clone()]));
    arr.push(Value::Object(group));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings() -> Map<String, Value> {
        json!({
            "Stop": [
                { "matcher": "*", "hooks": [
                    { "type": "command", "command": "node a.js", "timeout": 10, "async": true },
                    { "type": "command", "command": "node b.js" }
                ]}
            ]
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn find_entry_copia_con_su_evento_matcher_y_campos() {
        let hooks = settings();
        let id = compute_id("Stop", Some("*"), "node a.js");
        let d = find_entry(&hooks, &id).expect("existe");
        assert_eq!(d.event, "Stop");
        assert_eq!(d.matcher.as_deref(), Some("*"));
        assert_eq!(d.entry["timeout"], 10);
        assert_eq!(d.entry["async"], true);
        assert_eq!(d.id(), id, "el id no cambia al guardarlo fuera");
        assert!(!d.to_hook().enabled);
    }

    #[test]
    fn find_entry_normaliza_el_tipo_legado() {
        let hooks = json!({ "Stop": [ { "hooks": [ { "type": "disabled-command", "command": "node x.js" } ] } ] });
        let id = compute_id("Stop", None, "node x.js");
        let d = find_entry(hooks.as_object().unwrap(), &id).unwrap();
        assert_eq!(d.entry["type"], "command");
    }

    #[test]
    fn insert_entry_vuelve_a_su_grupo_o_crea_uno() {
        let mut hooks = settings();
        let back = DisabledHook {
            event: "Stop".into(),
            matcher: Some("*".into()),
            entry: json!({ "type": "command", "command": "node c.js" }),
        };
        insert_entry(&mut hooks, &back).unwrap();
        assert_eq!(hooks["Stop"][0]["hooks"].as_array().unwrap().len(), 3);
        let nuevo = DisabledHook {
            event: "PreCompact".into(),
            matcher: None,
            entry: json!({ "type": "command", "command": "node d.js" }),
        };
        insert_entry(&mut hooks, &nuevo).unwrap();
        assert_eq!(hooks["PreCompact"][0]["hooks"][0]["command"], "node d.js");
        assert!(hooks["PreCompact"][0].get("matcher").is_none());
    }

    #[test]
    fn almacen_ida_y_vuelta_y_corrupto_es_error() {
        let dir =
            std::env::temp_dir().join(format!("ultron-hooks-disabled-{}", std::process::id()));
        let path = dir.join("hooks-disabled.json");
        assert!(read_store(&path).unwrap().is_empty(), "ausente = vacío");
        let item = DisabledHook {
            event: "Stop".into(),
            matcher: None,
            entry: json!({ "type": "command", "command": "node a.js" }),
        };
        write_store(&path, std::slice::from_ref(&item)).unwrap();
        assert_eq!(read_store(&path).unwrap(), vec![item]);
        fs::write(&path, "{roto").unwrap();
        assert!(read_store(&path).is_err(), "corrupto no se toma por vacío");
        let _ = fs::remove_dir_all(&dir);
    }
}
