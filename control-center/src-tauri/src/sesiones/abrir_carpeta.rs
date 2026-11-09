// sesiones/abrir_carpeta.rs — Argumentos de lanzamiento de ULTRON Sessions.
//
// `--sesiones` abre solo la ventana de Sessions (acceso directo del
// escritorio). `--sesiones-cwd <ruta>` (o `--sesiones-cwd=<ruta>`) abre
// además una sesión nueva de Claude con esa carpeta como directorio de
// trabajo: es la entrada «ULTRON Sessions aquí» del menú contextual del
// Explorador. Vale en arranque en frío (`std::env::args`) y con la app ya
// abierta (`argv` del callback de single-instance).
//
// La ruta se valida aquí (absoluta, sin `..`, carpeta existente) y otra vez
// en `gestor::create` al crear la sesión. El frontend la recibe por
// `?cwd=<ruta>` si la ventana se crea en ese momento o por el evento
// `sesiones://new-in-cwd` si ya estaba abierta. Si la carpeta coincide con la
// ruta de un proyecto de `cockpit/projects.json`, `gestor::resolver_cwd` la
// asocia a ese proyecto.

use std::path::{Component, Path};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use super::ventana;

/// Argumento de la entrada «ULTRON Sessions aquí» del menú contextual.
pub const CWD_ARG: &str = "--sesiones-cwd";

/// Lo que pide la línea de comandos respecto a Sessions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Peticion {
    /// Solo la ventana (`--sesiones`).
    Ventana,
    /// Ventana y sesión nueva en la ruta dada, aún sin validar.
    Carpeta(String),
    /// `--sesiones-cwd` sin ruta.
    SinRuta,
}

/// Petición de Sessions en `args` (argv completo, con o sin el ejecutable).
/// `None` si la línea de comandos no menciona Sessions. `--sesiones-cwd`
/// manda sobre `--sesiones`.
pub fn peticion_de(args: &[String]) -> Option<Peticion> {
    let prefijo = format!("{CWD_ARG}=");
    for (i, a) in args.iter().enumerate() {
        if let Some(ruta) = a.strip_prefix(&prefijo) {
            return Some(carpeta_o_error(Some(ruta)));
        }
        if a == CWD_ARG {
            return Some(carpeta_o_error(args.get(i + 1).map(String::as_str)));
        }
    }
    args.iter()
        .any(|a| a == ventana::LAUNCH_ARG)
        .then_some(Peticion::Ventana)
}

fn carpeta_o_error(ruta: Option<&str>) -> Peticion {
    match ruta.map(str::trim) {
        Some(r) if !r.is_empty() && !r.starts_with("--") => Peticion::Carpeta(r.to_string()),
        _ => Peticion::SinRuta,
    }
}

/// Ruta canónica de la carpeta pedida o el motivo del rechazo.
///
/// Una comilla final se vuelve barra: en Windows `"C:\"` (una unidad desde el
/// menú contextual) llega como `C:"`, porque la barra escapa la comilla de
/// cierre al partir la línea de comandos.
pub fn validar_carpeta(raw: &str) -> Result<String, String> {
    let t = raw.trim().trim_start_matches('"');
    let limpia = match t.strip_suffix('"') {
        Some(sin) => format!("{}\\", sin.trim_end_matches('"')),
        None => t.to_string(),
    };
    let limpia = limpia.as_str();
    if limpia.is_empty() {
        return Err("la ruta está vacía".into());
    }
    // La línea de órdenes la puede componer cualquier proceso o acceso directo:
    // un UNC no llega a `is_dir` (conexión SMB con el hash NTLM del usuario).
    if super::archivos::es_ruta_de_red(limpia) {
        return Err(super::archivos::ERROR_RUTA_DE_RED.to_string());
    }
    let p = Path::new(limpia);
    if !p.is_absolute() {
        return Err(format!("la ruta no es absoluta: '{limpia}'"));
    }
    if p.components().any(|c| c == Component::ParentDir) {
        return Err(format!("la ruta no puede contener '..': '{limpia}'"));
    }
    if !p.is_dir() {
        return Err(format!("no existe la carpeta: '{limpia}'"));
    }
    let c = std::fs::canonicalize(p).map_err(|e| format!("no se pudo resolver '{limpia}': {e}"))?;
    Ok(sin_prefijo_verbatim(&c.to_string_lossy()))
}

/// `\\?\C:\x` → `C:\x` y `\\?\UNC\srv\share` → `\\srv\share`.
fn sin_prefijo_verbatim(p: &str) -> String {
    if let Some(unc) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

/// Codifica `s` para un parámetro de URL (todo salvo los no reservados).
pub fn codificar_url(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Atiende la petición de Sessions de `args`, si la hay. Devuelve si la
/// línea de comandos pedía Sessions (el llamante decide entonces qué hacer
/// con la ventana principal). Una ruta no válida abre igualmente Sessions,
/// lo anota en el log y lo explica en un diálogo.
pub fn atender(app: &AppHandle, args: &[String]) -> bool {
    let Some(peticion) = peticion_de(args) else {
        return false;
    };
    let resultado = match peticion {
        Peticion::Ventana => ventana::open(app, None),
        Peticion::SinRuta => {
            avisar(app, format!("{CWD_ARG} necesita una ruta de carpeta."));
            ventana::open(app, None)
        }
        Peticion::Carpeta(raw) => match validar_carpeta(&raw) {
            Ok(cwd) => ventana::open_in_cwd(app, &cwd),
            Err(e) => {
                avisar(
                    app,
                    format!("No se puede abrir una sesión en esa carpeta: {e}."),
                );
                ventana::open(app, None)
            }
        },
    };
    if let Err(e) = resultado {
        tracing::warn!(error = %e, "no se pudo abrir ULTRON Sessions");
    }
    true
}

fn avisar(app: &AppHandle, mensaje: String) {
    tracing::warn!(%mensaje, "argumento de ULTRON Sessions rechazado");
    app.dialog()
        .message(mensaje)
        .title("ULTRON Sessions")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

#[cfg(test)]
#[path = "tests_abrir_carpeta.rs"]
mod tests;
