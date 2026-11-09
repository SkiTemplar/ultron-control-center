// memory/service/candidates/discard_log.rs — rastro de auditoría de lo que el
// gate anti-paráfrasis descarta ANTES del inbox.
//
// El fichero, el esquema por línea, la redacción del título (credenciales y
// PII) y la rotación por tamaño son los de `memory::discard_log`, el único
// escritor del log de descartes, compartido con `memory/capture.rs`. Aquí solo
// se arma la entrada del candidato.
//
// Best-effort: un fallo de logging NUNCA rompe el write-path.

use crate::memory::discard_log::{append_discards, DiscardEntry};
use crate::memory::model::MemoryCandidate;

/// Anota que `cand` se descartó por ser paráfrasis de `duplicate_of`.
pub(super) fn log_paraphrase_discard(cand: &MemoryCandidate, duplicate_of: &str) {
    let title = cand
        .proposed_title
        .as_deref()
        .or(cand.proposed_summary.as_deref())
        .unwrap_or_default();
    append_discards(&[DiscardEntry {
        title,
        reason: "paraphrase_dup",
        importance: cand.importance,
        duplicate_of: Some(duplicate_of),
        candidate_id: Some(&cand.id),
    }]);
}
