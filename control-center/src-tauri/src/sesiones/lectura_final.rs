// sesiones/lectura_final.rs — Lectura del final de un JSONL sin cargarlo
// entero (transcripts de días: 50-200 MB).
//
// Se lee una ventana desde el final que empieza en la primera línea completa
// y, si al llamante no le basta, se cuadruplica hasta cubrir el fichero. El
// coste total queda acotado por ~4/3 de la última ventana leída.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

/// Primera ventana desde el final.
pub const VENTANA_INICIAL: u64 = 256 * 1024;

/// Final de un fichero, desde una frontera de línea.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Final {
    pub texto: String,
    /// true si la ventana cubre el fichero entero.
    pub completo: bool,
}

/// Últimos `max_bytes` de `path`, recortados a la primera línea completa.
pub fn leer_final(path: &Path, max_bytes: u64) -> io::Result<Final> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let desde = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(desde))?;
    let mut buf = Vec::new();
    f.take(len - desde).read_to_end(&mut buf)?;
    let inicio = if desde == 0 {
        0
    } else {
        buf.iter()
            .position(|b| *b == b'\n')
            .map_or(buf.len(), |i| i + 1)
    };
    Ok(Final {
        texto: String::from_utf8_lossy(&buf[inicio..]).into_owned(),
        completo: desde == 0,
    })
}

/// Llama a `f` con ventanas crecientes desde el final hasta que devuelve
/// `Some` o la ventana cubre el fichero (entonces devuelve lo que diga `f`
/// con el fichero entero).
pub fn buscar_desde_el_final<T>(
    path: &Path,
    mut f: impl FnMut(&Final) -> Option<T>,
) -> io::Result<Option<T>> {
    let mut ventana = VENTANA_INICIAL;
    loop {
        let fin = leer_final(path, ventana)?;
        let r = f(&fin);
        if r.is_some() || fin.completo {
            return Ok(r);
        }
        ventana = ventana.saturating_mul(4);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_ventana_empieza_en_una_linea_completa() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("t.jsonl");
        std::fs::write(&p, "aaaa\nbbbb\ncccc\n").expect("escribir");
        let f = leer_final(&p, 7).expect("leer");
        assert_eq!(f.texto, "cccc\n");
        assert!(!f.completo);
        let f = leer_final(&p, 1_000).expect("leer");
        assert_eq!(f.texto, "aaaa\nbbbb\ncccc\n");
        assert!(f.completo);
    }

    #[test]
    fn la_busqueda_crece_hasta_el_principio_si_no_encuentra() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("t.jsonl");
        let relleno = "x".repeat(100);
        let mut texto = String::from("PRIMERA\n");
        for _ in 0..10_000 {
            texto.push_str(&relleno);
            texto.push('\n');
        }
        std::fs::write(&p, &texto).expect("escribir");
        let mut vueltas = 0;
        let r = buscar_desde_el_final(&p, |fin| {
            vueltas += 1;
            fin.texto.starts_with("PRIMERA").then_some(fin.completo)
        })
        .expect("buscar");
        assert_eq!(r, Some(true));
        assert!(vueltas > 1, "la primera ventana no llega al principio");
        let nada = buscar_desde_el_final(&p, |_| None::<()>).expect("buscar");
        assert_eq!(nada, None, "sin coincidencia y con el fichero entero: None");
    }
}
