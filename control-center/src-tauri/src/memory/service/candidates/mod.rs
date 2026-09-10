// memory/service/candidates/mod.rs — candidate intake (what hooks/agents call)
//
// Troceado 2026-09-10 (cat7.3: el fichero único pasaba de 800 líneas). Mismo
// comportamiento y mismas firmas públicas; solo cambia el reparto:
//   dedupe       — dedupe exacto (content_hash) + near-dup Jaccard (FTS).
//   paraphrase   — gate anti-paráfrasis del write-path (título + coseno E5).
//   discard_log  — rastro jsonl de lo que el write-path descarta.
//   intake       — create_candidate / edit_candidate / list_pending_candidates.
//   reverify     — reverify_candidate (drain --auto) + persistencia condicional.
//   approval     — approve_candidate / reject_candidate (+ variantes `_on`).
// Aquí quedan solo los helpers compartidos por varios de esos módulos.

use rusqlite::Connection;

use super::super::model::MemoryCandidate;
use super::super::MemoryError;

mod approval;
mod dedupe;
mod discard_log;
mod intake;
mod paraphrase;
mod reverify;

// Re-exports: `service` (y sus tests) siguen viendo estos símbolos en
// `service::candidates::…`, igual que cuando todo vivía en un solo fichero.
pub(super) use dedupe::{
    find_exact_duplicate, find_near_dup_active, jaccard_overlap, NEAR_DUP_JACCARD,
};

/// Añade un marcador de verificación-incompleta a `tags` (idempotente). Estos
/// marcadores (`auto_approve::UNVERIFIED_TAGS`) hacen `candidate_is_clean` devolver
/// false → FAIL-CLOSED: lo que el write-path no pudo verificar NO se auto-aprueba.
fn mark_unverified(tags: &mut Vec<String>, marker: &str) {
    if !tags.iter().any(|t| t.eq_ignore_ascii_case(marker)) {
        tags.push(marker.to_string());
    }
}

/// Texto concatenado de TODOS los campos del candidato que deben pasar el scan de
/// PII (paridad con la redacción de credenciales, que ya cubre `content_json` y
/// `tags`). Su omisión pre-1.7 dejaba PII en `content_json`/`tags` sin elevar Secret.
pub(super) fn pii_scan_text(cand: &MemoryCandidate) -> String {
    let tags_joined = cand.proposed_tags.join(" ");
    [
        cand.proposed_title.as_deref(),
        cand.proposed_summary.as_deref(),
        cand.proposed_content.as_deref(),
        cand.proposed_content_json.as_deref(),
        cand.proposed_file_path.as_deref(),
        cand.proposed_signature.as_deref(),
        cand.proposed_symbol.as_deref(),
        Some(tags_joined.as_str()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
}

/// Ejecuta `f` dentro de `BEGIN IMMEDIATE … COMMIT` (ROLLBACK si falla). Con
/// IMMEDIATE el escritor toma el lock al entrar, así que "leer estado y
/// escribir según ese estado" no deja hueco a otro proceso (busy_timeout de
/// `open_conn` absorbe la espera). Sobre `&Connection` porque el store expone
/// funciones con esa firma; no anida (SQLite no admite BEGIN dentro de BEGIN).
fn in_immediate_tx<T>(
    conn: &Connection,
    f: impl FnOnce() -> Result<T, MemoryError>,
) -> Result<T, MemoryError> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| MemoryError::RemoteUnavailable(format!("begin immediate: {e}")))?;
    match f() {
        Ok(v) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| MemoryError::RemoteUnavailable(format!("commit: {e}")))?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

// Tests (approve-gate + near-dup) — fichero hermano heredado del split anterior.
#[cfg(test)]
#[path = "../candidates_tests.rs"]
mod tests;
