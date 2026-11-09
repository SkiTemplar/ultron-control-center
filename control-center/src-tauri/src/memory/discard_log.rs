// memory/discard_log.rs — único escritor del log de descartes del write-path
// (`~/.ultron/.tmp/capture-discards.jsonl`).
//
// Lo usan la captura (`capture.rs`, hechos descartados antes del inbox) y el
// gate anti-paráfrasis del `MemoryService` (`service/candidates/discard_log.rs`).
// Esquema por línea: `ts_epoch`, `title`, `reason`, `importance` y, solo en los
// descartes por paráfrasis, `duplicate_of` y `candidate_id`.
//
// Auditoría 2026-10-26 (M3): el gate anti-paráfrasis escribía el título ANTES
// de la redacción de PII del write-path y el fichero crecía sin límite (239 KB,
// 1.821 líneas). Ahora el título pasa por los dos redactores (credenciales y
// PII) aquí, en el único punto de escritura, y el fichero rota a `.1` por
// tamaño, como `serve/request_log.rs`.
//
// Best-effort en todos los pasos: un fallo de logging NUNCA rompe el write-path.

use std::io::Write;
use std::path::{Path, PathBuf};

use super::redaction;

/// Tope del log antes de rotarlo a `.1` (un solo nivel).
const DISCARD_LOG_MAX_BYTES: u64 = 1024 * 1024;

/// Un descarte a anotar.
pub(crate) struct DiscardEntry<'a> {
    pub title: &'a str,
    pub reason: &'a str,
    pub importance: f32,
    /// Id del original cuando el descarte es por duplicado.
    pub duplicate_of: Option<&'a str>,
    pub candidate_id: Option<&'a str>,
}

/// Anota `entries` en el log de descartes. Silencioso ante cualquier fallo.
pub(crate) fn append_discards(entries: &[DiscardEntry<'_>]) {
    if entries.is_empty() {
        return;
    }
    let Some(path) = discard_log_path() else {
        return;
    };
    append_discards_at(&path, entries, DISCARD_LOG_MAX_BYTES, epoch_secs());
}

fn discard_log_path() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".ultron")
            .join(".tmp")
            .join("capture-discards.jsonl"),
    )
}

/// Núcleo con la ruta, el tope y la hora inyectados (testeable sin HOME).
fn append_discards_at(path: &Path, entries: &[DiscardEntry<'_>], max_bytes: u64, ts: u64) {
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    rotate_if_large(path, max_bytes);
    let mut buf = Vec::new();
    for entry in entries {
        buf.extend_from_slice(entry_json(entry, ts).to_string().as_bytes());
        buf.push(b'\n');
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        // Un solo `write_all`: con escritores concurrentes cada lote queda
        // entero (mismo motivo que `serve/request_log.rs::jsonl_line`).
        let _ = file.write_all(&buf);
    }
}

fn entry_json(entry: &DiscardEntry<'_>, ts: u64) -> serde_json::Value {
    let mut line = serde_json::json!({
        "ts_epoch": ts,
        "title": redact_title(entry.title),
        "reason": entry.reason,
        "importance": entry.importance,
    });
    if let Some(dup) = entry.duplicate_of {
        line["duplicate_of"] = dup.into();
    }
    if let Some(id) = entry.candidate_id {
        line["candidate_id"] = id.into();
    }
    line
}

/// El título sin credenciales ni PII (correo, teléfono, ruta con usuario).
fn redact_title(title: &str) -> String {
    redaction::redact_pii(&redaction::redact(title))
}

/// Rotación de un nivel: pasado el tope, el fichero actual pasa a `.1`
/// (sustituyendo al anterior) y se empieza uno nuevo.
fn rotate_if_large(path: &Path, max_bytes: u64) {
    let too_big = std::fs::metadata(path)
        .map(|m| m.len() > max_bytes)
        .unwrap_or(false);
    if too_big {
        let _ = std::fs::rename(path, path.with_extension("jsonl.1"));
    }
}

fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(title: &str) -> DiscardEntry<'_> {
        DiscardEntry {
            title,
            reason: "paraphrase_dup",
            importance: 0.4,
            duplicate_of: Some("orig-1"),
            candidate_id: Some("cand-1"),
        }
    }

    #[test]
    fn el_titulo_sale_sin_pii_ni_credenciales() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("capture-discards.jsonl");
        let titulo = "escribir a ana.garcia@example.com desde C:\\Users\\cuenta\\x \
                      con ghp_0123456789abcdefghijABCDEFGHIJklmnopqr";
        append_discards_at(&path, &[entry(titulo)], 1024 * 1024, 7);

        let texto = std::fs::read_to_string(&path).unwrap();
        assert!(!texto.contains("ana.garcia@example.com"), "{texto}");
        assert!(!texto.contains("cuenta"), "{texto}");
        assert!(!texto.contains("ghp_0123456789"), "{texto}");
        let linea: serde_json::Value = serde_json::from_str(texto.trim()).unwrap();
        assert_eq!(linea["reason"], "paraphrase_dup");
        assert_eq!(linea["duplicate_of"], "orig-1");
        assert_eq!(linea["ts_epoch"], 7);
    }

    #[test]
    fn rota_a_punto_uno_al_pasar_el_tope() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("capture-discards.jsonl");
        std::fs::write(&path, "x".repeat(200)).unwrap();

        append_discards_at(&path, &[entry("nuevo")], 100, 1);

        let rotado = path.with_extension("jsonl.1");
        assert_eq!(std::fs::read_to_string(&rotado).unwrap().len(), 200);
        let actual = std::fs::read_to_string(&path).unwrap();
        assert_eq!(actual.lines().count(), 1);
        assert!(actual.contains("nuevo"));
    }

    #[test]
    fn por_debajo_del_tope_no_rota() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("capture-discards.jsonl");
        append_discards_at(&path, &[entry("a"), entry("b")], 1024, 1);
        append_discards_at(&path, &[entry("c")], 1024, 2);
        assert!(!path.with_extension("jsonl.1").exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 3);
    }
}
