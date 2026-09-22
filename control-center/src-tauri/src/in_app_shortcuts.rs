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
// LIB_RS_WIRING: `mod in_app_shortcuts;` esta en lib.rs y los dos comandos
// (`get_in_app_shortcuts` / `set_in_app_shortcuts`) estan registrados en
// handlers.rs. No hay nada que tocar en `setup()`: el teclado lo escucha el
// frontend.
//
// GUARDAR (2026-09-22). Hasta hoy solo se leia: el editor de atajos no existia
// y cambiarlos era editar el JSON a mano. `set_in_app_shortcuts` valida ANTES
// de escribir, porque los dos errores que se cometen aqui son silenciosos:
//   * un combo que App.tsx no sabe casar (`matchCombo` devuelve false y la
//     tecla no hace nada, sin decir nada);
//   * dos acciones con el mismo combo (gana la que mire antes el bucle, y la
//     otra deja de existir sin aviso).
// Por eso se rechazan con un mensaje que NOMBRA las dos acciones, en vez de
// guardarlos y dejar que el usuario descubra el agujero pulsando.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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
        // Volver al ultimo punto de control (2026-09-22). Va con el resto de
        // acciones del chat porque es MariaChat quien la publica: fuera del
        // chat no hay conversacion de la que volver. Alt+Z por parecido con el
        // deshacer de toda la vida, y con modificador para poder pulsarlo con
        // el cursor dentro de la caja de escribir.
        ("chat.deshacer", "Alt+Z"),
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
    match shortcuts_path() {
        Ok(p) => Ok(leer_en(&p)),
        Err(_) => Ok(default_bindings()),
    }
}

/// El mapa efectivo (por defecto + fichero) leyendo una ruta concreta.
///
/// Se separa de `get_in_app_shortcuts` para que las pruebas trabajen sobre un
/// tempdir y no sobre la carpeta de verdad del usuario.
fn leer_en(path: &Path) -> HashMap<String, String> {
    let mut out = default_bindings();
    let Ok(raw) = fs::read_to_string(path) else {
        return out;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return out;
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
    out
}

// ---------------------------------------------------------------------------
// Guardar: validar ANTES de escribir
// ---------------------------------------------------------------------------

/// Modificadores en el orden en que se escriben. Fijo a proposito: ver
/// `normaliza_combo`.
const ORDEN: [&str; 4] = ["Ctrl", "Alt", "Shift", "Meta"];

/// Posicion de un modificador en `ORDEN`, con los alias que acepta App.tsx.
fn indice_modificador(parte: &str) -> Option<usize> {
    match parte {
        "ctrl" | "control" => Some(0),
        "alt" | "option" => Some(1),
        "shift" => Some(2),
        "meta" | "super" | "win" | "cmd" => Some(3),
        _ => None,
    }
}

/// La tecla final, canonizada. `None` si no es una de las admitidas: una sola
/// letra o simbolo, `Escape`, o de `F1` a `F12`.
fn tecla_final(t: &str) -> Option<String> {
    if t == "escape" {
        return Some("Escape".into());
    }
    if let Some(n) = t.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
        if (1..=12).contains(&n) {
            return Some(format!("F{n}"));
        }
        return None;
    }
    let mut cs = t.chars();
    match (cs.next(), cs.next()) {
        (Some(c), None) => Some(c.to_uppercase().to_string()),
        _ => None,
    }
}

/// Normaliza un combo a la forma canonica (`ctrl + alt+k` -> `Ctrl+Alt+K`).
/// Pura: se prueba sin disco.
///
/// Se canoniza el ORDEN por una razon concreta: `matchCombo` (App.tsx) no lo
/// mira, asi que «Alt+Ctrl+K» y «Ctrl+Alt+K» son el mismo atajo. Sin
/// normalizar, la busqueda de duplicados dejaria pasar justo el caso que deja
/// una accion sin teclado.
pub fn normaliza_combo(raw: &str) -> Result<String, String> {
    let bruto = raw.trim();
    let mut puestos = [false; 4];
    let mut tecla: Option<String> = None;
    for p in bruto
        .split('+')
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
    {
        if let Some(i) = indice_modificador(&p) {
            puestos[i] = true;
            continue;
        }
        if tecla.is_some() {
            return Err(format!(
                "«{bruto}» lleva dos teclas; un atajo es cero o mas modificadores y UNA tecla"
            ));
        }
        tecla = Some(p);
    }
    let Some(t) = tecla else {
        return Err(if bruto.is_empty() {
            "el atajo esta vacio".to_string()
        } else {
            format!("«{bruto}» son solo modificadores: falta la tecla")
        });
    };
    let t = tecla_final(&t).ok_or_else(|| {
        format!(
            "«{t}» no es una tecla que la aplicacion sepa escuchar: una letra o un simbolo \
             sueltos, Escape, o de F1 a F12"
        )
    })?;
    let mut fuera = String::new();
    for (i, m) in ORDEN.iter().enumerate() {
        if puestos[i] {
            fuera.push_str(m);
            fuera.push('+');
        }
    }
    fuera.push_str(&t);
    Ok(fuera)
}

/// Valida lo que manda la interfaz y devuelve el mapa EFECTIVO. Pura.
///
/// Reglas, todas por el mismo motivo —que un atajo guardado hace algo o se
/// niega, pero no se queda mudo—:
///   * accion que no existe: se rechaza, no se guarda un cajon desastre que
///     nadie leera nunca;
///   * combo que App.tsx no sabe casar: se rechaza con el porque;
///   * cadena vacia: vuelve al valor por defecto de ESA accion (es como se
///     borra un atajo personalizado);
///   * dos acciones con el mismo combo: se rechaza NOMBRANDO las dos, porque
///     el bucle de App.tsx se queda con la primera y la otra desaparece.
///
/// Las acciones se recorren ordenadas para que el mensaje de error sea el
/// mismo se mande el mapa como se mande: un `HashMap` no tiene orden.
pub fn validar(bindings: &HashMap<String, String>) -> Result<HashMap<String, String>, String> {
    let defectos = default_bindings();
    let mut efectivo = defectos.clone();
    let mut acciones: Vec<&String> = bindings.keys().collect();
    acciones.sort();
    for accion in acciones {
        if !defectos.contains_key(accion) {
            return Err(format!(
                "no conozco la accion «{accion}», asi que un atajo suyo no lo pulsaria nadie"
            ));
        }
        let combo = &bindings[accion];
        if combo.trim().is_empty() {
            continue; // `efectivo` ya trae el valor por defecto
        }
        let c = normaliza_combo(combo).map_err(|e| format!("{accion}: {e}"))?;
        efectivo.insert(accion.clone(), c);
    }
    let mut vistas: HashMap<String, String> = HashMap::new();
    let mut todas: Vec<&String> = efectivo.keys().collect();
    todas.sort();
    for accion in todas {
        let combo = &efectivo[accion];
        if let Some(otra) = vistas.insert(combo.to_lowercase(), accion.clone()) {
            return Err(format!(
                "«{combo}» esta en dos acciones a la vez: {otra} y {accion}"
            ));
        }
    }
    Ok(efectivo)
}

/// Guarda los atajos y devuelve el mapa efectivo (por defecto + fichero), que
/// es lo que la interfaz tiene que pintar sin volver a preguntar.
#[tauri::command]
pub fn set_in_app_shortcuts(
    bindings: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    guardar_en(&shortcuts_path()?, bindings)
}

/// Igual, contra una ruta concreta (las pruebas no escriben en la carpeta del
/// usuario).
fn guardar_en(
    path: &Path,
    bindings: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let efectivo = validar(&bindings)?;
    let defectos = default_bindings();
    // Al fichero solo va lo que se APARTA del valor por defecto. Si se
    // escribiera el mapa entero, cambiar un atajo de casa dejaria de llegar al
    // usuario en cuanto hubiera guardado una vez. `BTreeMap` para que el
    // fichero salga siempre en el mismo orden y un `git diff` sea legible.
    let fichero: std::collections::BTreeMap<&str, &str> = efectivo
        .iter()
        .filter(|(k, v)| defectos.get(k.as_str()).map(String::as_str) != Some(v.as_str()))
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let texto =
        serde_json::to_string_pretty(&fichero).map_err(|e| format!("serializar atajos: {e}"))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("crear {}: {e}", dir.display()))?;
    }
    // Escritura atomica: un corte a mitad dejaria un JSON roto y `leer_en` lo
    // trata como «sin personalizar», o sea, perderlos todos sin decir nada.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, texto).map_err(|e| format!("escribir atajos: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("guardar atajos: {e}"))?;
    Ok(efectivo)
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

    /// Un mapa de cambios, que es lo que manda la interfaz.
    fn cambios(pares: &[(&str, &str)]) -> HashMap<String, String> {
        pares
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn un_combo_se_guarda_en_forma_canonica() {
        // El orden de los modificadores no cambia lo que hace App.tsx, asi que
        // se fija aqui: es lo unico que permite comparar dos atajos.
        assert_eq!(
            normaliza_combo(" alt + ctrl+k ").expect("valido"),
            "Ctrl+Alt+K"
        );
        assert_eq!(normaliza_combo("CONTROL+,").expect("valido"), "Ctrl+,");
        assert_eq!(normaliza_combo("escape").expect("valido"), "Escape");
        assert_eq!(normaliza_combo("shift+f12").expect("valido"), "Shift+F12");
        assert_eq!(normaliza_combo("cmd+1").expect("valido"), "Meta+1");
        // Sin modificadores tambien vale: es una tecla suelta.
        assert_eq!(normaliza_combo("q").expect("valido"), "Q");
    }

    #[test]
    fn un_combo_que_la_app_no_sabe_casar_no_se_guarda() {
        // Caso negativo: guardarlo dejaria una accion muda para siempre, que es
        // el fallo que esta validacion existe para evitar.
        for malo in [
            "",
            "   ",
            "Ctrl+",
            "Ctrl+Alt",
            "Ctrl+Intro",
            "Ctrl+a+b",
            "F13",
        ] {
            assert!(
                normaliza_combo(malo).is_err(),
                "«{malo}» no podia pasar la validacion"
            );
        }
        let e = normaliza_combo("Ctrl+Intro").expect_err("Intro no es una tecla de estas");
        assert!(
            e.contains("Escape") && e.contains("F12"),
            "el error dice que SI vale: {e}"
        );
    }

    #[test]
    fn dos_acciones_con_el_mismo_atajo_se_rechazan_nombrando_las_dos() {
        // Es el fallo silencioso del bucle de App.tsx: gana la primera que
        // mira y la otra deja de existir. El mensaje tiene que nombrar las dos
        // o el usuario no sabe cual quitar.
        let e = validar(&cambios(&[("tab.usage", "Alt+1")])).expect_err("choca con tab.dashboard");
        assert!(e.contains("tab.usage"), "{e}");
        assert!(e.contains("tab.dashboard"), "{e}");
        assert!(e.contains("Alt+1"), "{e}");
        // Y tambien si los dos vienen en el mismo envio, escritos distinto.
        let e = validar(&cambios(&[
            ("chat.nueva", "Ctrl+Alt+J"),
            ("chat.regenerar", "alt+ctrl+j"),
        ]))
        .expect_err("es el mismo atajo escrito al reves");
        assert!(
            e.contains("chat.nueva") && e.contains("chat.regenerar"),
            "{e}"
        );
    }

    #[test]
    fn una_accion_desconocida_no_se_guarda() {
        // Caso negativo: nadie escucha «tab.inventada», asi que aceptarla seria
        // prometer un atajo que no existe.
        let e = validar(&cambios(&[("tab.inventada", "Alt+9")])).expect_err("no existe");
        assert!(e.contains("tab.inventada"), "{e}");
    }

    #[test]
    fn la_cadena_vacia_devuelve_la_accion_a_su_valor_por_defecto() {
        let mapa = validar(&cambios(&[("chat.nueva", "  ")])).expect("vacio = por defecto");
        assert_eq!(mapa["chat.nueva"], default_bindings()["chat.nueva"]);
    }

    #[test]
    fn lo_guardado_se_relee_igual_y_solo_ocupa_lo_que_cambia() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("in-app-shortcuts.json");

        let efectivo = guardar_en(&path, cambios(&[("chat.deshacer", "ctrl+shift+z")]))
            .expect("un combo valido se guarda");
        assert_eq!(efectivo["chat.deshacer"], "Ctrl+Shift+Z");
        // Releer por la misma via que la interfaz tiene que dar lo mismo.
        assert_eq!(leer_en(&path), efectivo);
        // En el fichero solo lo que se aparta de casa: si se guardara el mapa
        // entero, cambiar un atajo por defecto dejaria de llegar al usuario.
        let crudo: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("leer")).expect("json");
        assert_eq!(crudo.as_object().expect("objeto").len(), 1, "{crudo}");
        assert_eq!(crudo["chat.deshacer"], "Ctrl+Shift+Z");

        // Y volver al valor por defecto vacia el fichero, no lo deja a medias.
        guardar_en(&path, cambios(&[("chat.deshacer", "")])).expect("vuelta al defecto");
        let crudo: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("leer")).expect("json");
        assert_eq!(crudo.as_object().expect("objeto").len(), 0, "{crudo}");
        assert_eq!(leer_en(&path)["chat.deshacer"], "Alt+Z");

        // Caso negativo: un envio invalido no toca lo que habia.
        let antes = fs::read_to_string(&path).expect("leer");
        assert!(guardar_en(&path, cambios(&[("chat.nueva", "Ctrl+")])).is_err());
        assert_eq!(fs::read_to_string(&path).expect("leer"), antes);
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
