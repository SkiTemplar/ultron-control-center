// Mascota — qué tienes delante, para el gorro de Pupus (outfits.ts decide):
// las carpetas de las asignaturas (proyectos con `socratic: "uni"` en
// cockpit/projects.json) y el estado del primer plano que calcula
// desk_watch.rs (ejecutable, título, juego y silencio).

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;

use serde_json::Value;

use super::desk_watch::{self, ForegroundState};

/// Nombres de carpeta (en minúsculas) de las asignaturas y de la carpeta que
/// las agrupa. Pura sobre el JSON, para los tests.
pub fn uni_keys(projects: &Value) -> Vec<String> {
    let mut keys = BTreeSet::new();
    let list = projects
        .get("projects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for p in list {
        if p.get("socratic").and_then(Value::as_str) != Some("uni") {
            continue;
        }
        let Some(path) = p.get("path").and_then(Value::as_str) else {
            continue;
        };
        let path = Path::new(path);
        for part in [path.file_name(), path.parent().and_then(Path::file_name)]
            .into_iter()
            .flatten()
        {
            let k = part.to_string_lossy().to_lowercase();
            if k.len() >= 3 {
                keys.insert(k);
            }
        }
    }
    keys.into_iter().collect()
}

fn load_uni_keys(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| uni_keys(&v))
        .unwrap_or_default()
}

/// (mtime de projects.json, claves): solo se relee si el fichero cambia.
static UNI_CACHE: Mutex<Option<(Option<SystemTime>, Vec<String>)>> = Mutex::new(None);

/// Claves de las asignaturas, cacheadas por fecha de modificación.
pub fn uni_keys_cached() -> Vec<String> {
    let Ok(root) = crate::ultron_root() else {
        return Vec::new();
    };
    let path = root.join("cockpit").join("projects.json");
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    let mut cache = UNI_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((at, keys)) = cache.as_ref() {
        if *at == mtime {
            return keys.clone();
        }
    }
    let keys = load_uni_keys(&path);
    *cache = Some((mtime, keys.clone()));
    keys
}

/// Estado inicial del primer plano (luego llega por `mascot:foreground`).
#[tauri::command]
pub fn mascot_foreground() -> Option<ForegroundState> {
    desk_watch::current()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn solo_cuentan_las_asignaturas() {
        let v = json!({"projects": [
            {"socratic": "uni", "path": "C:\\Users\\x\\CARRERA\\ASIGNATURAS\\ASIG-Primera"},
            {"socratic": "uni", "path": "C:\\Users\\x\\CARRERA\\ASIGNATURAS\\ASIG-Segunda"},
            {"socratic": "strict", "path": "C:\\Users\\x\\ProyectosPersonales\\legacy-fc"},
            {"socratic": "uni"}
        ]});
        assert_eq!(
            uni_keys(&v),
            vec!["asig-primera", "asig-segunda", "asignaturas"]
        );
        assert!(uni_keys(&json!({})).is_empty());
    }
}
