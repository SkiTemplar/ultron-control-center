// sesiones/ganchos.rs — Lectura de la cola de un fichero de registro.
//
// Lo usa `uso.rs` para leer el final del historial sin cargarlo entero. La
// tabla de hooks con métricas de 24 h se retiró el 2026-10-14 junto con la
// pestaña Hooks del inspector.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Último `max` bytes de un fichero, desde el primer salto de línea completo.
pub fn read_tail(path: &Path, max: u64) -> String {
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start == 0 {
        return text;
    }
    match text.find('\n') {
        Some(i) => text[i + 1..].to_string(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_cola_descarta_la_linea_partida() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("t.jsonl");
        std::fs::write(&p, "linea-uno-larga\nlinea2\nlinea3\n").expect("fichero");
        assert_eq!(read_tail(&p, 14), "linea3\n");
        assert_eq!(read_tail(&p, 1_000), "linea-uno-larga\nlinea2\nlinea3\n");
        assert_eq!(read_tail(&dir.path().join("no"), 10), "");
    }
}
