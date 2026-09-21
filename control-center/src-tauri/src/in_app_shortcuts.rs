// ULTRON Control Center — In-app keyboard shortcuts (window-scoped)
//
// These are NOT global OS hotkeys. They're matched inside the React
// shell (see `src/App.tsx` keydown listener) and only fire while the
// Control Center window has focus. The Rust side is just the storage
// layer: load + persist `key -> combo` map at
// `~/.ultron/.tmp/in-app-shortcuts.json`.
//
// `key` is a logical action name (e.g. "tab.dashboard", "command.palette").
// `combo` is a human-readable accelerator like "Alt+1", "Ctrl+K".
// Combo parsing/matching lives in TypeScript because we already detect
// keydown events there — the Rust process never sees these key presses.
//
// LIB_RS_WIRING:
// 1. Add `mod in_app_shortcuts;` to the module list at the top of lib.rs.
// 2. Append these two commands to the `tauri::generate_handler![...]` macro
//    (no extra wrapper functions needed — they're #[tauri::command]
//    already on the module functions):
//
//        in_app_shortcuts::get_in_app_shortcuts,
//        in_app_shortcuts::set_in_app_shortcuts,
//
// 3. No setup() changes — these shortcuts are handled by the frontend.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

fn shortcuts_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME dir".to_string())?;
    Ok(home.join(".ultron/.tmp/in-app-shortcuts.json"))
}

/// Default bindings — match what `src/App.tsx` hardcoded historically.
/// Returned when the file doesn't exist yet OR a key is missing. The
/// frontend merges these on top of whatever it gets back, so adding a
/// new default here automatically surfaces in the editor.
fn default_bindings() -> HashMap<String, String> {
    let pairs: &[(&str, &str)] = &[
        ("command.palette", "Ctrl+K"),
        ("open.settings", "Ctrl+,"),
        ("refresh.all", "Ctrl+R"),
        ("tab.dashboard", "Alt+1"),
        ("tab.usage", "Alt+2"),
        ("tab.notifications", "Alt+3"),
        ("tab.sessions", "Alt+4"),
        ("tab.projects", "Alt+5"),
        ("tab.plans", "Alt+6"),
        ("tab.memory", "Alt+7"),
        ("tab.skills", "Alt+8"),
        ("tab.settings", "Alt+0"),
        // -- Chat (2026-09-22) --
        //
        // Los saltos de pestaña de arriba App.tsx los suprime mientras se
        // escribe, que en el chat es el 100 % del tiempo. Estos NO: van con
        // modificador (o son Escape), asi que se pueden usar con el cursor
        // dentro de la caja sin comerse una tecla. Ver `chatAcciones.ts`,
        // `seDisparaEscribiendo`.
        //
        // Solo hacen algo con la pestaña Chat montada: es `MariaChat` quien
        // publica las acciones, y al desmontarse las retira.
        ("chat.nueva", "Alt+N"),
        ("chat.parar", "Escape"),
        ("chat.regenerar", "Alt+G"),
        ("chat.exportar", "Alt+E"),
        ("chat.panel.cambios", "Alt+C"),
        ("chat.panel.ficheros", "Alt+F"),
        ("chat.panel.web", "Alt+W"),
    ];
    pairs
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect()
}

/// Read the on-disk map and merge over defaults. Missing file or
/// malformed JSON is treated as "no overrides" — we never error on read
/// because the UI should always render with sensible defaults.
#[tauri::command]
pub fn get_in_app_shortcuts() -> Result<HashMap<String, String>, String> {
    let mut out = default_bindings();
    let path = match shortcuts_path() {
        Ok(p) => p,
        Err(_) => return Ok(out),
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ok(out);
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Ok(out);
    };
    if let Some(map) = parsed.as_object() {
        for (k, v) in map {
            if let Some(combo) = v.as_str() {
                let trimmed = combo.trim();
                if !trimmed.is_empty() {
                    out.insert(k.clone(), trimmed.to_string());
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ninguna_combinacion_por_defecto_se_repite() {
        // Dos acciones con la misma tecla = una de las dos no se ejecuta nunca,
        // y el bucle de App.tsx se queda con la primera sin decir nada. Anadir
        // un atajo nuevo sin mirar los que hay es exactamente como pasa.
        let b = default_bindings();
        let mut vistas: HashMap<String, String> = HashMap::new();
        for (accion, combo) in &b {
            let clave = combo.to_lowercase();
            if let Some(otra) = vistas.insert(clave, accion.clone()) {
                panic!("«{combo}» esta en {accion} y en {otra}");
            }
        }
    }

    #[test]
    fn las_acciones_del_chat_no_se_comen_el_teclado_al_escribir() {
        // Caso negativo del chat: un atajo sin modificador (y que no sea
        // Escape) robaria la letra con el cursor en la caja de escribir. La
        // regla vive en `chatAcciones.ts::seDisparaEscribiendo`; aqui se
        // comprueba que los valores por defecto la cumplen.
        let b = default_bindings();
        for (accion, combo) in b.iter().filter(|(k, _)| k.starts_with("chat.")) {
            let c = combo.to_lowercase();
            assert!(
                c.starts_with("alt+")
                    || c.starts_with("ctrl+")
                    || c.starts_with("meta+")
                    || c == "escape",
                "{accion} = «{combo}» se comeria una tecla al escribir"
            );
        }
    }

    #[test]
    fn un_fichero_ilegible_no_deja_la_app_sin_atajos() {
        // `get_in_app_shortcuts` nunca falla: sin fichero devuelve los valores
        // por defecto, que es lo que hace que la app siempre tenga teclado.
        let map = get_in_app_shortcuts().expect("nunca devuelve Err");
        assert!(map.contains_key("command.palette"));
        assert!(map.contains_key("chat.parar"));
    }
}
