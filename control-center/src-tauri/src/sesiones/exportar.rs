// sesiones/exportar.rs — Exporta la conversación completa de una sesión a
// Markdown o a HTML autocontenido (`sesiones_export`).
//
// Se lee el transcript entero (no las páginas de la vista) y se reduce a una
// lista de `Entrada`: lo que dijo la persona, lo que respondió el asistente y
// una línea por herramienta (nombre + objetivo, sin su resultado). Los dos
// formatos se generan a partir de esa lista.
//
// El destino lo elige el usuario en el diálogo «Guardar como», que se abre
// desde Rust: la ruta nunca llega de la webview, así que un script de la
// ventana no puede pedir escribir en otro sitio. Aun así se valida (absoluta,
// sin `..`, extensión del formato y carpeta existente). Abrir el fichero
// después solo se permite con las rutas exportadas en este proceso.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use super::exportar_html;
use super::registro;
use super::transcript;
use super::types::{Block, ChatMessage, MessageKind, SessionInfo};

/// Formato de salida (`"md"` | `"html"` en el cable).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Formato {
    Md,
    Html,
}

impl Formato {
    pub fn extension(self) -> &'static str {
        match self {
            Formato::Md => "md",
            Formato::Html => "html",
        }
    }

    fn filtro(self) -> &'static str {
        match self {
            Formato::Md => "Markdown",
            Formato::Html => "HTML",
        }
    }
}

/// Datos de la cabecera del documento.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cabecera {
    pub titulo: String,
    pub proyecto: String,
    pub cwd: String,
    pub modelo: Option<String>,
    /// Inicio de la sesión (RFC 3339), si se conoce.
    pub inicio: Option<String>,
    /// Momento de la exportación, ya formateado.
    pub exportado: String,
}

/// Quién habla en un bloque de la conversación.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hablante {
    Usuario,
    Asistente,
}

/// Unidad de la conversación exportada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entrada {
    Texto {
        hablante: Hablante,
        hora: String,
        texto: String,
    },
    Herramienta {
        nombre: String,
        objetivo: String,
    },
    Comando {
        hora: String,
        linea: String,
    },
    Nota {
        texto: String,
    },
}

/// Resultado de una exportación (camelCase en el cable).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Exportado {
    pub path: String,
    pub messages: usize,
    pub bytes: usize,
}

/// Fecha y hora local legibles de un RFC 3339; el texto tal cual si no lo es.
pub fn hora_legible(ts: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|d| {
            d.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_else(|_| ts.to_string())
}

fn texto_de(blocks: &[Block]) -> String {
    let partes: Vec<String> = blocks
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } => Some(text.trim().to_string()),
            Block::Image { path, .. } => Some(match path {
                Some(p) => format!("[imagen: {p}]"),
                None => "[imagen]".to_string(),
            }),
            _ => None,
        })
        .filter(|t| !t.is_empty())
        .collect();
    partes.join("\n\n")
}

fn entradas_de_asistente(m: &ChatMessage, hora: &str) -> Vec<Entrada> {
    m.blocks
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } if !text.trim().is_empty() => Some(Entrada::Texto {
                hablante: Hablante::Asistente,
                hora: hora.to_string(),
                texto: text.trim().to_string(),
            }),
            Block::ToolUse { name, summary, .. } => Some(Entrada::Herramienta {
                nombre: name.clone(),
                objetivo: summary.replace(['\r', '\n'], " "),
            }),
            _ => None,
        })
        .collect()
}

fn entradas_de_usuario(m: &ChatMessage, hora: String) -> Vec<Entrada> {
    match m.kind {
        MessageKind::Command => {
            let linea = m
                .command
                .as_ref()
                .map(|c| format!("/{} {}", c.name, c.args).trim_end().to_string())
                .unwrap_or_else(|| texto_de(&m.blocks));
            vec![Entrada::Comando { hora, linea }]
        }
        MessageKind::Interrupted => vec![Entrada::Nota {
            texto: "Turno interrumpido por el usuario.".to_string(),
        }],
        MessageKind::CompactSummary => vec![Entrada::Nota {
            texto: "Contexto compactado: aquí empieza el resumen de la conversación anterior."
                .to_string(),
        }],
        MessageKind::Prompt | MessageKind::Bash => {
            let texto = texto_de(&m.blocks);
            if texto.is_empty() {
                return Vec::new();
            }
            vec![Entrada::Texto {
                hablante: Hablante::Usuario,
                hora,
                texto,
            }]
        }
        // Resultados de herramienta, metadatos y avisos de tareas: fuera.
        _ => Vec::new(),
    }
}

/// Reduce los mensajes del transcript a la conversación exportable.
pub fn entradas(msgs: &[ChatMessage]) -> Vec<Entrada> {
    msgs.iter()
        .filter(|m| m.agent_id.is_none())
        .flat_map(|m| {
            let hora = hora_legible(&m.timestamp);
            if m.role == "assistant" {
                entradas_de_asistente(m, &hora)
            } else {
                entradas_de_usuario(m, hora)
            }
        })
        .collect()
}

/// Código en línea de Markdown que aguanta comillas invertidas dentro.
fn codigo_md(s: &str) -> String {
    let mut maximo = 0;
    let mut actual = 0;
    for c in s.chars() {
        actual = if c == '`' { actual + 1 } else { 0 };
        maximo = maximo.max(actual);
    }
    let valla = "`".repeat(maximo + 1);
    let relleno = if s.starts_with('`') || s.ends_with('`') {
        " "
    } else {
        ""
    };
    format!("{valla}{relleno}{s}{relleno}{valla}")
}

pub fn nombre_hablante(h: Hablante) -> &'static str {
    match h {
        Hablante::Usuario => "Usuario",
        Hablante::Asistente => "Claude",
    }
}

fn cabecera_md(c: &Cabecera) -> String {
    let mut s = format!("# {}\n\n", c.titulo.trim());
    s.push_str(&format!("- **Proyecto:** {}\n", c.proyecto));
    s.push_str(&format!("- **Directorio:** {}\n", codigo_md(&c.cwd)));
    if let Some(m) = &c.modelo {
        s.push_str(&format!("- **Modelo:** {}\n", codigo_md(m)));
    }
    if let Some(i) = &c.inicio {
        s.push_str(&format!("- **Inicio:** {}\n", hora_legible(i)));
    }
    s.push_str(&format!("- **Exportado:** {}\n\n---\n", c.exportado));
    s
}

/// Documento Markdown. El texto de los mensajes va tal cual (ya es Markdown).
pub fn markdown(c: &Cabecera, entradas: &[Entrada]) -> String {
    let mut s = cabecera_md(c);
    let mut ultimo: Option<Hablante> = None;
    for e in entradas {
        match e {
            Entrada::Texto {
                hablante,
                hora,
                texto,
            } => {
                if ultimo != Some(*hablante) {
                    s.push_str(&format!("\n## {} · {hora}\n", nombre_hablante(*hablante)));
                }
                s.push_str(&format!("\n{texto}\n"));
                ultimo = Some(*hablante);
            }
            Entrada::Herramienta { nombre, objetivo } => {
                if ultimo != Some(Hablante::Asistente) {
                    s.push_str("\n## Claude\n");
                    ultimo = Some(Hablante::Asistente);
                }
                let objetivo = if objetivo.is_empty() {
                    String::new()
                } else {
                    format!(": {}", codigo_md(objetivo))
                };
                s.push_str(&format!("\n> Herramienta **{nombre}**{objetivo}\n"));
            }
            Entrada::Comando { hora, linea } => {
                s.push_str(&format!("\n## Comando · {hora}\n\n{}\n", codigo_md(linea)));
                ultimo = None;
            }
            Entrada::Nota { texto } => {
                s.push_str(&format!("\n_{texto}_\n"));
                ultimo = None;
            }
        }
    }
    s
}

/// Nombre por defecto: `<proyecto>-<fecha>.<ext>`, sin caracteres raros.
pub fn nombre_por_defecto(proyecto: &str, fecha: &str, formato: Formato) -> String {
    let limpio: String = proyecto
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let limpio = limpio.trim_matches('-');
    let base = if limpio.is_empty() {
        "conversacion"
    } else {
        limpio
    };
    format!("{base}-{fecha}.{}", formato.extension())
}

/// Valida el destino elegido: absoluto, sin `..`, con la extensión del
/// formato, que no sea una carpeta y cuya carpeta exista.
pub fn validar_destino(path: &Path, formato: Formato) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("ruta de destino no absoluta: {}", path.display()));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("ruta de destino no permitida: contiene '..'".to_string());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if ext.as_deref() != Some(formato.extension()) {
        return Err(format!(
            "el destino debe terminar en .{}: {}",
            formato.extension(),
            path.display()
        ));
    }
    if path.is_dir() {
        return Err(format!("el destino es una carpeta: {}", path.display()));
    }
    match path.parent() {
        Some(dir) if dir.is_dir() => Ok(path.to_path_buf()),
        _ => Err(format!(
            "no existe la carpeta de destino: {}",
            path.display()
        )),
    }
}

/// Documento completo en el formato pedido.
pub fn generar(c: &Cabecera, msgs: &[ChatMessage], formato: Formato) -> String {
    let e = entradas(msgs);
    match formato {
        Formato::Md => markdown(c, &e),
        Formato::Html => exportar_html::html(c, &e),
    }
}

fn exportados() -> &'static Mutex<HashSet<PathBuf>> {
    static SET: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Cabecera de la sesión (el modelo, del último mensaje si la sesión no lo
/// sabe).
fn cabecera_de(info: &SessionInfo, msgs: &[ChatMessage]) -> Cabecera {
    let modelo = info
        .model
        .clone()
        .or_else(|| msgs.iter().rev().find_map(|m| m.model.clone()));
    Cabecera {
        titulo: info.title.clone(),
        proyecto: info.project_name.clone(),
        cwd: info.cwd.clone(),
        modelo,
        inicio: Some(info.started_at.clone()).filter(|s| !s.is_empty()),
        exportado: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
    }
}

/// Pide el destino y escribe la conversación completa. `Ok(None)` si el
/// usuario cancela el diálogo. El transcript se parsea después del diálogo:
/// cancelar no paga la lectura de un fichero de cientos de MB.
pub fn exportar(app: &AppHandle, id: &str, formato: Formato) -> Result<Option<Exportado>, String> {
    let (transcript_path, info) = registro::read(id, |s| (s.transcript.clone(), s.info.clone()))?;
    let transcript_path = transcript_path
        .filter(|p| p.is_file())
        .ok_or_else(|| "la sesión todavía no tiene transcript que exportar".to_string())?;
    let fecha = chrono::Local::now().format("%Y-%m-%d").to_string();
    let Some(elegido) = app
        .dialog()
        .file()
        .set_title("Exportar conversación")
        .set_file_name(nombre_por_defecto(&info.project_name, &fecha, formato))
        .add_filter(formato.filtro(), &[formato.extension()])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = elegido
        .into_path()
        .map_err(|e| format!("ruta de destino no válida: {e}"))?;
    let path = validar_destino(&path, formato)?;
    let msgs = transcript::parse_fichero(&transcript_path, None)
        .map_err(|e| format!("no se pudo leer el transcript: {e}"))?;
    let doc = generar(&cabecera_de(&info, &msgs), &msgs, formato);
    std::fs::write(&path, doc.as_bytes())
        .map_err(|e| format!("no se pudo escribir {}: {e}", path.display()))?;
    if let Ok(mut set) = exportados().lock() {
        set.insert(path.clone());
    }
    Ok(Some(Exportado {
        path: path.to_string_lossy().into_owned(),
        messages: msgs.len(),
        bytes: doc.len(),
    }))
}

/// Abre (o muestra en su carpeta) un fichero exportado en este proceso.
pub fn abrir(app: &AppHandle, path: &str, mostrar: bool) -> Result<(), String> {
    let p = PathBuf::from(path);
    let conocido = exportados()
        .lock()
        .map(|set| set.contains(&p))
        .map_err(|_| "registro de exportaciones no disponible".to_string())?;
    if !conocido {
        return Err(format!(
            "{path} no es una exportación de esta sesión de la app"
        ));
    }
    if !p.is_file() {
        return Err(format!("ya no existe: {path}"));
    }
    if mostrar {
        return app
            .opener()
            .reveal_item_in_dir(&p)
            .map_err(|e| format!("no se pudo mostrar en la carpeta: {e}"));
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("no se pudo abrir la exportación: {e}"))
}

#[cfg(test)]
#[path = "tests_exportar.rs"]
mod tests;
