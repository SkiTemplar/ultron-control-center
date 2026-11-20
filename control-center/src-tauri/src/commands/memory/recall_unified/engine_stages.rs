// recall_unified/engine_stages.rs — etapas del pipeline de `build_trace_with`.
//
// Submódulo de engine.rs (calidad-rust-4, 2026-10-23): la función tenía 481
// líneas. Cada etapa es el bloque de antes con su comentario de medición. Desde
// el 2026-11-14 el pipeline es solo sparse: las etapas densas (k-NN, fusión con
// el denso y cross-encoder) se retiraron sin cambiar el resultado del camino
// FTS5 que estaba en producción.

use rusqlite::Connection;

use crate::memory::sqlite_store as store;
use crate::memory::{Actor, EventType, MemoryEvent, MemoryService, MemoryType, Scope};

use super::super::pack::{
    diacritic_probe_variants, informative_query_terms, trust_terms_enabled, unknown_terms_dominate,
};
use super::super::types_model::{
    rrf_fuse, DiscardedHit, FusedHit, RecallEntry, AMBIENT_PENALTY, FANOUT_K, RRF_K,
    SPARSE_WIDEN_FACTOR,
};
use super::super::usage::{record_recall_usage, RecallUse};
use super::{ambient_rank_factor, env_knob_f32, env_knob_usize, is_orphan_project_item};

/// Candidatos del sparse y su puntuación RRF ordenada.
pub(super) struct Candidates {
    pub sparse_ids: Vec<String>,
    pub fused: Vec<FusedHit>,
}

/// (1) SPARSE — FTS5/bm25 over ACTIVE items. The pool is widened
/// (`SPARSE_WIDEN_FACTOR`): under a project filter assemble_pack drops the
/// global vault + off-project hits that dominate the BM25 top-30, leaving too
/// few. A wider fanout lets in-project items reach the gate.
fn sparse_search(
    query: &str,
    fanout_k: usize,
    only_type: Option<MemoryType>,
) -> Result<Vec<String>, String> {
    let sparse_fanout = fanout_k * SPARSE_WIDEN_FACTOR;
    let sparse_items = match only_type {
        Some(kind) => MemoryService::search_active_of_type(query, kind, sparse_fanout),
        None => MemoryService::search_active(query, sparse_fanout),
    }
    .map_err(|e| format!("sparse search: {e}"))?;
    Ok(sparse_items.into_iter().map(|it| it.id).collect())
}

/// Orden del pack: score y, en empate, el id, para que el orden sea estable.
fn sort_fused(fused: &mut [FusedHit]) {
    fused.sort_by(|a, b| {
        b.rrf_score
            .partial_cmp(&a.rrf_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.canonical_id.cmp(&b.canonical_id))
    });
}

/// (2) Puntuación RRF del rango BM25 (`1 / (k + rank + 1)`): la escala sobre
/// la que operan el multiplicador de calidad y los factores ambiente/hub.
fn score(sparse_ids: &[String], rrf_k: f32) -> Vec<FusedHit> {
    let rank_of: std::collections::HashMap<&str, usize> = sparse_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let mut fused: Vec<FusedHit> = rrf_fuse(&[sparse_ids.to_vec()], rrf_k)
        .into_iter()
        .map(|(id, score)| FusedHit {
            sparse_rank: rank_of.get(id.as_str()).copied(),
            canonical_id: id,
            rrf_score: score,
        })
        .collect();
    sort_fused(&mut fused);
    fused
}

/// Etapas (1)-(2): sparse y puntuación. Knobs tuneables por env para el A/B
/// (default = consts).
pub(super) fn retrieve_and_score(
    query: &str,
    only_type: Option<MemoryType>,
) -> Result<Candidates, String> {
    let fanout_k = env_knob_usize("ULTRON_FANOUT_K", FANOUT_K);
    let rrf_k = env_knob_f32("ULTRON_RRF_K", RRF_K);
    let sparse_ids = sparse_search(query, fanout_k, only_type)?;
    let fused = score(&sparse_ids, rrf_k);
    Ok(Candidates { sparse_ids, fused })
}

/// Multiplicador de calidad por confianza: rrf_score' = rrf_score * (1 + 0.6 *
/// confidence), con castigo suave (×0.9) por debajo de 0.6.
///   - confidence = 1.0  → ×1.60  (validated knowledge)
///   - confidence = 0.8  → ×1.48  (good codebase_fact)
///   - confidence = 0.6  → ×1.36  (typical real capture)
///   - confidence = 0.5  → ×1.17  (imported_vault default — soft penalty ×0.9 active)
fn confidence_factor(confidence: f32) -> f32 {
    if confidence >= 0.6 {
        1.0 + 0.6 * confidence
    } else {
        // Soft penalty for low-confidence items (generic imports).
        (1.0 + 0.6 * confidence) * 0.9
    }
}

/// Items actualizados en los últimos 7 días suben ×1.05, para que el vault
/// rancio no tape las capturas frescas.
fn recency_factor(now_ms: i64, updated_at: i64) -> f32 {
    const SEVEN_DAYS_MS: i64 = 7 * 24 * 60 * 60 * 1000;
    if now_ms - updated_at < SEVEN_DAYS_MS {
        1.05_f32
    } else {
        1.0_f32
    }
}

/// Pilar 1 — quality re-ranker: apply a confidence-based multiplier to each
/// scored hit so that codebase_fact / decision items (confidence 0.6–0.95) rise
/// above imported_vault bulk noise (confidence 0.5 default). A soft penalty
/// discourages generic imports without hard-filtering them (vault gate in
/// assemble_pack handles the bulk case). The RRF K-damping (60) already keeps
/// differences modest; this multiplier only reorders near-ties and
/// equal-relevance bands.
///
/// (2026-07-13) Down-rank AMBIENTE: ver ambient_rank_factor + AMBIENT_PENALTY.
/// (2026-08-11, decidido por el usuario; activado tras backfill-projects
/// --apply: 782→639 huerfanos) scope=Project SIN project_id es atribucion
/// ilegal (bug del write-path corregido en capture): bajo filtro de proyecto
/// se EXCLUYE del pack — se colaba como comodin en cualquier proyecto. En
/// cross-project (cerebro entero) sigue visible; el ambiente Session/Agent
/// mantiene solo el down-rank del 07-13. (2026-09-23) Hubs: items que el
/// recall en crudo inyecta en una fracción alta de prompts sin relación (ver
/// hubs.rs).
pub(super) fn apply_quality_factors(
    conn: &Connection,
    fused: &mut Vec<FusedHit>,
    project_id: Option<&str>,
    cross_project: bool,
) {
    let now_ms = crate::memory::model::now_millis();
    let ambient_penalty = env_knob_f32("ULTRON_AMBIENT_PENALTY", AMBIENT_PENALTY);
    let hub_penalty = super::super::hubs::hub_penalty();
    fused.retain_mut(|hit| {
        let (confidence, updated_at, item_project, item_scope) =
            store::get_item(conn, &hit.canonical_id)
                .ok()
                .flatten()
                .map(|it| (it.confidence, it.updated_at, it.project_id, it.scope))
                .unwrap_or((0.5, 0, None, Scope::Global)); // unknown → vault-level, sin castigo doble
        if is_orphan_project_item(
            project_id,
            cross_project,
            item_project.as_deref(),
            item_scope,
        ) {
            return false;
        }
        let ambient = ambient_rank_factor(
            project_id,
            cross_project,
            item_project.as_deref(),
            item_scope,
            ambient_penalty,
        );
        let hub = super::super::hubs::hub_factor(&hit.canonical_id, hub_penalty);
        hit.rrf_score *=
            confidence_factor(confidence) * recency_factor(now_ms, updated_at) * ambient * hub;
        true
    });
    // Re-sort after quality adjustment.
    sort_fused(fused);
}

/// Pack en curso tras `assemble_pack`, al que se aplican los gates.
pub(super) struct PackGates {
    pub injected: Vec<RecallEntry>,
    pub discarded: Vec<DiscardedHit>,
    pub total_tokens: i64,
    pub warnings: Vec<String>,
}

impl PackGates {
    /// Vacía el pack entero dejando cada entrada en `discarded` con `reason`.
    fn abstain_all(&mut self, reason: &str) {
        for e in self.injected.drain(..) {
            self.discarded.push(DiscardedHit {
                canonical_id: e.canonical_id,
                reason: reason.to_string(),
            });
        }
        self.total_tokens = 0;
    }

    /// (c trust gate, 2026-07-02) COBERTURA DE TÉRMINOS: si la query trae
    /// términos informativos con CERO documentos en el corpus, inyectar vecinos
    /// temáticos es alucinar contexto (near-miss "AWS"). Fail-open si el FTS
    /// falla (gate de honestidad, no de seguridad). ULTRON_TRUST_TERMS=off lo
    /// desactiva. (2026-08-16) Decide `unknown_terms_dominate` sobre todos los
    /// desconocidos, no el primero: un `venga` o el id de una tarjeta vaciaba el
    /// pack (412/670 packs medidos).
    pub fn abstain_on_unknown_terms(&mut self, query: &str) {
        if self.injected.is_empty() || !trust_terms_enabled() {
            return;
        }
        let terms = informative_query_terms(query);
        let unknown: Vec<String> = terms
            .iter()
            .filter(|t| term_unknown_with_variants(t))
            .cloned()
            .collect();
        if !unknown_terms_dominate(terms.len(), unknown.len()) {
            return;
        }
        let lista = unknown.join("', '");
        self.abstain_all(&format!(
            "abstain: término(s) desconocido(s) para el corpus ('{lista}')"
        ));
        self.warnings.push(format!(
            "recall abstained — el corpus no conoce '{lista}' ({}/{} términos de la query)",
            unknown.len(),
            terms.len()
        ));
    }
}

/// df=0 para el término. Fail-open: un error del FTS no es un término
/// desconocido.
fn term_is_unknown(term: &str) -> bool {
    MemoryService::search_active(term, 1)
        .map(|v| v.is_empty())
        .unwrap_or(false)
}

/// (2026-07-22) Diacriticos: el fallback LIKE del sparse (build sin FTS5)
/// compara bytes — 'simbolos' NO matchea un corpus con 'símbolos' y el gate
/// abstenia en falso (gs-0017). Solo df=0 en TODAS las variantes de tilde/ñ
/// confirma que el corpus no sabe de eso.
fn term_unknown_with_variants(term: &str) -> bool {
    term_is_unknown(term)
        && diacritic_probe_variants(term)
            .iter()
            .all(|v| term_is_unknown(v))
}

/// Avisos de contexto del recall: cross-project y candidatos pendientes del
/// inbox.
pub(super) fn context_warnings(
    warnings: &mut Vec<String>,
    project_id: Option<&str>,
    cross_project: bool,
) {
    if cross_project && project_id.is_some() {
        warnings.push(
            "cross-project recall — project filter relaxed (Secret still excluded)".to_string(),
        );
    }
    if let Ok(stats) = MemoryService::stats() {
        if stats.candidates_pending > 0 {
            warnings.push(format!(
                "{} memory candidate(s) await validation in the inbox",
                stats.candidates_pending
            ));
        }
    }
}

/// Audit: evento Retrieved compacto. Telemetria de utilidad (2026-08-28): lo
/// que entra en el pack queda marcado como inyectado, salvo en los recalls de
/// diagnostico (doctor, evals, trace, hubs), que no pueden falsear el
/// decaimiento del GC. Devuelve el aviso de `record_recall_usage`, si lo hay.
pub(super) fn record_retrieved(
    conn: &Connection,
    usage: RecallUse,
    query: &str,
    candidates: &Candidates,
    gates: &PackGates,
    lazy_load_ids: &[String],
) -> Option<String> {
    let ev = MemoryEvent::new(EventType::Retrieved, None, Actor::System)
        .with_reason(format!(
            "recall '{query}' -> {} injected / {} fused",
            gates.injected.len(),
            candidates.fused.len()
        ))
        .with_after(
            serde_json::json!({
                "query": query,
                "injected_ids": lazy_load_ids,
                "total_tokens": gates.total_tokens,
                "sparse_hits": candidates.sparse_ids.len(),
            })
            .to_string(),
        );
    record_recall_usage(conn, usage, &ev, lazy_load_ids)
}
