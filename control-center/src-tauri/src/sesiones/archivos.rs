// sesiones/archivos.rs — Acciones sobre ficheros que se citan en el chat:
// abrir una imagen con la app del sistema, mostrarla en su carpeta, abrir un
// fichero en VS Code en una línea y guardar una imagen del chat.
//
// Las rutas vienen del texto de Claude, así que se validan aquí: sin `..`,
// relativas solo respecto al cwd de la sesión, existentes y bajo el
// directorio personal. Abrir con la app del sistema solo se permite con
// imágenes (`open_image`) o con los tipos de `ABRIBLES` (`open_file`): abrir
// un `.bat` o un `.exe` lo ejecutaría, y un `.html` o un `.svg` se abriría en
// el navegador con sus scripts. `estados` dice a la pestaña Adjuntos qué
// rutas citadas existen de verdad.
//
// Las rutas de red y de dispositivo (`\\host\share`, `//host/share`,
// `\\?\UNC\…`, `\\.\…`, `\??\…`) se rechazan antes de tocar el disco:
// comprobar si existen abre una conexión SMB, y Windows entrega en ella el
// hash NTLM del usuario a quien la reciba.

use std::path::{Component, Path, PathBuf};

use base64::Engine;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use super::adjuntos::{image_mime, plain, MAX_BYTES};

/// Motivo de rechazo de una ruta de red o de dispositivo.
pub const ERROR_RUTA_DE_RED: &str =
    "ruta no permitida: ruta de red o de dispositivo (UNC); no se comprueba para no abrir una conexión SMB";

/// true si `p` empieza por dos separadores (`\\host`, `//host`, `\\?\UNC\`,
/// `\\.\`, mezclas de `/` y `\`) o por el prefijo NT `\??\`. Se decide sobre
/// el texto, sin ninguna llamada al sistema de ficheros. Las rutas locales
/// en forma verbatim (`\\?\C:\…`) también caen: no hacen falta para citar un
/// fichero y separarlas exigiría interpretar el prefijo.
pub fn es_ruta_de_red(p: &str) -> bool {
    let b = p.trim_start().as_bytes();
    let sep = |c: u8| c == b'\\' || c == b'/';
    let doble = b.len() >= 2 && sep(b[0]) && sep(b[1]);
    let nt = b.len() >= 4 && sep(b[0]) && b[1] == b'?' && b[2] == b'?' && sep(b[3]);
    doble || nt
}

/// Resuelve `path` (absoluta, o relativa a `cwd`) dentro de `home`. Las rutas
/// de red o de dispositivo (también como `cwd`) se rechazan antes de
/// cualquier llamada al sistema de ficheros.
pub fn resolve_under(home: &Path, path: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    let raw = PathBuf::from(path.trim());
    if raw.as_os_str().is_empty() {
        return Err("ruta vacía".to_string());
    }
    if es_ruta_de_red(path) || cwd.is_some_and(es_ruta_de_red) {
        return Err(ERROR_RUTA_DE_RED.to_string());
    }
    if raw.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("ruta no permitida: contiene '..'".to_string());
    }
    let full = if raw.is_absolute() {
        raw
    } else {
        let base = cwd
            .map(PathBuf::from)
            .filter(|c| c.is_absolute())
            .ok_or_else(|| "ruta relativa sin directorio de trabajo".to_string())?;
        base.join(raw)
    };
    if es_ruta_de_red(&full.to_string_lossy()) {
        return Err(ERROR_RUTA_DE_RED.to_string());
    }
    let canon = std::fs::canonicalize(&full)
        .map(plain)
        .map_err(|_| format!("no existe: {}", full.display()))?;
    let home_canon = std::fs::canonicalize(home)
        .map(plain)
        .map_err(|e| format!("no se pudo resolver el directorio personal: {e}"))?;
    if !canon.starts_with(&home_canon) {
        return Err("ruta no permitida: fuera del directorio personal".to_string());
    }
    Ok(canon)
}

fn resolve(path: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no hay directorio personal".to_string())?;
    resolve_under(&home, path, cwd)
}

/// URL `vscode://file/…` para abrir `path` en la línea `line`.
pub fn vscode_url(path: &Path, line: Option<u32>) -> String {
    let mut p = path.to_string_lossy().replace('\\', "/");
    if !p.starts_with('/') {
        p.insert(0, '/');
    }
    let encoded: String = p
        .chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '#' => "%23".to_string(),
            '?' => "%3F".to_string(),
            '%' => "%25".to_string(),
            other => other.to_string(),
        })
        .collect();
    match line {
        Some(l) if l > 0 => format!("vscode://file{encoded}:{l}"),
        _ => format!("vscode://file{encoded}"),
    }
}

pub fn open_image(app: &AppHandle, path: &str, cwd: Option<&str>) -> Result<(), String> {
    let p = resolve(path, cwd)?;
    if image_mime(&p.to_string_lossy()).is_none() {
        return Err("solo se abren imágenes con la app del sistema".to_string());
    }
    app.opener()
        .open_path(p.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("no se pudo abrir la imagen: {e}"))
}

pub fn reveal(app: &AppHandle, path: &str, cwd: Option<&str>) -> Result<(), String> {
    let p = resolve(path, cwd)?;
    app.opener()
        .reveal_item_in_dir(&p)
        .map_err(|e| format!("no se pudo mostrar en la carpeta: {e}"))
}

/// Tope de rutas por consulta de `estados`.
pub const MAX_RUTAS_ESTADO: usize = 500;

/// Extensiones que «Abrir» entrega a la app del sistema: medios, documentos y
/// texto. Fuera quedan ejecutables y scripts (`.exe`, `.bat`, `.ps1`, `.js`,
/// `.lnk`…), que el sistema ejecutaría en vez de abrirlos, y los tipos que la
/// app por defecto (el navegador) abre ejecutando sus scripts: `.html`,
/// `.htm`, `.xhtml`, `.svg`, `.mht`, `.hta` y `.xml` (una hoja XSLT puede
/// generar HTML con scripts). «Abrir carpeta» sigue disponible para ellos.
const ABRIBLES: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "mp4", "webm", "mov", "mkv", "avi", "m4v",
    "wmv", "mp3", "wav", "ogg", "flac", "m4a", "aac", "opus", "pdf", "txt", "md", "log", "csv",
    "tsv", "json", "yaml", "yml", "toml", "docx", "xlsx", "pptx", "odt", "ods", "odp", "zip", "7z",
    "gz", "tar", "glb", "gltf", "obj", "fbx", "stl",
];

/// Estado en disco de una ruta citada en la sesión (pestaña Adjuntos).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EstadoRuta {
    /// Ruta tal como llegó (clave para el cliente).
    pub path: String,
    /// Ruta canónica, si existe y está permitida.
    pub abs: Option<String>,
    /// true si existe y está bajo el directorio personal.
    pub exists: bool,
    pub is_file: bool,
    /// true si «Abrir» con la app del sistema está permitido para su tipo.
    pub can_open: bool,
    pub size: Option<u64>,
    /// Motivo cuando no existe, no es un fichero o no está permitida.
    pub error: Option<String>,
}

/// true si el tipo del fichero se puede abrir con la app del sistema. Un `:`
/// en el nombre (flujo alternativo de NTFS) lo descarta.
pub fn abrible(p: &Path) -> bool {
    let nombre_ok = p
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| !n.contains(':'));
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    nombre_ok && ext.is_some_and(|e| ABRIBLES.contains(&e.as_str()))
}

/// Estado de una ruta absoluta bajo `home` (las relativas las resuelve el
/// cliente contra el cwd de la sesión).
pub fn estado_under(home: &Path, path: &str) -> EstadoRuta {
    let base = EstadoRuta {
        path: path.to_string(),
        abs: None,
        exists: false,
        is_file: false,
        can_open: false,
        size: None,
        error: None,
    };
    let canon = match resolve_under(home, path, None) {
        Ok(c) => c,
        Err(e) => {
            return EstadoRuta {
                error: Some(e),
                ..base
            }
        }
    };
    let meta = std::fs::metadata(&canon).ok().filter(|m| m.is_file());
    let is_file = meta.is_some();
    EstadoRuta {
        abs: Some(canon.to_string_lossy().into_owned()),
        exists: true,
        is_file,
        can_open: is_file && abrible(&canon),
        size: meta.map(|m| m.len()),
        error: (!is_file).then(|| "no es un fichero".to_string()),
        ..base
    }
}

/// Estado de varias rutas absolutas (como mucho `MAX_RUTAS_ESTADO`).
pub fn estados(paths: &[String]) -> Result<Vec<EstadoRuta>, String> {
    if paths.len() > MAX_RUTAS_ESTADO {
        return Err(format!(
            "demasiadas rutas: {} (máximo {MAX_RUTAS_ESTADO})",
            paths.len()
        ));
    }
    let home = dirs::home_dir().ok_or_else(|| "no hay directorio personal".to_string())?;
    Ok(paths.iter().map(|p| estado_under(&home, p)).collect())
}

/// Abre un fichero con la app del sistema, solo si su tipo está en `ABRIBLES`.
pub fn open_file(app: &AppHandle, path: &str, cwd: Option<&str>) -> Result<(), String> {
    let p = resolve(path, cwd)?;
    if !p.is_file() {
        return Err(format!("no es un fichero: {}", p.display()));
    }
    if !abrible(&p) {
        return Err("por seguridad, este tipo de fichero no se abre desde aquí (podría ejecutarse); usa «Abrir carpeta»".to_string());
    }
    app.opener()
        .open_path(p.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("no se pudo abrir el fichero: {e}"))
}

pub fn open_in_editor(
    app: &AppHandle,
    path: &str,
    line: Option<u32>,
    cwd: Option<&str>,
) -> Result<(), String> {
    let p = resolve(path, cwd)?;
    if !p.is_file() {
        return Err(format!("no es un fichero: {}", p.display()));
    }
    app.opener()
        .open_url(vscode_url(&p, line), None::<&str>)
        .map_err(|e| format!("no se pudo abrir en VS Code: {e}"))
}

/// Bytes y extensión de una `data:` URL de imagen.
pub fn decode_image_data_url(url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let (head, data) = url
        .strip_prefix("data:")
        .and_then(|r| r.split_once(','))
        .ok_or_else(|| "no es una data URL".to_string())?;
    let ext = match head {
        "image/png;base64" => "png",
        "image/jpeg;base64" => "jpg",
        "image/gif;base64" => "gif",
        "image/webp;base64" => "webp",
        "image/svg+xml;base64" => "svg",
        _ => return Err(format!("formato de imagen no admitido: {head}")),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("base64 inválido: {e}"))?;
    if bytes.len() > MAX_BYTES {
        return Err("la imagen supera 20 MB".to_string());
    }
    Ok((bytes, ext))
}

/// Pide dónde guardar y escribe la imagen. `Ok(None)` si se cancela.
pub fn save_image(app: &AppHandle, data_url: &str, name: &str) -> Result<Option<String>, String> {
    let (bytes, ext) = decode_image_data_url(data_url)?;
    let stem: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
        .collect();
    let stem = stem.trim().trim_end_matches(&format!(".{ext}")).to_string();
    let file_name = format!("{}.{ext}", if stem.is_empty() { "imagen" } else { &stem });
    let Some(target) = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .add_filter("Imagen", &[ext])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = target
        .into_path()
        .map_err(|e| format!("ruta de destino no válida: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("no se pudo guardar la imagen: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resuelve_relativas_al_cwd_y_rechaza_salidas() {
        let home = std::env::temp_dir().join(format!("ultron-arch-{}", std::process::id()));
        let cwd = home.join("proy");
        std::fs::create_dir_all(cwd.join("src")).expect("mkdir");
        std::fs::write(cwd.join("src").join("a.ts"), "x").expect("write");
        let cwd_s = cwd.to_string_lossy().into_owned();
        assert!(resolve_under(&home, "src/a.ts", Some(&cwd_s)).is_ok());
        assert!(resolve_under(&home, "../a.ts", Some(&cwd_s)).is_err());
        assert!(resolve_under(&home, "src/a.ts", None).is_err());
        assert!(resolve_under(&home, "src/no-existe.ts", Some(&cwd_s)).is_err());
        let fuera = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(resolve_under(&home, &fuera, None).is_err(), "fuera de home");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn estado_de_rutas_existentes_ausentes_y_ejecutables() {
        let home = std::env::temp_dir().join(format!("ultron-est-{}", std::process::id()));
        std::fs::create_dir_all(home.join("out")).expect("mkdir");
        std::fs::write(home.join("out").join("v.mp4"), "xx").expect("write");
        std::fs::write(home.join("out").join("x.bat"), "x").expect("write");
        let ruta = |r: &str| home.join(r).to_string_lossy().into_owned();
        let mp4 = estado_under(&home, &ruta("out/v.mp4"));
        assert!(mp4.exists && mp4.is_file && mp4.can_open, "{mp4:?}");
        assert_eq!(mp4.size, Some(2));
        let bat = estado_under(&home, &ruta("out/x.bat"));
        assert!(bat.exists && !bat.can_open, "un .bat no se abre");
        let dir = estado_under(&home, &ruta("out"));
        assert!(dir.exists && !dir.is_file && dir.error.is_some());
        let falta = estado_under(&home, &ruta("out/no.mp4"));
        assert!(!falta.exists && falta.abs.is_none() && falta.error.is_some());
        assert!(!estado_under(&home, "out/v.mp4").exists, "relativa sin cwd");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn abrible_solo_medios_y_documentos() {
        assert!(abrible(Path::new(r"C:\a\Vídeo.MP4")));
        assert!(abrible(Path::new("/a/informe.pdf")));
        for p in [
            "a.exe",
            "a.bat",
            "a.ps1",
            "a.js",
            "a.lnk",
            "a.html",
            "a.HTM",
            "a.xhtml",
            "a.svg",
            "a.mht",
            "a.mhtml",
            "a.hta",
            "a.xml",
            "a.mp4:b",
            "a.exe:b.mp4",
            "sin_ext",
        ] {
            assert!(!abrible(Path::new(p)), "{p}");
        }
        assert!(estados(&vec![String::new(); MAX_RUTAS_ESTADO + 1]).is_err());
    }

    /// Un `.html` o un `.svg` existe y se puede mostrar en su carpeta, pero
    /// no abrir con la app del sistema.
    #[test]
    fn html_y_svg_existen_pero_no_se_abren() {
        let home = std::env::temp_dir().join(format!("ultron-html-{}", std::process::id()));
        std::fs::create_dir_all(&home).expect("mkdir");
        for f in ["p.html", "p.svg", "p.htm"] {
            std::fs::write(home.join(f), "<script>x</script>").expect("write");
            let e = estado_under(&home, &home.join(f).to_string_lossy());
            assert!(e.exists && e.is_file && !e.can_open, "{f}: {e:?}");
        }
        std::fs::write(home.join("p.pdf"), "x").expect("write");
        let pdf = estado_under(&home, &home.join("p.pdf").to_string_lossy());
        assert!(pdf.can_open, "caso positivo: {pdf:?}");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Rutas de red y de dispositivo: se rechazan por el texto, con motivo, y
    /// sin llegar a `canonicalize` (con un `home` inexistente, tocar el disco
    /// daría otro error).
    #[test]
    fn rutas_de_red_y_de_dispositivo_se_rechazan_sin_tocar_el_disco() {
        let home = Path::new(r"Z:\no-existe-ultron");
        for p in [
            r"\\host\share\x.png",
            "//host/share/x.png",
            r"\/host/share/x.png",
            r"/\host\share\x.png",
            r"\\?\UNC\host\share\x.png",
            r"\\.\PhysicalDrive0",
            r"\\?\C:\Users\x.png",
            r"\??\UNC\host\share\x.png",
            r"  \\host\share",
        ] {
            assert!(es_ruta_de_red(p), "{p}");
            assert_eq!(
                resolve_under(home, p, None),
                Err(ERROR_RUTA_DE_RED.to_string()),
                "{p}"
            );
            let e = estado_under(home, p);
            assert!(!e.exists && e.abs.is_none(), "{p}: {e:?}");
            assert_eq!(e.error.as_deref(), Some(ERROR_RUTA_DE_RED), "{p}");
        }
        // Relativa con un cwd de red: tampoco se toca el disco.
        assert_eq!(
            resolve_under(home, "a.png", Some(r"\\host\share")),
            Err(ERROR_RUTA_DE_RED.to_string())
        );
        // Casos negativos: rutas locales, que siguen el camino normal.
        for p in [
            r"C:\Users\x.png",
            "/home/r/x.png",
            r"\Users\x.png",
            "src/a.ts",
        ] {
            assert!(!es_ruta_de_red(p), "{p}");
        }
        let e = estado_under(home, r"C:\Users\no-existe-ultron.png");
        assert_ne!(e.error.as_deref(), Some(ERROR_RUTA_DE_RED));
    }

    #[test]
    fn url_de_vscode_con_linea_y_espacios() {
        let u = vscode_url(Path::new(r"C:\Users\R\mi proy\a#b.ts"), Some(42));
        assert_eq!(u, "vscode://file/C:/Users/R/mi%20proy/a%23b.ts:42");
        assert_eq!(
            vscode_url(Path::new("/home/r/a.ts"), None),
            "vscode://file/home/r/a.ts"
        );
    }

    #[test]
    fn decodifica_solo_imagenes() {
        let (b, ext) = decode_image_data_url("data:image/png;base64,iVBORw==").expect("png");
        assert_eq!(ext, "png");
        assert!(!b.is_empty());
        assert!(decode_image_data_url("data:text/html;base64,PGI+").is_err());
        assert!(decode_image_data_url("hola").is_err());
    }
}
