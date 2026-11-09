// sesiones/catalogo_viva.rs — Lista viva de comandos por sesión (evento
// `commands` del puente v2), fusión con los metadatos estáticos y resolución
// de `/x args` (contrato de estabilidad, §2.2-§2.3).
//
// Propiedad: WP-ESTADO.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use super::meta;
use super::{def, NOTA_NO_CATALOGADO};
use crate::sesiones::types::{CommandDef, CommandInfoLive, CommandKind};

/// Comando resuelto: clase efectiva con o sin argumentos.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resuelto {
    pub nombre: String,
    pub kind: CommandKind,
    pub immediate: bool,
    pub note: Option<String>,
}

fn vivas() -> &'static Mutex<HashMap<String, Vec<CommandDef>>> {
    static V: OnceLock<Mutex<HashMap<String, Vec<CommandDef>>>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Guarda la lista viva de la sesión y devuelve el catálogo fusionado.
pub fn guardar_viva(id: &str, items: &[CommandInfoLive]) -> Vec<CommandDef> {
    let defs = fusionar_viva(items);
    match vivas().lock() {
        Ok(mut m) => {
            m.insert(id.to_string(), defs.clone());
        }
        Err(_) => tracing::error!(sesion = id, "lista viva de comandos envenenada"),
    }
    defs
}

/// Catálogo vivo de la sesión, si el puente v2 lo envió.
pub fn lista_viva(id: &str) -> Option<Vec<CommandDef>> {
    vivas().lock().ok().and_then(|m| m.get(id).cloned())
}

pub fn olvidar_viva(id: &str) {
    if let Ok(mut m) = vivas().lock() {
        m.remove(id);
    }
}

/// Lista viva → `CommandDef` con los metadatos estáticos. Los integrados sin
/// metadatos se tratan como `menu` (nunca se pegan a ciegas); plugins,
/// skills, usuario y MCP, como `prompt`.
pub fn fusionar_viva(items: &[CommandInfoLive]) -> Vec<CommandDef> {
    items
        .iter()
        .filter(|i| !i.name.trim().is_empty())
        .map(|i| {
            let plugin = i.plugin.as_deref();
            let de_ultron = plugin.is_some_and(|p| p.starts_with("ultron-"));
            let source = match i.source.as_str() {
                "plugin" if de_ultron => "mod",
                otro => otro,
            };
            let name = i.name.trim().trim_start_matches('/');
            let mut d = def(name, &i.description, None, source, plugin);
            let sin_meta = source != "builtin" && meta::de_mod(name).is_none();
            if sin_meta {
                d.immediate = i.immediate.unwrap_or(false);
            }
            d
        })
        .collect()
}

/// Resuelve `/nombre args` contra el catálogo (§2.2). Con lista viva, un
/// desconocido es un error con sugerencias; sin ella, se trata como `prompt`
/// con la nota de «no catalogado».
pub fn resolver(
    nombre: &str,
    args: &str,
    catalogo: &[CommandDef],
    viva: bool,
) -> Result<Resuelto, String> {
    let n = nombre.trim().trim_start_matches('/');
    if n.is_empty() {
        return Err("Falta el nombre del comando".to_string());
    }
    let encontrado = catalogo
        .iter()
        .find(|d| d.name == n || d.aliases.iter().any(|a| a == n));
    if let Some(d) = encontrado {
        let m = match d.source.as_str() {
            "builtin" => meta::builtin(n),
            "mod" => meta::de_mod(n),
            _ => None,
        };
        return Ok(Resuelto {
            nombre: d.name.clone(),
            kind: m.map_or(d.kind, |m| m.kind_para(args)),
            immediate: d.immediate,
            note: d.note.clone(),
        });
    }
    if viva {
        return Err(desconocido(n, catalogo));
    }
    Ok(match meta::builtin(n).or_else(|| meta::de_mod(n)) {
        Some(m) => Resuelto {
            nombre: m.nombre.to_string(),
            kind: m.kind_para(args),
            immediate: m.immediate,
            note: m.nota.map(str::to_string),
        },
        None => Resuelto {
            nombre: n.to_string(),
            kind: CommandKind::Prompt,
            immediate: false,
            note: Some(NOTA_NO_CATALOGADO.to_string()),
        },
    })
}

fn desconocido(n: &str, catalogo: &[CommandDef]) -> String {
    let raiz: String = n.chars().take(3).collect();
    let sugerencias: Vec<String> = catalogo
        .iter()
        .filter(|d| d.name.contains(n) || (!raiz.is_empty() && d.name.starts_with(&raiz)))
        .take(3)
        .map(|d| format!("/{}", d.name))
        .collect();
    if sugerencias.is_empty() {
        format!("Comando desconocido: /{n}")
    } else {
        format!(
            "Comando desconocido: /{n}. ¿Querías decir {}?",
            sugerencias.join(", ")
        )
    }
}
