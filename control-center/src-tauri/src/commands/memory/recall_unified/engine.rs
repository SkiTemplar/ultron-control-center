// recall_unified/engine.rs — assemble_pack, build_trace, recall_pack.
//
// `assemble_pack`: pure governance filter over a pre-fused candidate list.
//    Unit-testable without Qdrant/E5.
// `build_trace`: full hybrid recall pipeline (dense + sparse + RRF + quality
//    re-ranker), returns the Retrieval Inspector trace. Each call gets the full
//    per-call token cap — no cumulative per-session budget.
// `recall_pack`: thin wrapper over `build_trace` that returns the compact pack.

use std::collections::HashMap;

use crate::memory::qdrant_index;
use crate::memory::sqlite_store as store;
use crate::memory::{Actor, EventType, MemoryEvent, MemoryService, Scope};

use super::types_model::{
    DiscardedHit, FusedHit, RecallEntry, RecallPack, RecallTrace, AMBIENT_PENALTY, FANOUT_K,
    FANOUT_K_QUALITY, PER_CALL_TOKEN_CAP, RRF_K,
};
use crate::commands::memory::recall_unified::rrf_fuse_weighted;

use super::pack::{
    assemble_pack, diacritic_probe_variants, informative_query_terms, trust_terms_enabled,
};

/// Core hybrid recall + full trace (Retrieval Inspector). Synchronous; both the
/// compact `recall` and the verbose `recall_inspect` derive from this so there is
/// ONE retrieval path. Global-scope items bypass the project filter (they apply
/// everywhere). Emits a `Retrieved` audit event.
///
/// CROSS-PROJECT: when `cross_project` is true the dense (Qdrant) k-NN is run
/// WITHOUT the `project_id` payload filter and the project-equality gate in
/// `assemble_pack` is relaxed, so the recall searches the WHOLE brain across
/// projects. Security is untouched: Secret items are still excluded downstream.
///
/// PER-CALL TOKEN CAP: every recall receives the full `PER_CALL_TOKEN_CAP` —
/// there is NO cumulative per-session budget, so the memory is never silenced
/// mid-session (the old accumulator starved every query after the first few).
///
/// RERANK (cat1 2026-07-03, split MEDIDO): `rerank=true` re-ordena el top-N
/// fusionado con el cross-encoder BGE-v2-m3 (recall@8 0.682→0.709, p@3
/// 0.379→0.483 contra el oráculo golden) a un coste de ~2-2.4 s por llamada en
/// CPU (24 pares, 568M params). Los callers de CALIDAD (recall CLI/browser,
/// trace, evals) pasan `true`; el hot path del hook UserPromptSubmit pasa
/// `false` (p50 134 ms — 19× menos; +2.7 pts de recall no pagan 2.5 s en CADA
/// prompt) salvo opt-in `ULTRON_RERANK_HOT=1`. `ULTRON_RERANK=0` lo apaga
/// GLOBALMENTE (restaura el baseline byte-a-byte, verificado e2e).
pub fn build_trace(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    dense_enabled: bool,
    rerank: bool,
) -> Result<RecallTrace, String> {
    // (1) DENSE — E5 query embedding + Qdrant filtered k-NN. Empty if offline,
    //     OR skipped when dense_enabled=false. OJO: desde la política
    //     quality-first (2026-06-19) el hook UserPromptSubmit TAMBIÉN corre
    //     híbrido (dense=true vía daemon/CLI); `false` queda como modo de
    //     degradación (E5/Qdrant caídos) o para callers que sacrifiquen
    //     calidad por latencia. El embed E5 del query cuesta ~0.3-1 s warm.
    //     Score-aware (B1): keep the cosine similarity to break RRF ties.
    // (cat1 ranking) knobs tuneables por env para el A/B (default = consts).
    // Fanout partido por intencion del caller (2026-07-22): `rerank` distingue
    // el path de CALIDAD (evals/CLI/trace, tolera segundos) del hot path del
    // hook (rerank=false, p50 134 ms) — el fanout hondo solo se paga donde el
    // coste no importa. ULTRON_FANOUT_K sigue mandando sobre AMBOS si esta set.
    let fanout_default = if rerank { FANOUT_K_QUALITY } else { FANOUT_K };
    let fanout_k = env_knob_usize("ULTRON_FANOUT_K", fanout_default);
    let rrf_k = env_knob_f32("ULTRON_RRF_K", RRF_K);
    let dense_scored = if dense_enabled {
        // Dense (Qdrant) project filter: drop it in cross-project mode so the
        // k-NN is not pre-restricted to the current project at the index level.
        let dense_project = if cross_project { None } else { project_id };
        qdrant_index::search_dense_scored(query, fanout_k as u32, dense_project)
    } else {
        Vec::new()
    };
    let dense_ids: Vec<String> = dense_scored.iter().map(|(id, _)| id.clone()).collect();
    let dense_score_map: HashMap<&str, f32> = dense_scored
        .iter()
        .map(|(id, s)| (id.as_str(), *s))
        .collect();
    // (2) SPARSE — FTS5/bm25 over ACTIVE items. When dense is OFF (modo
    //     degradación) we widen the pool: the dense Qdrant project-filter that
    //     normally surfaces in-project items is gone, and under a project filter
    //     assemble_pack drops the global vault + off-project hits that dominate
    //     the BM25 top-30, leaving too few. A wider fanout lets in-project items
    //     reach the gate. Quality callers keep the tight FANOUT_K (dense covers them).
    let sparse_fanout = if dense_enabled {
        fanout_k
    } else {
        fanout_k * 12
    };
    let sparse_items = MemoryService::search_active(query, sparse_fanout)
        .map_err(|e| format!("sparse search: {e}"))?;
    let sparse_ids: Vec<String> = sparse_items.iter().map(|it| it.id.clone()).collect();

    let dense_rank: HashMap<&str, usize> = dense_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let sparse_rank: HashMap<&str, usize> = sparse_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    // (3) RRF fusion + dedup by canonical_id; cosine similarity carried for tie-break.
    // (cat1 ranking) Fusión PONDERADA: dense (E5) puede pesar sobre sparse (BM25,
    // ruidoso con stopwords). ULTRON_DENSE_W default 1.0 = comportamiento clásico.
    let dense_w = env_knob_f32("ULTRON_DENSE_W", 1.0);
    let mut fused: Vec<FusedHit> = rrf_fuse_weighted(
        &[(dense_ids.clone(), dense_w), (sparse_ids.clone(), 1.0)],
        rrf_k,
    )
    .into_iter()
    .map(|(id, score)| FusedHit {
        dense_rank: dense_rank.get(id.as_str()).copied(),
        sparse_rank: sparse_rank.get(id.as_str()).copied(),
        dense_score: dense_score_map.get(id.as_str()).copied(),
        canonical_id: id,
        rrf_score: score,
    })
    .collect();
    // B1: tie-break equal RRF scores by REAL cosine similarity. Rank-pure RRF
    // produces many ties; the dense cosine restores a continuous quality signal
    // (the full reranker lands in Ola 4).
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

    // Pilar 1 — quality re-ranker: apply a confidence-based multiplier to each
    // fused hit so that codebase_fact / decision items (confidence 0.6–0.95) rise
    // above imported_vault bulk noise (confidence 0.5 default).
    //
    // Formula: rrf_score' = rrf_score * (1 + 0.6 * confidence)
    //   - confidence = 1.0  → ×1.60  (validated knowledge)
    //   - confidence = 0.8  → ×1.48  (good codebase_fact)
    //   - confidence = 0.6  → ×1.36  (typical real capture)
    //   - confidence = 0.5  → ×1.17  (imported_vault default — soft penalty ×0.9 active)
    //
    // A soft penalty for confidence < 0.6 (×0.9 factor) discourages generic imports
    // without hard-filtering them (vault gate in assemble_pack handles the bulk case).
    //
    // Recency boost (optional): items updated in the last 7 days get a modest ×1.05
    // lift so stale vault items don't crowd out fresh captures.
    //
    // The RRF K-damping (60) already keeps differences modest when relevance scores
    // differ a lot; this multiplier only reorders near-ties and equal-relevance bands.
    //
    // Single connection reuse: the same `conn` opened here feeds both the quality
    // re-ranker loop and assemble_pack below, avoiding a second open_conn call.
    let conn = store::open_conn().map_err(|e| format!("open brain.db: {e}"))?;
    {
        let now_ms = crate::memory::model::now_millis();
        const SEVEN_DAYS_MS: i64 = 7 * 24 * 60 * 60 * 1000;
        // (2026-07-13) Down-rank AMBIENTE: ver ambient_rank_factor + AMBIENT_PENALTY.
        let ambient_penalty = env_knob_f32("ULTRON_AMBIENT_PENALTY", AMBIENT_PENALTY);
        for hit in &mut fused {
            let (confidence, updated_at, item_project, item_scope) =
                store::get_item(&conn, &hit.canonical_id)
                    .ok()
                    .flatten()
                    .map(|it| (it.confidence, it.updated_at, it.project_id, it.scope))
                    .unwrap_or((0.5, 0, None, Scope::Global)); // unknown → vault-level, sin castigo doble
            let quality_factor: f32 = if confidence >= 0.6 {
                1.0 + 0.6 * confidence
            } else {
                // Soft penalty for low-confidence items (generic imports).
                (1.0 + 0.6 * confidence) * 0.9
            };
            let recency_factor = if now_ms - updated_at < SEVEN_DAYS_MS {
                1.05_f32
            } else {
                1.0_f32
            };
            let ambient_factor = ambient_rank_factor(
                project_id,
                cross_project,
                item_project.as_deref(),
                item_scope,
                ambient_penalty,
            );
            hit.rrf_score *= quality_factor * recency_factor * ambient_factor;
        }
        // Re-sort after quality adjustment (preserves dense_score as final tie-break).
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

    // Pilar 1 — cross-encoder re-ranker (A/B, ULTRON_RERANK=1, default OFF).
    //
    // Takes the top RERANK_TOP_N candidates AFTER the heuristic quality sort
    // and re-orders them by BGERerankerV2M3 cross-encoder score. Candidates
    // beyond RERANK_TOP_N keep their existing position after the re-ranked
    // block. Only the ORDER changes; canonical_id / dense_score are untouched.
    //
    // Default OFF guarantee: when ULTRON_RERANK is unset (or any value other
    // than "1"/"true") this entire block is skipped and `fused` is IDENTICAL
    // to what the heuristic quality sort produced — the baseline nDCG@8 /
    // recall@8 is unchanged. This is the A/B measurability invariant.
    //
    // Fallback: any error from rerank_pairs is printed to stderr and silently
    // ignored — the existing `fused` order is preserved and recall continues.
    // The recall MUST NOT fail because the re-ranker is unavailable.
    const RERANK_TOP_N: usize = 48;
    if rerank && crate::qdrant::reranker_enabled() {
        // (cat1 2026-07-03, subido 2026-07-22) N tuneable por env para el A/B:
        // el diagnostico del golden situo relevantes cortados hasta fused rank
        // 56 — con N=24 el cross-encoder ni los veia (techo ~0.82); N=48 sube
        // el techo a ~0.92 a cambio del doble de pares por query (solo paths
        // de calidad — el hook pasa rerank=false y no entra aqui).
        let rerank_top_n = env_knob_usize("ULTRON_RERANK_TOP_N", RERANK_TOP_N);
        let top_n_len = rerank_top_n.min(fused.len());
        // Collect (id, text) pairs for the cross-encoder. Items whose text
        // cannot be resolved (store miss or no summary/title) are omitted from
        // the pairs list; they will receive NEG_INFINITY in the re-sort and
        // sink to the bottom of the top-N block, which is acceptable.
        let pairs: Vec<(String, String)> = fused[..top_n_len]
            .iter()
            .filter_map(|hit| {
                store::get_item(&conn, &hit.canonical_id)
                    .ok()
                    .flatten()
                    .map(|it| {
                        // Use summary (the prompt-injected form); fall back to
                        // title, then to an empty string. Empty strings are
                        // scored poorly by the cross-encoder — an acceptable
                        // outcome for items without descriptive text.
                        // (cat1 2026-07-03 MEDIDO: enriquecer con content
                        // recortado EMPEORA — recall@8 0.709→0.657 — el content
                        // diluye la senal del summary conciso. No "mejorar".)
                        let text = it.summary.or(it.title).unwrap_or_default();
                        (hit.canonical_id.clone(), text)
                    })
            })
            .collect();

        match crate::qdrant::rerank_pairs(query, &pairs) {
            Ok(ranked) => {
                // Build a score lookup: id → cross-encoder score.
                let score_map: HashMap<&str, f32> =
                    ranked.iter().map(|(id, s)| (id.as_str(), *s)).collect();
                // Re-sort ONLY the top-N slice; the tail keeps its position.
                // Items not present in score_map (text was empty / not in pairs)
                // receive NEG_INFINITY and sink within the top-N block.
                fused[..top_n_len].sort_by(|a, b| {
                    let sa = score_map
                        .get(a.canonical_id.as_str())
                        .copied()
                        .unwrap_or(f32::NEG_INFINITY);
                    let sb = score_map
                        .get(b.canonical_id.as_str())
                        .copied()
                        .unwrap_or(f32::NEG_INFINITY);
                    sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
                });
            }
            Err(e) => {
                // Graceful fallback: log and keep the heuristic order intact.
                eprintln!("[reranker] fallback (order unchanged): {e}");
            }
        }
    }

    // (4)+(5) load items + apply governance + the per-call token cap via the
    // pure assemble_pack. Every recall receives the FULL per-call cap — there is
    // NO cumulative per-session budget, so the memory is never silenced
    // mid-session. The item-count `limit` is the primary bloat ceiling.
    let (mut injected, mut discarded, mut total_tokens) = assemble_pack(
        &conn,
        &fused,
        limit,
        project_id,
        cross_project,
        PER_CALL_TOKEN_CAP,
    );

    let mut warnings: Vec<String> = Vec::new();
    // (floor) 2026-07-02 — abstención a nivel de PACK: si NINGUNA entrada trae
    // señal de confianza (ni dense >= floor ni sparse fuerte), el pack se vacía
    // en vez de inyectar relleno como contexto. Complementa SPARSE_TAIL_CUTOFF
    // (que poda la cola léxica ENTRADA a entrada): esto cubre la query
    // INCONTESTABLE donde todo el pack es cola. memory-bench abstain_empty era
    // 0/3 sin esto. Auditable: cada entrada vaciada queda en `discarded` y el
    // pack lleva warning (mandamiento 11: nada de no-ops silenciosos).
    if let Some(floor) = recall_floor() {
        if !injected.is_empty() && !pack_has_confident_signal(&injected, floor) {
            for e in injected.drain(..) {
                discarded.push(DiscardedHit {
                    canonical_id: e.canonical_id,
                    reason: format!("abstain: sin señal de confianza (floor {floor})"),
                });
            }
            total_tokens = 0;
            warnings.push(format!(
                "recall abstained — ninguna entrada con dense >= {floor} ni sparse fuerte"
            ));
        }
    }
    // (c trust gate, 2026-07-02) COBERTURA DE TÉRMINOS: si la query trae un
    // término informativo con CERO documentos en el corpus, el sistema no puede
    // saber de eso — inyectar vecinos temáticos es alucinar contexto (near-miss
    // "AWS": dense 0.8503 de puro tema ULTRON, pero AWS no existe en memoria;
    // el floor plano no puede pararlo). Fail-open si el FTS falla (gate de
    // honestidad, no de seguridad). ULTRON_TRUST_TERMS=off lo desactiva.
    if !injected.is_empty() && trust_terms_enabled() {
        // (2026-07-22) Diacriticos: el fallback LIKE del sparse (build sin FTS5)
        // compara bytes — 'simbolos' NO matchea un corpus con 'símbolos' y el
        // gate abstenia en falso (gs-0017, unico recall=0 del golden). Antes de
        // declarar un termino desconocido se prueban tambien sus variantes de
        // tilde/ñ; solo df=0 en TODAS confirma que el corpus no sabe de eso.
        let term_is_unknown = |term: &str| {
            MemoryService::search_active(term, 1)
                .map(|v| v.is_empty())
                .unwrap_or(false) // fail-open: error FTS != termino desconocido
        };
        let unknown = informative_query_terms(query).into_iter().find(|t| {
            term_is_unknown(t)
                && diacritic_probe_variants(t)
                    .iter()
                    .all(|v| term_is_unknown(v))
        });
        if let Some(term) = unknown {
            for e in injected.drain(..) {
                discarded.push(DiscardedHit {
                    canonical_id: e.canonical_id,
                    reason: format!("abstain: término desconocido para el corpus ('{term}')"),
                });
            }
            total_tokens = 0;
            warnings.push(format!("recall abstained — el corpus no conoce '{term}'"));
        }
    }
    if cross_project && project_id.is_some() {
        warnings.push(
            "cross-project recall — project filter relaxed (Secret still excluded)".to_string(),
        );
    }
    if dense_ids.is_empty() {
        warnings.push("dense recall empty — E5/Qdrant unavailable; sparse-only".to_string());
    }
    if let Ok(stats) = MemoryService::stats() {
        if stats.candidates_pending > 0 {
            warnings.push(format!(
                "{} memory candidate(s) await validation in the inbox",
                stats.candidates_pending
            ));
        }
    }
    let lazy_load_ids: Vec<String> = injected.iter().map(|e| e.canonical_id.clone()).collect();

    // Audit: record a compact Retrieved event (best-effort).
    let ev = MemoryEvent::new(EventType::Retrieved, None, Actor::System)
        .with_reason(format!(
            "recall '{query}' -> {} injected / {} fused",
            injected.len(),
            fused.len()
        ))
        .with_after(
            serde_json::json!({
                "query": query,
                "injected_ids": lazy_load_ids,
                "total_tokens": total_tokens,
                "dense_hits": dense_ids.len(),
                "sparse_hits": sparse_ids.len(),
            })
            .to_string(),
        );
    let _ = store::insert_event(&conn, &ev);

    Ok(RecallTrace {
        query: query.to_string(),
        project_filter: project_id.map(str::to_string),
        token_budget: PER_CALL_TOKEN_CAP,
        dense_ids,
        sparse_ids,
        fused,
        injected,
        discarded,
        total_tokens,
        lazy_load_ids,
        warnings,
    })
}

/// Floor por defecto del gate de abstención (E5 cosine). Barrido empírico
/// 2026-07-02 sobre golden eval-full + memory-bench abstain:
///   off   -> recall@8 0.637 · abstain 0/3
///   0.83  -> recall@8 0.610 · abstain 3/3   <- elegido (mínimo coste golden)
///   0.84  -> recall@8 0.588 · abstain 3/3
/// Incontestables reales maxean dense <= 0.828. Tuneable por ULTRON_RECALL_FLOOR.
const DEFAULT_RECALL_FLOOR: f32 = 0.83;

/// Rank FTS máximo que cuenta como "sparse FUERTE" (match léxico exacto, p.ej.
/// un identificador). Los matches de stopwords caen a ranks profundos (probe
/// "paella": ranks 11-13), así que no compran confianza.
const STRONG_SPARSE_RANK: usize = 2;

/// (cat1 ranking, 2026-07-02) Knobs de retrieval por env para el A/B honesto:
/// `ULTRON_FANOUT_K` (candidatos por fuente antes de fusionar, default 30) y
/// `ULTRON_RRF_K` (damping de la fusión, default 60). Fail-safe: ausente o
/// basura -> default compilado. Mismo patrón que ULTRON_RECALL_FLOOR.
fn env_knob_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

fn env_knob_f32(name: &str, default: f32) -> f32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

/// (2026-07-13) Factor de ranking para items AMBIENTE (project_id=NULL) bajo un
/// filtro de proyecto activo. Complementa la regla ambiente del pack (que los
/// mantiene VISIBLES): aquí solo se hunden en el orden para que las memorias del
/// proyecto activo ganen cuando compiten. Devuelve `penalty` únicamente cuando:
/// hay proyecto en la query, NO es cross_project (cerebro entero pedido
/// explícitamente), el item no tiene proyecto y su scope no es Global (las
/// memorias Global son deliberadamente universales). En cualquier otro caso 1.0.
pub(crate) fn ambient_rank_factor(
    query_project: Option<&str>,
    cross_project: bool,
    item_project: Option<&str>,
    item_scope: Scope,
    penalty: f32,
) -> f32 {
    if query_project.is_some()
        && !cross_project
        && item_project.is_none()
        && item_scope != Scope::Global
    {
        penalty
    } else {
        1.0
    }
}

/// Lee `ULTRON_RECALL_FLOOR`: ausente -> default; "off"/"0" -> gate desactivado;
/// número -> override; basura -> default (fail-safe: nunca desactiva en silencio).
fn recall_floor() -> Option<f32> {
    match std::env::var("ULTRON_RECALL_FLOOR") {
        Ok(v) if v.eq_ignore_ascii_case("off") || v.trim() == "0" => None,
        Ok(v) => Some(v.trim().parse::<f32>().unwrap_or(DEFAULT_RECALL_FLOOR)),
        Err(_) => Some(DEFAULT_RECALL_FLOOR),
    }
}

/// (floor) ¿Alguna entrada del pack trae señal de confianza real? Sin ella el
/// recall debe abstenerse en vez de inyectar relleno (memory-bench, categoría
/// abstain). dense = E5 cosine crudo; sparse fuerte = rank FTS <= STRONG_SPARSE_RANK.
pub fn pack_has_confident_signal(entries: &[RecallEntry], floor: f32) -> bool {
    entries.iter().any(|e| {
        e.dense_score.is_some_and(|s| s >= floor)
            || e.sparse_rank.is_some_and(|r| r <= STRONG_SPARSE_RANK)
    })
}

/// Sync compact recall pack — reused by the CLI sidecar (`ultron-memory recall`).
/// `cross_project` relaxes ONLY the project filter (whole-brain recall); Secret
/// items are still excluded. Every call gets the full `PER_CALL_TOKEN_CAP`;
/// there is no cumulative per-session budget.
pub fn recall_pack(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    rerank: bool,
) -> Result<RecallPack, String> {
    // Manual recall path (UI inspection) keeps full hybrid quality (dense on).
    let t = build_trace(query, limit, project_id, cross_project, true, rerank)?;
    Ok(RecallPack {
        dense_hits: t.dense_ids.len(),
        sparse_hits: t.sparse_ids.len(),
        total_tokens: t.total_tokens,
        abstained: t.warnings.iter().any(|w| w.starts_with("recall abstained")),
        entries: t.injected,
    })
}

#[cfg(test)]
mod floor_tests {
    use super::*;

    fn entry(dense: Option<f32>, sparse: Option<usize>) -> RecallEntry {
        RecallEntry {
            canonical_id: "x".into(),
            title: None,
            summary: Some("s".into()),
            scope: "project".into(),
            project_id: None,
            score: 0.01,
            dense_rank: None,
            sparse_rank: sparse,
            dense_score: dense,
            reason: "test".into(),
            token_estimate: 10,
        }
    }

    // (floor) 2026-07-02 — el pack abstiene cuando NINGUNA entrada trae señal:
    // ni dense >= floor ni sparse fuerte. Casos calibrados con el probe real.
    #[test]
    fn abstain_gate_needs_dense_floor_or_strong_sparse() {
        // Incontestable real ("paella", probe 2026-07-02): dense max 0.8049 +
        // sparse ranks 11-13 (ruido lexico) -> sin señal -> abstiene.
        let junk = vec![entry(Some(0.8049), None), entry(None, Some(11))];
        assert!(
            !pack_has_confident_signal(&junk, 0.84),
            "relleno sin señal debe abstener"
        );

        // dense sobre el floor (t1 router: 0.8459) -> confianza (caso negativo).
        let dense_ok = vec![entry(Some(0.8459), None)];
        assert!(pack_has_confident_signal(&dense_ok, 0.84));

        // sparse FUERTE (rank <= 2, match lexico exacto tipo identificador)
        // protege las queries sparse-only aunque el dense sea debil.
        let sparse_ok = vec![entry(None, Some(0)), entry(Some(0.70), None)];
        assert!(pack_has_confident_signal(&sparse_ok, 0.84));

        // sparse justo por encima del umbral fuerte NO cuenta como señal.
        let sparse_weak = vec![entry(None, Some(3))];
        assert!(!pack_has_confident_signal(&sparse_weak, 0.84));

        // pack vacio: sin señal (gate no-op sobre vacio).
        assert!(!pack_has_confident_signal(&[], 0.84));
    }

    #[test]
    fn ranking_knobs_env_override_and_fail_safe() {
        // (cat1 ranking) Solo este test toca estas env vars.
        std::env::set_var("ULTRON_FANOUT_K", "50");
        assert_eq!(env_knob_usize("ULTRON_FANOUT_K", 30), 50);
        std::env::set_var("ULTRON_FANOUT_K", "garbage");
        assert_eq!(
            env_knob_usize("ULTRON_FANOUT_K", 30),
            30,
            "basura -> default, no silencio"
        );
        std::env::remove_var("ULTRON_FANOUT_K");
        assert_eq!(env_knob_usize("ULTRON_FANOUT_K", 30), 30);

        std::env::set_var("ULTRON_RRF_K", "20.5");
        assert_eq!(env_knob_f32("ULTRON_RRF_K", 60.0), 20.5);
        std::env::remove_var("ULTRON_RRF_K");
        assert_eq!(env_knob_f32("ULTRON_RRF_K", 60.0), 60.0);
    }

    #[test]
    fn recall_floor_env_override_off_and_garbage() {
        // Solo este test toca la env var (secuencial dentro del test -> sin carrera).
        std::env::set_var("ULTRON_RECALL_FLOOR", "off");
        assert_eq!(recall_floor(), None, "off desactiva el gate");
        std::env::set_var("ULTRON_RECALL_FLOOR", "0.9");
        assert_eq!(recall_floor(), Some(0.9));
        std::env::set_var("ULTRON_RECALL_FLOOR", "garbage");
        assert_eq!(
            recall_floor(),
            Some(DEFAULT_RECALL_FLOOR),
            "valor invalido -> default, no silencio"
        );
        std::env::remove_var("ULTRON_RECALL_FLOOR");
        assert_eq!(recall_floor(), Some(DEFAULT_RECALL_FLOOR));
    }
}
