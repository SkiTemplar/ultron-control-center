// mar.ia — ficheros que se arrastran o se pegan en el chat.
//
// La ventana web no ve rutas: un fichero soltado o una captura pegada llegan
// como bytes. Aqui se guardan junto al hilo y se devuelve la RUTA, que es lo
// que entienden las CLI (`--add-dir`, `-i`) y lo que el relevo incrusta cuando
// contesta el modelo local. Lo elegido con el dialogo de Windows ya trae ruta y
// no pasa por aqui.
//
// Limite declarado: 25 MB por fichero. Mas que eso en base64 por el puente de
// la ventana es una pausa que se nota, y para un fichero asi esta el dialogo.

use std::path::PathBuf;

use base64::Engine;

const MAX_BYTES: usize = 25 * 1024 * 1024;
const MAX_NOMBRE: usize = 80;

/// Nombre seguro: sin rutas, sin caracteres que Windows rechaza, acotado.
#[must_use]
pub fn nombre_seguro(nombre: &str) -> String {
    let base = nombre.rsplit(['/', '\\']).next().unwrap_or("");
    let limpio: String = base
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let limpio = limpio.trim().trim_matches('.').to_string();
    if limpio.is_empty() {
        return "adjunto".into();
    }
    // Se recorta el nombre, no la extension: de ella depende como se trata.
    let (stem, ext) = match limpio.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && e.len() <= 8 => (s.to_string(), format!(".{e}")),
        _ => (limpio.clone(), String::new()),
    };
    let tope = MAX_NOMBRE.saturating_sub(ext.chars().count());
    let stem: String = stem.chars().take(tope).collect();
    format!("{stem}{ext}")
}

fn hilo_valido(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn carpeta(thread_id: &str) -> Result<PathBuf, String> {
    if !hilo_valido(thread_id) {
        return Err("identificador de conversacion invalido".into());
    }
    let dir = crate::maria::paths::cockpit("maria")?
        .join("threads")
        .join(format!("{thread_id}-adjuntos"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("crear carpeta de adjuntos: {e}"))?;
    Ok(dir)
}

/// Ruta libre para `nombre` dentro de `dir`: si ya existe, se numera.
fn ruta_libre(dir: &std::path::Path, nombre: &str) -> PathBuf {
    let primera = dir.join(nombre);
    if !primera.exists() {
        return primera;
    }
    let (stem, ext) = match nombre.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (nombre.to_string(), String::new()),
    };
    (2..1000)
        .map(|n| dir.join(format!("{stem}-{n}{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(primera)
}

pub fn guardar(thread_id: &str, nombre: &str, datos_base64: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(datos_base64.trim())
        .map_err(|e| format!("el adjunto no llego entero: {e}"))?;
    if bytes.is_empty() {
        return Err("el adjunto esta vacio".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "el adjunto pesa {} MB y el tope al arrastrar es 25 MB; elige el fichero con el clip",
            bytes.len() / (1024 * 1024)
        ));
    }
    let destino = ruta_libre(&carpeta(thread_id)?, &nombre_seguro(nombre));
    std::fs::write(&destino, bytes).map_err(|e| format!("guardar adjunto: {e}"))?;
    Ok(destino.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn maria_adjunto_guardar(
    thread_id: String,
    nombre: String,
    datos_base64: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || guardar(&thread_id, &nombre, &datos_base64))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_nombre_no_puede_salir_de_la_carpeta() {
        assert_eq!(nombre_seguro("..\\..\\windows\\system32\\x.dll"), "x.dll");
        assert_eq!(nombre_seguro("/etc/passwd"), "passwd");
        assert_eq!(nombre_seguro(".."), "adjunto");
        assert_eq!(nombre_seguro(""), "adjunto");
    }

    #[test]
    fn se_limpian_los_caracteres_que_windows_rechaza() {
        assert_eq!(nombre_seguro("informe: v2?.pdf"), "informe_ v2_.pdf");
    }

    #[test]
    fn un_nombre_eterno_se_recorta_y_conserva_la_extension() {
        let largo = format!("{}.png", "a".repeat(300));
        let n = nombre_seguro(&largo);
        assert!(n.chars().count() <= MAX_NOMBRE);
        assert!(n.ends_with(".png"));
    }

    #[test]
    fn un_hilo_con_barras_no_vale() {
        assert!(hilo_valido("hilo-2026_09"));
        assert!(!hilo_valido("../otro"));
        assert!(!hilo_valido(""));
    }

    #[test]
    fn base64_roto_se_dice_y_no_se_escribe_nada() {
        assert!(guardar("hilo-test", "a.txt", "%%%no-es-base64%%%").is_err());
    }

    #[test]
    fn el_segundo_con_el_mismo_nombre_se_numera() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("foto.png"), b"1").unwrap();
        assert_eq!(
            ruta_libre(dir.path(), "foto.png").file_name().unwrap(),
            "foto-2.png"
        );
    }
}
