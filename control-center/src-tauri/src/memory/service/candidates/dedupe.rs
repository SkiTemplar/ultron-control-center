// memory/service/candidates/dedupe.rs — dedupe del write-path y del approve.
//
// Dos detectores complementarios:
//   - EXACTO (`find_exact_duplicate`): mismo `content_hash` + mismo scope +
//     mismo proyecto. Bloquea el write.
//   - NEAR-DUP (`jaccard_overlap` / `find_near_dup_active`): confirma por
//     solapamiento de vocabulario los hits de `search_items` (FTS term-OR).
// El tercero, la PARÁFRASIS (mismo hecho con otras palabras), vive en
// `paraphrase.rs`: ni el hash ni el Jaccard sobre el hit FTS la ven.

use super::super::super::model::{CandidateStatus, MemoryCandidate, MemoryItem, Source, Status};
use super::super::super::sqlite_store as store;
use super::super::super::MemoryError;

/// Solapamiento Jaccard (tokens lowercase >= 3 chars) entre dos textos, en [0,1].
/// El near-dup del write-path lo usa para CONFIRMAR que un hit de search_items
/// (query FTS term-OR, diseñada para recall) es de verdad casi-idéntico. Sin esta
/// confirmación, CUALQUIER candidate que compartiera alguna palabra con los items
/// de más vocabulario del corpus quedaba marcado "duplicate" (2026-07-02: el 100%
/// del inbox llevaba los MISMOS 3 duplicate_candidates, de OTROS proyectos), y
/// como duplicado != clean, el auto-approve no podía disparar jamás. Pure.
pub(crate) fn jaccard_overlap(a: &str, b: &str) -> f32 {
    use std::collections::HashSet;
    let toks = |s: &str| -> HashSet<String> {
        s.split_whitespace()
            .filter(|t| t.chars().count() >= 3)
            .map(str::to_lowercase)
            .collect()
    };
    let (sa, sb) = (toks(a), toks(b));
    // Textos triviales (< 3 tokens) no aportan señal de duplicado.
    if sa.len() < 3 || sb.len() < 3 {
        return 0.0;
    }
    let inter = sa.intersection(&sb).count() as f32;
    let union = sa.union(&sb).count() as f32;
    inter / union
}

/// Umbral de confirmación near-dup: la mitad del vocabulario compartido. Un
/// near-dup real (mismo hecho reformulado) lo supera; dos textos que solo
/// comparten palabras sueltas no.
pub(crate) const NEAR_DUP_JACCARD: f32 = 0.5;

/// PURE (gate anti-dup del approve, 2026-08-10): primer item de `similar` cuyo
/// title+summary confirma near-dup por Jaccard contra `gate_text`. Separada de
/// `approve_candidate` para poder testear el gate sin brain.db.
pub(crate) fn find_near_dup_active(gate_text: &str, similar: &[MemoryItem]) -> Option<String> {
    similar.iter().find_map(|i| {
        let hay = format!(
            "{} {}",
            i.title.as_deref().unwrap_or(""),
            i.summary.as_deref().unwrap_or("")
        );
        (jaccard_overlap(gate_text, &hay) >= NEAR_DUP_JACCARD).then(|| i.id.clone())
    })
}

/// (a) 2026-07-02 — dedupe EXACTO BLOQUEANTE del write-path. Devuelve el id del
/// item ACTIVO o candidato PENDING que ya cubre EXACTAMENTE este contenido
/// (mismo content_hash + mismo scope + mismo project_id), o None. La frontera
/// scope/proyecto es la del hash-dedupe (CONTRACTS §4): un twin en OTRO proyecto
/// es near-dup, no duplicado. Complementa al FTS near-dup (que solo MARCA Merge):
/// sin esto, 4 copias identicas de "Fallo de WebFetch" convivieron en el inbox y
/// "Aceptar todos" las promovio juntas.
pub(crate) fn find_exact_duplicate(
    conn: &rusqlite::Connection,
    cand: &MemoryCandidate,
) -> Result<Option<String>, MemoryError> {
    let probe = cand.to_item(Status::Active, Source::AssistantInferred);
    let probe_text = probe.searchable_text();
    if probe_text.trim().is_empty() {
        return Ok(None);
    }
    let probe_hash = super::super::super::texthash::content_hash(&probe_text);

    // 1) Twin ACTIVO exacto (content_hash indexado — barato).
    if let Some(existing) = store::find_active_by_content_hash(
        conn,
        &probe_hash,
        probe.scope,
        probe.project_id.as_deref(),
    )? {
        return Ok(Some(existing.id));
    }

    // 2) Twin PENDING en el inbox. El pending son decenas como mucho -> scan lineal.
    for pending in store::list_candidates(conn, CandidateStatus::Pending, usize::MAX)? {
        if pending.id == cand.id {
            continue; // recheck idempotente (p.ej. tras edit) no se auto-bloquea
        }
        let p_item = pending.to_item(Status::Active, Source::AssistantInferred);
        if p_item.scope == probe.scope
            && p_item.project_id == probe.project_id
            && super::super::super::texthash::content_hash(&p_item.searchable_text()) == probe_hash
        {
            return Ok(Some(pending.id));
        }
    }
    Ok(None)
}
