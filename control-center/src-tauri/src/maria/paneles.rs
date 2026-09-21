// mar.ia — lo que alimenta los paneles laterales del chat.
//
// El chat tiene a su derecha, como Claude Desktop, un panel con pestañas:
// artefacto, cambios, web y ficheros. Los cambios se sirven con los comandos
// de git que ya existian (`git_changes`, `git_diff_file`); aqui vive lo que
// faltaba:
//
//   * `maria_ficheros` — el contenido de una carpeta, para ver lo que los
//     agentes han dejado en la carpeta de trabajo o en el proyecto.
//   * `maria_fichero_leer` — un fichero de texto, acotado.
//   * `maria_web_ventana` — abrir una URL en una ventana propia de mar.ia. El
//     panel Web usa un `iframe`, y muchos sitios se niegan a pintarse dentro de
//     uno (`X-Frame-Options`); una ventana aparte no tiene esa limitacion.
//
// LIMITE DECLARADO: la ventana web es un navegador minimo (sin barra de
// direcciones ni pestañas) y NO tiene acceso a los comandos de la aplicacion:
// las capacidades de Tauri solo se conceden a la ventana `main`.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const MAX_ENTRADAS: usize = 800;
const MAX_BYTES_TEXTO: u64 = 512 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Entrada {
    pub nombre: String,
    pub ruta: String,
    pub carpeta: bool,
    pub bytes: u64,
}

/// Carpetas que solo hacen ruido en un listado de trabajo.
const RUIDO: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "__pycache__",
    "dist",
];

pub fn listar(dir: &Path) -> Result<Vec<Entrada>, String> {
    let lector =
        std::fs::read_dir(dir).map_err(|e| format!("no pude abrir {}: {e}", dir.display()))?;
    let mut out: Vec<Entrada> = lector
        .flatten()
        .filter_map(|e| {
            let nombre = e.file_name().to_string_lossy().into_owned();
            if RUIDO.contains(&nombre.as_str()) {
                return None;
            }
            let meta = e.metadata().ok()?;
            Some(Entrada {
                nombre,
                ruta: e.path().to_string_lossy().into_owned(),
                carpeta: meta.is_dir(),
                bytes: if meta.is_dir() { 0 } else { meta.len() },
            })
        })
        .take(MAX_ENTRADAS)
        .collect();
    // Carpetas primero, y dentro de cada grupo por nombre sin mirar mayusculas.
    out.sort_by(|a, b| {
        b.carpeta
            .cmp(&a.carpeta)
            .then_with(|| a.nombre.to_lowercase().cmp(&b.nombre.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub async fn maria_ficheros(ruta: String) -> Result<Vec<Entrada>, String> {
    tauri::async_runtime::spawn_blocking(move || listar(Path::new(&ruta)))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

pub fn leer(ruta: &Path) -> Result<String, String> {
    let meta =
        std::fs::metadata(ruta).map_err(|e| format!("no pude abrir {}: {e}", ruta.display()))?;
    if meta.len() > MAX_BYTES_TEXTO {
        return Err(format!(
            "{} pesa {} KB; el panel enseña hasta {} KB. Ábrelo con tu editor.",
            ruta.display(),
            meta.len() / 1024,
            MAX_BYTES_TEXTO / 1024
        ));
    }
    std::fs::read_to_string(ruta).map_err(|_| "no es un fichero de texto".to_string())
}

#[tauri::command]
pub async fn maria_fichero_leer(ruta: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || leer(Path::new(&ruta)))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Carpeta de trabajo de una conversacion: el proyecto si lo tiene, o la comun.
#[tauri::command]
pub async fn maria_carpeta_de(thread_id: String) -> Result<String, String> {
    let dir = match crate::maria::threads::project_de(&thread_id) {
        Some(p) => p,
        None => super::relay::carpeta_de_trabajo(&thread_id)?,
    };
    Ok(dir.to_string_lossy().into_owned())
}

/// Solo http(s): nada de `file:`, `javascript:` ni esquemas propios. Pura.
#[must_use]
pub fn url_valida(url: &str) -> Option<String> {
    let u = url.trim();
    let bajo = u.to_lowercase();
    if bajo.starts_with("http://") || bajo.starts_with("https://") {
        return Some(u.to_string());
    }
    // "localhost:5173" o "ejemplo.com": se completa con el esquema sensato.
    if u.is_empty() || u.contains(' ') || u.contains("://") || bajo.starts_with("javascript:") {
        return None;
    }
    let local = bajo.starts_with("localhost") || bajo.starts_with("127.0.0.1");
    Some(format!("{}://{u}", if local { "http" } else { "https" }))
}

#[tauri::command]
pub async fn maria_web_ventana(app: AppHandle, url: String) -> Result<(), String> {
    let url = url_valida(&url).ok_or("esa dirección no es http ni https")?;
    let destino = url
        .parse()
        .map_err(|e| format!("dirección ilegible: {e}"))?;
    // Una sola ventana web: abrir otra direccion la reutiliza.
    if let Some(w) = app.get_webview_window("maria-web") {
        let _ = w.close();
    }
    WebviewWindowBuilder::new(&app, "maria-web", WebviewUrl::External(destino))
        .title(format!("mar.ia — {url}"))
        .inner_size(1100.0, 760.0)
        .min_inner_size(480.0, 360.0)
        .center()
        .build()
        .map_err(|e| format!("no pude abrir la ventana: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solo_pasan_direcciones_web_y_se_completa_el_esquema() {
        assert_eq!(
            url_valida("https://ejemplo.com/a"),
            Some("https://ejemplo.com/a".into())
        );
        assert_eq!(
            url_valida(" localhost:5173 "),
            Some("http://localhost:5173".into())
        );
        assert_eq!(
            url_valida("127.0.0.1:8790/x"),
            Some("http://127.0.0.1:8790/x".into())
        );
        assert_eq!(
            url_valida("ejemplo.com"),
            Some("https://ejemplo.com".into())
        );
        for mala in [
            "file:///C:/secreto.txt",
            "javascript:alert(1)",
            "",
            "dos palabras",
        ] {
            assert_eq!(url_valida(mala), None, "deberia rechazar {mala:?}");
        }
    }

    #[test]
    fn el_listado_pone_carpetas_primero_y_calla_el_ruido() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("zeta.md"), b"z").unwrap();
        std::fs::write(dir.path().join("Alfa.md"), b"aa").unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        let l = listar(dir.path()).unwrap();
        let nombres: Vec<&str> = l.iter().map(|e| e.nombre.as_str()).collect();
        assert_eq!(nombres, vec!["src", "Alfa.md", "zeta.md"]);
        assert_eq!(l[1].bytes, 2);
        assert!(listar(&dir.path().join("no-existe")).is_err());
    }

    #[test]
    fn un_binario_o_un_fichero_enorme_se_dicen_en_vez_de_volcarse() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("x.bin");
        std::fs::write(&bin, [0xff_u8, 0xfe, 0x00, 0x80]).unwrap();
        assert!(leer(&bin).is_err());
        let txt = dir.path().join("a.txt");
        std::fs::write(&txt, "hola").unwrap();
        assert_eq!(leer(&txt).unwrap(), "hola");
    }
}
