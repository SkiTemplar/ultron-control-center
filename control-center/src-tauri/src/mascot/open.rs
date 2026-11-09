// Mascota — abrir ficheros locales de medios y documentos que aparecen en una
// respuesta (bubble.tsx → Linkified → mascot_open_file). La ventana de la
// mascota no tiene el plugin opener en sus capabilities: este comando es la
// única puerta y solo deja pasar extensiones de la lista blanca, nunca
// ejecutables, scripts ni accesos directos.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

/// Extensiones (en minúsculas) que se pueden abrir con la aplicación
/// predeterminada. Debe coincidir con `MEDIA_EXTENSIONS` de bubble.tsx; la
/// decisión que cuenta es la de aquí.
#[rustfmt::skip]
pub const MEDIA_EXTENSIONS: &[&str] = &[
    // imagen
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "tif", "tiff", "ico",
    // vídeo
    "mp4", "mkv", "mov", "avi", "webm", "wmv", "m4v",
    // audio
    "mp3", "wav", "ogg", "flac", "m4a", "aac", "opus",
    // documentos
    "pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp", "epub",
];

const FILE_SCHEME: &str = "file://";

/// Abre con la aplicación predeterminada de Windows un fichero local de la
/// lista blanca. Valida antes con `validate_media_path`.
#[tauri::command]
pub async fn mascot_open_file(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let file = validate_media_path(&path)?;
    app.opener()
        .open_path(file.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("no se pudo abrir {}: {e}", file.display()))
}

/// Normaliza y valida una ruta recibida del bocadillo. Pura salvo la consulta
/// al sistema de ficheros (existe y es fichero). Devuelve la ruta lista para
/// abrir o un error explicado en español.
pub fn validate_media_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("ruta vacía".to_string());
    }
    let path = normalize(trimmed)?;
    if !path.is_absolute() {
        return Err(format!("solo se abren rutas absolutas: {trimmed}"));
    }
    check_local(&path)?;
    check_extension(&path)?;
    let meta = std::fs::metadata(&path)
        .map_err(|e| format!("no existe o no se puede leer {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("no es un fichero: {}", path.display()));
    }
    Ok(path)
}

/// `file:///C:/a%20b/c.png` → `C:/a b/c.png`; cualquier otra cadena se toma
/// como ruta tal cual.
fn normalize(raw: &str) -> Result<PathBuf, String> {
    let Some(prefix) = raw.get(..FILE_SCHEME.len()) else {
        return Ok(PathBuf::from(raw));
    };
    if !prefix.eq_ignore_ascii_case(FILE_SCHEME) {
        return Ok(PathBuf::from(raw));
    }
    let rest = &raw[FILE_SCHEME.len()..];
    // file:///C:/x → "/C:/x"; se quita la barra que precede a la unidad.
    let local = rest
        .strip_prefix('/')
        .ok_or_else(|| format!("URL file:// con host no admitida: {raw}"))?;
    Ok(PathBuf::from(percent_decode(local)?))
}

fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let hex = s
            .get(i + 1..i + 3)
            .and_then(|h| u8::from_str_radix(h, 16).ok())
            .ok_or_else(|| format!("escape % mal formado en la URL: {s}"))?;
        out.push(hex);
        i += 3;
    }
    String::from_utf8(out).map_err(|_| format!("la URL no es UTF-8 válido: {s}"))
}

/// Solo unidades locales (`C:\...`). Una ruta UNC (`\\servidor\x.png`) haría
/// que Windows se autenticara contra ese servidor al abrirla (fuga de
/// credenciales NTLM), y un `:` fuera de la unidad apunta a un flujo
/// alternativo de NTFS (`foto.png:oculto`), no a un fichero normal.
fn check_local(path: &Path) -> Result<(), String> {
    let s = path.to_string_lossy();
    let b = s.as_bytes();
    let drive = b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/');
    if !drive {
        return Err(format!(
            "solo se abren ficheros de una unidad local (C:\\…): {s}"
        ));
    }
    if s[2..].contains(':') {
        return Err(format!("ruta con «:» no admitida: {s}"));
    }
    Ok(())
}

fn check_extension(path: &Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| format!("el fichero no tiene extensión: {}", path.display()))?;
    if MEDIA_EXTENSIONS.contains(&ext.as_str()) {
        Ok(())
    } else {
        Err(format!(
            "solo se abren fotos, vídeos, audios y documentos; .{ext} no está permitido: {}",
            path.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Directorio temporal propio del test, con los ficheros indicados creados vacíos.
    fn fixture(tag: &str, files: &[&str]) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ultron-mascot-open-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("crear directorio temporal");
        for f in files {
            fs::write(dir.join(f), b"x").expect("crear fichero de prueba");
        }
        dir
    }

    fn as_str(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn rechaza_unc_y_flujos_alternativos() {
        for p in [
            r"\\servidor\compartida\foto.png",
            "//servidor/compartida/foto.png",
            r"\\?\C:\x\foto.png",
            r"C:\x\foto.png:oculto.png",
        ] {
            assert!(validate_media_path(p).is_err(), "{p}");
        }
        assert!(validate_media_path("file://servidor/c/foto.png").is_err());
    }

    #[test]
    fn acepta_imagen_existente() {
        let dir = fixture("ok", &["foto.png"]);
        let file = dir.join("foto.png");
        assert_eq!(validate_media_path(&as_str(&file)).unwrap(), file);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn extension_en_mayusculas_permitida() {
        let dir = fixture("upper", &["FOTO.PNG", "Informe.Pdf"]);
        assert!(validate_media_path(&as_str(&dir.join("FOTO.PNG"))).is_ok());
        assert!(validate_media_path(&as_str(&dir.join("Informe.Pdf"))).is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rechaza_ejecutables_y_scripts_aunque_existan() {
        let bad = [
            "a.exe",
            "a.bat",
            "a.cmd",
            "a.ps1",
            "a.vbs",
            "a.js",
            "a.lnk",
            "a.msi",
            "a.scr",
            "a.com",
            "a.reg",
            "a.hta",
            "a.EXE",
            "a.txt",
            "a.png.exe",
        ];
        let dir = fixture("bad", &bad);
        for f in bad {
            let err = validate_media_path(&as_str(&dir.join(f))).unwrap_err();
            assert!(err.contains("no está permitido"), "{f}: {err}");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rechaza_sin_extension() {
        let dir = fixture("noext", &["README"]);
        let err = validate_media_path(&as_str(&dir.join("README"))).unwrap_err();
        assert!(err.contains("no tiene extensión"), "{err}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rechaza_ruta_relativa() {
        for rel in ["foto.png", "fotos\\foto.png", "..\\foto.png", "./foto.png"] {
            let err = validate_media_path(rel).unwrap_err();
            assert!(err.contains("rutas absolutas"), "{rel}: {err}");
        }
    }

    #[test]
    fn rechaza_vacia() {
        assert!(validate_media_path("   ").is_err());
    }

    #[test]
    fn rechaza_fichero_inexistente() {
        let dir = fixture("missing", &[]);
        let err = validate_media_path(&as_str(&dir.join("no-esta.png"))).unwrap_err();
        assert!(err.contains("no existe"), "{err}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rechaza_directorio_con_extension_valida() {
        let dir = fixture("dir", &[]);
        let sub = dir.join("carpeta.png");
        fs::create_dir_all(&sub).unwrap();
        let err = validate_media_path(&as_str(&sub)).unwrap_err();
        assert!(err.contains("no es un fichero"), "{err}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn normaliza_file_url_con_espacios_codificados() {
        let dir = fixture("url", &["doc final.pdf"]);
        let file = dir.join("doc final.pdf");
        let slashed = as_str(&file).replace('\\', "/").replace(' ', "%20");
        let url = if slashed.starts_with('/') {
            format!("file://{slashed}")
        } else {
            format!("file:///{slashed}")
        };
        let got = validate_media_path(&url).unwrap();
        assert_eq!(
            fs::canonicalize(got).unwrap(),
            fs::canonicalize(&file).unwrap()
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn file_url_con_host_o_escape_roto_falla() {
        assert!(validate_media_path("file://servidor/c/a.png")
            .unwrap_err()
            .contains("host"));
        assert!(validate_media_path("file:///C:/a%2.png")
            .unwrap_err()
            .contains("mal formado"));
    }

    #[test]
    fn file_url_de_ejecutable_rechazada() {
        let err = validate_media_path("file:///C:/Windows/System32/cmd.exe").unwrap_err();
        assert!(err.contains("no está permitido"), "{err}");
    }
}
