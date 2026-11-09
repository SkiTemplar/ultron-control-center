// recall_unified/engine_stages.rs — etapas del pipeline de `build_trace_with`.
//
// Submódulo de engine.rs (calidad-rust-4, 2026-10-23): la función tenía 481
// líneas. Cada etapa es el bloque de antes con su comentario de medición, sin
// cambios de comportamiento salvo el fallback del cross-encoder, que deja un
// `tracing::warn!` en vez de un `eprintln!` que en la GUI no veía nadie.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::memory::qdrant_index;
use crate::memory::sqlite_store as store;
use crate::memory::{Actor, EventType, MemoryEvent, MemoryService, MemoryType, Scope};

use super::super::pack::{
    diacritic_probe_variants, informative_query_terms, trust_terms_enabled, unknown_terms_dominate,
};
use super::super::types_model::{
    dense_empty_warning, DiscardedHit, FusedHit, RecallEntry, AMBIENT_PENALTY, FANOUT_K,
    FANOUT_K_QUALITY, RRF_K,
};
use super::super::usage::{record_recall_usage, RecallUse};
use super::{
    ambient_rank_factor, env_knob_f32, env_knob_usize, is_orphan_project_item,
    pack_has_confident_signal, prune_margin, recall_floor, PRUNE_KEEP_MIN, STRONG_SPARSE_RANK,
};
use crate::commands::memory::recall_unified::rrf_fuse_weighted;

/// Candidatos de las dos fuentes y su fusión RRF ordenada.
pub(super) struct Candidates {
    pub dense_ids: Vec<String>,
    pub sparse_ids: Vec<String>,
    pub fused: Vec<FusedHit>,
}

/// (1) DENSE — E5 query embedding + Qdrant filtered k-NN. Empty if offline,
/// OR skipped when dense_enabled=false. OJO: desde la política quality-first
/// (2026-06-19) el hook UserPromptSubmit TAMBIÉN corre híbrido (dense=true vía
/// daemon/CLI); `false` queda como modo de degradación (E5/Qdrant caídos) o
/// para callers que sacrifiquen calidad por latencia. El embed E5 del query
/// cuesta ~0.3-1 s warm. Score-aware (B1): keep the cosine similarity to
/// break RRF ties.
fn dense_search(
    query: &str,
    fanout_k: usize,
    project_id: Option<&str>,
    cross_project: bool,
    dense_enabled: bool,
    only_type: Option<MemoryType>,
) -> Vec<(String, f32)> {
    if !dense_enabled {
        return Vec::new();
    }
    // Dense (Qdrant) project filter: drop it in cross-project mode so the
    // k-NN is not pre-restricted to the current project at the index level.
    let dense_project = if cross_project { None } else { project_id };
    qdrant_index::search_dense_scored_typed(
        query,
        fanout_k as u32,
        dense_project,
        only_type.map(|t| t.as_str()),
    )
}

/// (2) SPARSE — FTS5/bm25 over ACTIVE items. When dense is OFF (modo
/// degradación) we widen the pool: the dense Qdrant project-filter that
/// normally surfaces in-project items is gone, and under a project filter
/// assemble_pack drops the global vault + off-project hits that dominate the
/// BM25 top-30, leaving too few. A wider fanout lets in-project items reach
/// the gate. Quality callers keep the tight FANOUT_K (dense covers them).
/// (2026-08-10) dense ON pero VACÍO (Qdrant caído / colección ausente / E5
/// sin modelo) es la MISMA degradación: sin ensanche, el modo sparse
/// "existente" nunca se activaba con dense_enabled=true (audit 08-09).
fn sparse_search(
    query: &str,
    fanout_k: usize,
    dense_covers: bool,
    only_type: Option<MemoryType>,
) -> Result<Vec<String>, String> {
    let sparse_fanout = if dense_covers {
        fanout_k
    } else {
        fanout_k * 12
    };
    let sparse_items = match only_type {
        Some(kind) => MemoryService::search_active_of_type(query, kind, sparse_fanout),
        None => MemoryService::search_active(query, sparse_fanout),
    }
    .map_err(|e| format!("sparse search: {e}"))?;
    Ok(sparse_items.into_iter().map(|it| it.id).collect())
}

/// Orden del pack fusionado: score, después coseno denso (B1: rank-pure RRF
/// produce muchos empates y el coseno devuelve una señal continua) y por
/// último el id, para que el orden sea estable.
fn sort_fused(fused: &mut [FusedHit]) {
    fused.sort_by(|a, b| {
        b.rrf_score
            .partial_cmp(&a.rrf_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.dense_score
                    .unwrap_or(0.0)
                    .partial_cmp(&a.dense_score.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.canonical_id.cmp(&b.canonical_id))
    });
}

/// (3) RRF fusion + dedup by canonical_id; cosine similarity carried for
/// tie-break. (cat1 ranking) Fusión PONDERADA: dense (E5) puede pesar sobre
/// sparse (BM25, ruidoso con stopwords). Default 0.8: ganador del sweep de 20
/// configs (2026-07-22, oraculo golden 29 queries): 0.749 vs 0.704-0.721 con
/// 1.0; 0.7 y 0.6 empeoran (0.708/0.631) — el sparse acierta claims literales
/// que el dense entierra (gs-0007), pero quitarle mas peso al dense pierde
/// recall semantico neto.
fn fuse(dense_scored: &[(String, f32)], sparse_ids: &[String], rrf_k: f32) -> Vec<FusedHit> {
    let dense_ids: Vec<String> = dense_scored.iter().map(|(id, _)| id.clone()).collect();
    let dense_score: HashMap<&str, f32> = dense_scored
        .iter()
        .map(|(id, s)| (id.as_str(), *s))
        .collect();
    let rank_of = |ids: &[String]| -> HashMap<String, usize> {
        ids.iter()
            .enumerate()
            .map(|(i, id)| (id.clone(), i))
            .collect()
    };
    let dense_rank = rank_of(&dense_ids);
    let sparse_rank = rank_of(sparse_ids);
    let dense_w = env_knob_f32("ULTRON_DENSE_W", 0.8);
    let mut fused: Vec<FusedHit> =
        rrf_fuse_weighted(&[(dense_ids, dense_w), (sparse_ids.to_vec(), 1.0)], rrf_k)
            .into_iter()
            .map(|(id, score)| FusedHit {
                dense_rank: dense_rank.get(&id).copied(),
                sparse_rank: sparse_rank.get(&id).copied(),
                dense_score: dense_score.get(id.as_str()).copied(),
                canonical_id: id,
                rrf_score: score,
            })
            .collect();
    sort_fused(&mut fused);
    fused
}

/// Etapas (1)-(3): denso, sparse y fusión.
///
/// Knobs tuneables por env para el A/B (default = consts). Fanout partido por
/// intencion del caller (2026-07-22): `rerank` distingue el path de CALIDAD
/// (evals/CLI/trace, tolera segundos) del hot path del hook (rerank=false,
/// p50 134 ms) — el fanout hondo solo se paga donde el coste no importa.
/// ULTRON_FANOUT_K sigue mandando sobre AMBOS si esta set.
pub(super) fn retrieve_and_fuse(
    query: &str,
    project_id: Option<&str>,
    cross_project: bool,
    dense_enabled: bool,
    rerank: bool,
    only_type: Option<MemoryType>,
) -> Result<Candidates, String> {
    let fanout_default = if rerank { FANOUT_K_QUALITY } else { FANOUT_K };
    let fanout_k = env_knob_usize("ULTRON_FANOUT_K", fanout_default);
    let rrf_k = env_knob_f32("ULTRON_RRF_K", RRF_K);
    let dense_scored = dense_search(
        query,
        fanout_k,
        project_id,
        cross_project,
        dense_enabled,
        only_type,
    );
    let dense_covers = dense_enabled && !dense_scored.is_empty();
    let sparse_ids = sparse_search(query, fanout_k, dense_covers, only_type)?;
    let fused = fuse(&dense_scored, &sparse_ids, rrf_k);
    Ok(Candidates {
        dense_ids: dense_scored.into_iter().map(|(id, _)| id).collect(),
        sparse_ids,
        fused,
    })
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
/// fused hit so that codebase_fact / decision items (confidence 0.6–0.95) rise
/// above imported_vault bulk noise (confidence 0.5 default). A soft penalty
/// discourages generic imports without hard-filtering them (vault gate in
/// assemble_pack handles the bulk case). The RRF K-damping (60) already keeps
/// differences modest when relevance scores differ a lot; this multiplier
/// only reorders near-ties and equal-relevance bands.
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
    // Re-sort after quality adjustment (preserves dense_score as final tie-break).
    sort_fused(fused);
}

/// 2026-09-06: 48 -> 24. Medido sobre el golden v2 (30 prompts reales, con
/// proyecto): nDCG@8 0.636 -> 0.626 y recall@8 0.827 -> 0.818, a cambio de
/// 5.5 s -> 2.7 s por turno bug_fix en el hot path. Decidido tras ver la
/// latencia real, no la estimada.
const RERANK_TOP_N: usize = 24;

/// Pares (id, texto) para el cross-encoder. Items cuyo texto no se resuelve
/// (fallo del store o sin summary/title) se omiten; reciben NEG_INFINITY en la
/// reordenación y bajan dentro del bloque top-N, lo que es aceptable. Se usa
/// el summary (la forma que se inyecta), con el título de respaldo. (cat1
/// 2026-07-03 MEDIDO: enriquecer con content recortado EMPEORA — recall@8
/// 0.709→0.657 — el content diluye la senal del summary conciso. No "mejorar".)
fn rerank_pairs_for(conn: &Connection, top: &[FusedHit]) -> Vec<(String, String)> {
    top.iter()
        .filter_map(|hit| {
            store::get_item(conn, &hit.canonical_id)
                .ok()
                .flatten()
                .map(|it| {
                    let text = it.summary.or(it.title).unwrap_or_default();
                    (hit.canonical_id.clone(), text)
                })
        })
        .collect()
}

/// Pilar 1 — cross-encoder re-ranker. Takes the top RERANK_TOP_N candidates
/// AFTER the heuristic quality sort and re-orders them by BGERerankerV2M3
/// cross-encoder score. Candidates beyond RERANK_TOP_N keep their position.
/// Only the ORDER changes; canonical_id / dense_score are untouched.
///
/// Apagado (`rerank=false` o ULTRON_RERANK=0): `fused` queda IDÉNTICO al orden
/// heurístico — el invariante del A/B. Un error del cross-encoder se registra
/// y conserva el orden: el recall NO falla porque falte el re-ranker.
///
/// (cat1 2026-07-03, subido 2026-07-22) N tuneable por env para el A/B: el
/// diagnostico del golden situo relevantes cortados hasta fused rank 56. (2026-
/// 08-16) Desde el rerank selectivo un prompt tecnico del hook entra aqui con
/// el modelo caliente; lo que nunca ocurre en el hot path es CARGARLO.
pub(super) fn cross_encoder_rerank(
    conn: &Connection,
    query: &str,
    rerank: bool,
    fused: &mut [FusedHit],
) {
    if !(rerank && crate::qdrant::reranker_enabled()) {
        return;
    }
    let top_n_len = env_knob_usize("ULTRON_RERANK_TOP_N", RERANK_TOP_N).min(fused.len());
    let pairs = rerank_pairs_for(conn, &fused[..top_n_len]);
    // En el daemon, el re-rank espera su turno de inferencia (FIFO, sin
    // descartar por contención) y solo se abandona ante un cuelgue real del
    // cómputo (`RERANK_HANG_TIMEOUT`, 2026-09-27). Fuera de él (eval, trace,
    // one-shot) no hay hook que proteger y se espera sin techo: con el antiguo
    // tope de 3,5 s el eval del golden cortaba el rerank en las 13 queries del
    // v3 (2026-09-23).
    let reranked = if crate::daemon_client::is_in_daemon() {
        crate::qdrant::rerank_pairs_bounded(query, &pairs)
    } else {
        crate::qdrant::rerank_pairs(query, &pairs)
    };
    match reranked {
        Ok(ranked) => {
            let score: HashMap<&str, f32> =
                ranked.iter().map(|(id, s)| (id.as_str(), *s)).collect();
            let of = |h: &FusedHit| {
                score
                    .get(h.canonical_id.as_str())
                    .copied()
                    .unwrap_or(f32::NEG_INFINITY)
            };
            // Re-sort ONLY the top-N slice; the tail keeps its position.
            fused[..top_n_len].sort_by(|a, b| {
                of(b)
                    .partial_cmp(&of(a))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        Err(e) => tracing::warn!(error = %e, "reranker fallback (order unchanged)"),
    }
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

    /// (floor) 2026-07-02 — abstención a nivel de PACK: si NINGUNA entrada trae
    /// señal de confianza (ni dense >= floor ni sparse fuerte), el pack se vacía
    /// en vez de inyectar relleno como contexto. Complementa SPARSE_TAIL_CUTOFF
    /// (que poda la cola léxica ENTRADA a entrada): esto cubre la query
    /// INCONTESTABLE donde todo el pack es cola. memory-bench abstain_empty era
    /// 0/3 sin esto. Auditable: cada entrada vaciada queda en `discarded` y el
    /// pack lleva warning (mandamiento 11: nada de no-ops silenciosos).
    pub fn abstain_without_signal(&mut self) {
        let Some(floor) = recall_floor() else {
            return;
        };
        if self.injected.is_empty() || pack_has_confident_signal(&self.injected, floor) {
            return;
        }
        self.abstain_all(&format!("abstain: sin señal de confianza (floor {floor})"));
        self.warnings.push(format!(
            "recall abstained — ninguna entrada con dense >= {floor} ni sparse fuerte"
        ));
    }

    /// (margen) 2026-08-13 — PODA POR MARGEN, entrada a entrada, relativa al
    /// MEJOR dense del propio pack (los dense reales se apiñan en 0.79-0.82).
    /// Se conservan siempre las PRUNE_KEEP_MIN primeras y lo podado queda en
    /// `discarded` con su razón. OFF por veredicto medido (ver `prune_margin`).
    pub fn prune_by_margin(&mut self) {
        if self.injected.len() <= PRUNE_KEEP_MIN {
            return;
        }
        let Some(margin) = prune_margin() else {
            return;
        };
        let best_dense = self
            .injected
            .iter()
            .filter_map(|e| e.dense_score)
            .fold(f32::NEG_INFINITY, f32::max);
        if !best_dense.is_finite() {
            return;
        }
        let cutoff = best_dense - margin;
        let mut kept: Vec<RecallEntry> = Vec::with_capacity(self.injected.len());
        let mut pruned = 0usize;
        for (idx, e) in std::mem::take(&mut self.injected).into_iter().enumerate() {
            let strong_sparse = e.sparse_rank.is_some_and(|r| r <= STRONG_SPARSE_RANK);
            let dense_ok = e.dense_score.is_some_and(|s| s >= cutoff);
            if idx < PRUNE_KEEP_MIN || dense_ok || strong_sparse {
                kept.push(e);
                continue;
            }
            pruned += 1;
            self.total_tokens = self.total_tokens.saturating_sub(e.token_estimate.max(0));
            self.discarded.push(DiscardedHit {
                reason: format!(
                    "poda por margen: dense {:.3} < cutoff {cutoff:.3}",
                    e.dense_score.unwrap_or(0.0)
                ),
                canonical_id: e.canonical_id,
            });
        }
        self.injected = kept;
        if pruned > 0 {
            self.warnings.push(format!(
                "poda por margen: {pruned} entrada(s) fuera (cutoff {cutoff:.3})"
            ));
        }
    }

    /// (c trust gate, 2026-07-02) COBERTURA DE TÉRMINOS: si la query trae
    /// términos informativos con CERO documentos en el corpus, inyectar vecinos
    /// temáticos es alucinar contexto (near-miss "AWS": dense 0.8503 de puro
    /// tema ULTRON). Fail-open si el FTS falla (gate de honestidad, no de
    /// seguridad). ULTRON_TRUST_TERMS=off lo desactiva. (2026-08-16) Decide
    /// `unknown_terms_dominate` sobre todos los desconocidos, no el primero: un
    /// `venga` o el id de una tarjeta vaciaba el pack (412/670 packs medidos).
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

/// Avisos de contexto del recall: cross-project, denso vacío y candidatos
/// pendientes del inbox.
pub(super) fn context_warnings(
    warnings: &mut Vec<String>,
    project_id: Option<&str>,
    cross_project: bool,
    dense_enabled: bool,
    dense_hits: usize,
) {
    if cross_project && project_id.is_some() {
        warnings.push(
            "cross-project recall — project filter relaxed (Secret still excluded)".to_string(),
        );
    }
    let global_dense = crate::qdrant::dense_enabled();
    if let Some(w) = dense_empty_warning(dense_enabled, global_dense, dense_hits) {
        warnings.push(w);
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
                "dense_hits": candidates.dense_ids.len(),
                "sparse_hits": candidates.sparse_ids.len(),
            })
            .to_string(),
        );
    record_recall_usage(conn, usage, &ev, lazy_load_ids)
}
