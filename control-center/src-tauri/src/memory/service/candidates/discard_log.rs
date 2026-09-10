// memory/service/candidates/discard_log.rs — rastro de auditoría de lo que el
// write-path descarta ANTES del inbox.
//
// Escribe en el MISMO fichero y con el mismo esquema por línea que
// `memory/capture.rs::log_discards` (`~/.ultron/.tmp/capture-discards.jsonl`:
// `ts_epoch`, `title`, `reason`, `importance`), más `duplicate_of` con el id del
// original. Un solo fichero para revisar falsos positivos: quien audita los
// descartes de captura ve también los del gate anti-paráfrasis sin abrir otro
// log. La función de capture.rs es privada de ese módulo y su lista de
// `Discard` no existe aquí, así que el escritor se repite; el esquema no.
//
// Best-effort en todos los pasos: un fallo de logging NUNCA rompe el write-path.

use std::io::Write;

use crate::memory::model::MemoryCandidate;

/// Anota que `cand` se descartó por ser paráfrasis de `duplicate_of`.
pub(super) fn log_paraphrase_discard(cand: &MemoryCandidate, duplicate_of: &str) {
    let title = cand
        .proposed_title
        .clone()
        .or_else(|| cand.proposed_summary.clone())
        .unwrap_or_default();
    append_line(&serde_json::json!({
        "ts_epoch": epoch_secs(),
        "title": title,
        "reason": "paraphrase_dup",
        "importance": cand.importance,
        "duplicate_of": duplicate_of,
        "candidate_id": cand.id,
    }));
}

fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Append de una línea JSON al log de descartes. Silencioso ante cualquier
/// fallo de disco (mismo contrato que el logger de captura).
fn append_line(line: &serde_json::Value) {
    let Some(home) = dirs::home_dir() else { return };
    let dir = home.join(".ultron").join(".tmp");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("capture-discards.jsonl"))
    else {
        return;
    };
    let _ = writeln!(file, "{line}");
}
