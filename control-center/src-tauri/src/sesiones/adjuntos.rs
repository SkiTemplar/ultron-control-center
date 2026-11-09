// sesiones/adjuntos.rs — Adjuntos pegados o arrastrados en el composer y
// lectura de imágenes locales para la ventana.
//
// Los adjuntos se guardan en `~/.ultron/adjuntos/AAAA-MM-DD/<uuid>-<nombre>`
// (máx. 20 MB de cualquier tipo; el texto, máx. 256 KB). El composer solo copia
// aquí lo que Claude Code puede leer con una mención `@"<ruta>"`; del resto envía
// la ruta original (`ruta_fichero.rs`) y usa esta copia si no la puede obtener.
// La copia no se ejecuta: abrirla pasa por la lista de `archivos::ABRIBLES`.
// `read_image` solo sirve imágenes bajo `$HOME`, sin `..` y sin enlaces que
// salgan de él (se compara la ruta canónica).

use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde::Serialize;

pub const MAX_BYTES: usize = 20 * 1024 * 1024;
/// Tope de un adjunto de texto: Claude Code lo lee entero al citarlo con `@`
/// y cada KB cuesta tokens (R31, seguridad-robustez:F12).
pub const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_NAME_CHARS: usize = 80;

const IMAGE_EXT: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
];
/// Extensiones de texto: cuentan para `MAX_TEXT_BYTES`. Misma lista que
/// `TEXT_EXT` en `composer/attachment-kind.ts` (lo comprueba un test de vitest).
const TEXT_EXT: &[&str] = &[
    "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "yaml", "yml", "toml", "xml",
    "ini", "cfg", "rs", "ts", "tsx", "js", "jsx", "mjs", "py", "c", "h", "cpp", "hpp", "cs",
    "java", "go", "sh", "ps1", "sql", "html", "css", "diff", "patch",
];

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedAttachment {
    pub path: String,
    /// `data:` URL de previsualización (solo imágenes; null en el resto).
    pub preview_data_url: Option<String>,
}

fn ext_of(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
}

/// MIME de imagen según la extensión, si es una imagen admitida.
pub fn image_mime(name: &str) -> Option<&'static str> {
    let ext = ext_of(name)?;
    IMAGE_EXT.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m)
}

/// Nombre seguro: solo `[A-Za-z0-9._-]`, sin puntos iniciales y acotado.
pub fn sanitize_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_start_matches('.');
    let count = trimmed.chars().count();
    if count <= MAX_NAME_CHARS {
        return trimmed.to_string();
    }
    // Conserva la extensión al recortar por delante.
    let skip = count - MAX_NAME_CHARS;
    trimmed.chars().skip(skip).collect()
}

/// Guarda un adjunto bajo `root/<fecha>/`. `root` es `~/.ultron/adjuntos` en
/// la app y un directorio temporal en los tests.
pub fn save_in(
    root: &Path,
    date: &str,
    name: &str,
    data_base64: &str,
) -> Result<SavedAttachment, String> {
    let safe = sanitize_name(name);
    if safe.is_empty() {
        return Err(format!("nombre de fichero no válido: '{name}'"));
    }
    // Cota previa sobre el base64 (4 caracteres → 3 bytes) antes de decodificar.
    if data_base64.len() / 4 * 3 > MAX_BYTES + 3 {
        return Err("el adjunto supera el máximo de 20 MB".to_string());
    }
    let b64 = data_base64
        .split_once(";base64,")
        .map_or(data_base64, |(_, d)| d);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("base64 no válido: {e}"))?;
    if bytes.len() > MAX_BYTES {
        return Err("el adjunto supera el máximo de 20 MB".to_string());
    }
    check_text_size(&safe, bytes.len())?;
    let dir = root.join(date);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("no se pudo crear el directorio de adjuntos: {e}"))?;
    let path = dir.join(format!("{}-{safe}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, &bytes).map_err(|e| format!("no se pudo guardar el adjunto: {e}"))?;
    let preview_data_url = image_mime(&safe).map(|m| format!("data:{m};base64,{}", b64.trim()));
    Ok(SavedAttachment {
        path: path.to_string_lossy().into_owned(),
        preview_data_url,
    })
}

/// Un fichero de texto de más de `MAX_TEXT_BYTES` se rechaza con su coste
/// estimado (~4 bytes por token); el resto de tipos no cuenta aquí.
fn check_text_size(name: &str, len: usize) -> Result<(), String> {
    let is_text = ext_of(name).is_some_and(|e| TEXT_EXT.contains(&e.as_str()));
    if !is_text || len <= MAX_TEXT_BYTES {
        return Ok(());
    }
    Err(format!(
        "'{name}' pesa {} KB (~{} tokens al citarlo): el tope de un adjunto de texto es {} KB;          recórtalo o pásale a Claude la ruta para que lea solo lo necesario",
        len / 1024,
        len / 4,
        MAX_TEXT_BYTES / 1024
    ))
}

/// Guarda en `~/.ultron/adjuntos/AAAA-MM-DD/`.
pub fn save(name: &str, data_base64: &str) -> Result<SavedAttachment, String> {
    let root = crate::ultron_root()?.join("adjuntos");
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    save_in(&root, &date, name, data_base64)
}

/// Quita el prefijo `\\?\` de las rutas canónicas de Windows.
pub fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// `data:` URL de una imagen bajo `home`.
pub fn read_image_under(home: &Path, path: &str) -> Result<String, String> {
    let path = path.trim();
    // Antes de tocar el disco: `canonicalize` abre una conexión SMB con un UNC
    // (hasta 21 s medidos contra un host inalcanzable) y Windows entrega en
    // ella el hash NTLM del usuario. Ver `archivos::es_ruta_de_red`.
    if super::archivos::es_ruta_de_red(path) {
        return Err(super::archivos::ERROR_RUTA_DE_RED.to_string());
    }
    // `~/x` y `~\x` se resuelven contra `home`; el resto de comprobaciones se aplican igual.
    let raw = match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    };
    if raw.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("ruta no permitida: contiene '..'".to_string());
    }
    if !raw.is_absolute() {
        return Err("la ruta debe ser absoluta".to_string());
    }
    let mime = image_mime(path).ok_or_else(|| "no es una imagen admitida".to_string())?;
    let canon = std::fs::canonicalize(&raw)
        .map(plain)
        .map_err(|e| format!("no se encuentra la imagen: {e}"))?;
    let home_canon = std::fs::canonicalize(home)
        .map(plain)
        .map_err(|e| format!("no se pudo resolver el directorio personal: {e}"))?;
    if !canon.starts_with(&home_canon) {
        return Err("ruta no permitida: fuera del directorio personal".to_string());
    }
    let meta = std::fs::metadata(&canon).map_err(|e| format!("no se pudo leer la imagen: {e}"))?;
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
        return Err("la imagen no es un fichero o supera 20 MB".to_string());
    }
    let bytes = std::fs::read(&canon).map_err(|e| format!("no se pudo leer la imagen: {e}"))?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

pub fn read_image(path: &str) -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "no hay directorio personal".to_string())?;
    read_image_under(&home, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_B64: &str = "iVBORw0KGgo=";

    #[test]
    fn guarda_con_fecha_uuid_y_nombre_saneado() {
        let dir = tempfile::tempdir().expect("tempdir");
        let r = save_in(dir.path(), "2026-01-02", "mi captura (1).png", PNG_B64).expect("guardar");
        let p = PathBuf::from(&r.path);
        assert_eq!(p.parent(), Some(dir.path().join("2026-01-02").as_path()));
        let fname = p.file_name().and_then(|f| f.to_str()).expect("nombre");
        assert!(fname.ends_with("-mi_captura__1_.png"), "{fname}");
        assert_eq!(fname.len(), 32 + 1 + "mi_captura__1_.png".len());
        assert_eq!(std::fs::read(&p).expect("leer").len(), 8);
        assert_eq!(
            r.preview_data_url.as_deref(),
            Some("data:image/png;base64,iVBORw0KGgo=")
        );
    }

    #[test]
    fn el_nombre_no_escapa_del_directorio() {
        let dir = tempfile::tempdir().expect("tempdir");
        let r = save_in(dir.path(), "d", "..\\..\\evil.txt", "aG9sYQ==").expect("guardar");
        assert!(PathBuf::from(&r.path).starts_with(dir.path().join("d")));
        assert!(r.preview_data_url.is_none(), "texto: sin previsualización");
        assert_eq!(sanitize_name("../.secreto.md"), "secreto.md");
    }

    #[test]
    fn admite_cualquier_tipo_sin_previsualizacion() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in [
            "paquete.zip",
            "modelo.uasset",
            "sin_extension",
            "dibujo.svg",
            "app.exe",
        ] {
            let r = save_in(dir.path(), "d", name, "aG9sYQ==").expect(name);
            assert!(r.preview_data_url.is_none(), "{name}");
            assert_eq!(std::fs::read(&r.path).expect("leer"), b"hola");
        }
    }

    #[test]
    fn rechaza_un_nombre_que_queda_vacio() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(save_in(dir.path(), "d", "...", "aG9sYQ==").is_err());
        assert!(save_in(dir.path(), "d", "", "aG9sYQ==").is_err());
    }

    #[test]
    fn un_binario_grande_no_cuenta_como_texto() {
        let dir = tempfile::tempdir().expect("tempdir");
        let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_TEXT_BYTES + 1]);
        assert!(save_in(dir.path(), "d", "paquete.zip", &big).is_ok());
        assert!(save_in(dir.path(), "d", "sin_extension", &big).is_ok());
    }

    #[test]
    fn rechaza_mas_de_20_mb() {
        let dir = tempfile::tempdir().expect("tempdir");
        let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_BYTES + 1]);
        let e = save_in(dir.path(), "d", "a.png", &big).expect_err("debe fallar");
        assert!(e.contains("20 MB"));
        let ok = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 1024]);
        assert!(save_in(dir.path(), "d", "a.png", &ok).is_ok());
    }

    #[test]
    fn un_texto_de_mas_de_256_kb_se_rechaza_con_tokens_estimados() {
        let dir = tempfile::tempdir().expect("tempdir");
        let big = base64::engine::general_purpose::STANDARD.encode(vec![b'a'; MAX_TEXT_BYTES + 1]);
        let e = save_in(dir.path(), "d", "traza.log", &big).expect_err("debe fallar");
        assert!(e.contains("256 KB") && e.contains("tokens"), "{e}");
        let ok = base64::engine::general_purpose::STANDARD.encode(vec![b'a'; MAX_TEXT_BYTES]);
        assert!(save_in(dir.path(), "d", "traza.log", &ok).is_ok());
        assert!(
            save_in(dir.path(), "d", "foto.png", &big).is_ok(),
            "una imagen no cuenta como texto"
        );
    }

    #[test]
    fn acepta_data_url_completa() {
        let dir = tempfile::tempdir().expect("tempdir");
        let r = save_in(
            dir.path(),
            "d",
            "a.png",
            "data:image/png;base64,iVBORw0KGgo=",
        )
        .expect("guardar");
        assert_eq!(std::fs::read(&r.path).expect("leer").len(), 8);
    }

    /// Un UNC se rechaza por su texto, sin llegar a `canonicalize`: la dirección
    /// es de documentación (RFC 5737) y el test falla por plazo o por mensaje si
    /// alguien mueve la guarda detrás de una llamada al sistema de ficheros.
    #[test]
    fn read_image_rechaza_rutas_de_red_sin_tocar_el_disco() {
        let home = tempfile::tempdir().expect("home");
        let inicio = std::time::Instant::now();
        for p in [
            "//host/s/x.png",
            r"\\host\s\x.png",
            "  //host/s/x.png",
            r"\/host/s/x.png",
            r"\\?\UNC\host\s\x.png",
            r"\\.\C:\x.png",
            r"\??\C:\x.png",
            "//192.0.2.1/share/x.png",
        ] {
            let e = read_image_under(home.path(), p).expect_err(p);
            assert_eq!(e, crate::sesiones::archivos::ERROR_RUTA_DE_RED, "{p}");
        }
        assert!(
            inicio.elapsed() < std::time::Duration::from_secs(2),
            "la guarda no puede intentar la red"
        );
    }

    #[test]
    fn read_image_solo_bajo_home_y_sin_puntos() {
        let home = tempfile::tempdir().expect("home");
        let fuera = tempfile::tempdir().expect("fuera");
        let dentro = home.path().join("img.png");
        std::fs::write(&dentro, [1u8, 2, 3]).expect("escribir");
        let ajena = fuera.path().join("img.png");
        std::fs::write(&ajena, [1u8]).expect("escribir");

        let ok = read_image_under(home.path(), &dentro.to_string_lossy()).expect("dentro");
        assert_eq!(ok, "data:image/png;base64,AQID");
        assert_eq!(
            read_image_under(home.path(), "~/img.png").expect("tilde"),
            ok
        );
        assert_eq!(
            read_image_under(home.path(), "~\\img.png").expect("tilde \\"),
            ok
        );
        assert!(
            read_image_under(home.path(), "~/../img.png").is_err(),
            "tilde con .."
        );
        assert!(read_image_under(home.path(), &ajena.to_string_lossy()).is_err());
        let con_puntos = home.path().join("sub").join("..").join("img.png");
        let e = read_image_under(home.path(), &con_puntos.to_string_lossy()).expect_err("..");
        assert!(e.contains(".."));
        assert!(
            read_image_under(home.path(), "img.png").is_err(),
            "relativa"
        );
        let txt = home.path().join("a.txt");
        std::fs::write(&txt, "x").expect("escribir");
        assert!(read_image_under(home.path(), &txt.to_string_lossy()).is_err());
    }
}
