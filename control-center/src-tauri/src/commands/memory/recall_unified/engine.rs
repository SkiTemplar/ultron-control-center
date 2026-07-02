// recall_unified/engine.rs — assemble_pack, build_trace, recall_pack.
//
// `assemble_pack`: pure governance filter over a pre-fused candidate list.
//    Unit-testable without Qdrant/E5.
// `build_trace`: full hybrid recall pipeline (dense + sparse + RRF + quality
//    re-ranker), returns the Retrieval Inspector trace. Each call gets the full
//    per-call token cap — no cumulative per-session budget.
// `recall_pack`: thin wrapper over `build_trace` that returns the compact pack.

use std::collections::HashMap;

use crate::memory::model::now_millis;
use crate::memory::qdrant_index;
use crate::memory::redaction;
use crate::memory::sqlite_store as store;
use crate::memory::{
    Actor, EventType, MemoryEvent, MemoryService, Scope, Sensitivity, Source, Status,
};

use super::types_model::{
    DiscardedHit, FusedHit, RecallEntry, RecallPack, RecallTrace, ENTRY_TOKEN_CLAMP, FANOUT_K,
    PER_CALL_TOKEN_CAP, RRF_K, SPARSE_TAIL_CUTOFF,
};
use crate::commands::memory::recall_unified::rrf_fuse;

/// Assemble the compact context pack from fused candidates: load each item and
/// apply the governance filters — result limit, status=active, project scope
/// (global applies everywhere), sensitivity gate (no Secret), token budget. Pure
/// over the given connection so the security invariants are UNIT-TESTABLE without
/// Qdrant/E5. Returns (injected, discarded, total_tokens).
///
/// CROSS-PROJECT: when `cross_project` is true the PROJECT-equality gate is
/// relaxed so scope=project items from ANY project are eligible (the user is
/// explicitly asking about another project / the whole brain). ONLY the project
/// filter is relaxed — every security/quality gate (status=active, temporal
/// validity, sensitivity!=Secret, dedup, token budget) stays intact. The vault
/// noise gate is keyed on `project_id.is_some()`, NOT on the project filter, so a
/// cross-project recall launched from inside a project still keeps vault off by
/// default (cross relaxes the project filter, not the noise control).
/// `limit_tokens` caps the total token count of the assembled pack. Pass
/// `PER_CALL_TOKEN_CAP` for the default, or a custom value from the caller. Items are
/// admitted best-rank-first; the first item is always admitted (with truncation)
/// even if its token estimate exceeds the budget.
pub(crate) fn assemble_pack(
    conn: &rusqlite::Connection,
    fused: &[FusedHit],
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    limit_tokens: i64,
) -> (Vec<RecallEntry>, Vec<DiscardedHit>, i64) {
    let mut injected: Vec<RecallEntry> = Vec::new();
    let mut discarded: Vec<DiscardedHit> = Vec::new();
    let mut total_tokens = 0i64;
    for fh in fused {
        let discard = |reason: &str| DiscardedHit {
            canonical_id: fh.canonical_id.clone(),
            reason: reason.to_string(),
        };
        if injected.len() >= limit {
            discarded.push(discard("below result limit"));
            continue;
        }
        // Relevance floor (Pilar #1 — "trae lo correcto y POCO"). A hit with NO
        // dense (semantic) backing whose sparse (BM25) rank is in the TAIL shares
        // only a stray term with the query — E5 did not rank it relevant at all.
        // The widened BM25 fanout exists to push in-project items past the
        // governance gates, NOT to inject the lexical tail; this floor drops it so
        // the pack stays few-and-good (kills the "Mundial 2026 / menú de 5
        // decisiones" class). dense-backed hits (any rank) and sparse-TOP hits
        // (rank < cutoff) always pass. Cheap: runs before get_item.
        if fh.dense_rank.is_none() && fh.sparse_rank.is_some_and(|r| r >= SPARSE_TAIL_CUTOFF) {
            discarded.push(discard(
                "below relevance floor (BM25 tail, no dense backing)",
            ));
            continue;
        }
        let item = match store::get_item(conn, &fh.canonical_id) {
            Ok(Some(it)) => it,
            _ => {
                discarded.push(discard("unresolvable (no item)"));
                continue;
            }
        };
        if item.status != Status::Active {
            discarded.push(discard(&format!("status={}", item.status.as_str())));
            continue;
        }
        // Codegraph separation (Kirkardo R5): per-symbol code locations
        // (codebase_fact) are STRUCTURAL data for impact-analysis, not
        // conversational memory. At ~478 items they were crowding out real
        // knowledge in the recall pack. Exclude them from the conversational
        // pack; the code graph is consumed through its own surfaces: the
        // codegraph MCP in CLI sessions and the Tauri command
        // codegraph_summary feeding the ProjectWorkspace panel (2026-06-10;
        // the old reference to an unwired memory_impact_analysis was a lie).
        if item.kind == crate::memory::model::MemoryType::CodebaseFact {
            discarded.push(discard("codebase_fact excluded from conversational recall"));
            continue;
        }
        // Temporal resolver: prefer items still VIGENTE. `valid_to == None` means
        // "no end" (the common case — every legacy row and every non-superseded
        // item). Only a row whose validity END is in the PAST is filtered, so
        // historical items with valid_to NULL are NEVER lost (additive + reversible).
        if let Some(valid_to) = item.valid_to {
            if valid_to <= now_millis() {
                discarded.push(discard("superseded (valid_to in the past)"));
                continue;
            }
        }
        // TTL: an item with an explicit expiry in the PAST is dead and must never
        // reach the pack (mandamiento 12: expired data must not pollute context).
        // `expires_at == None` (the common case) means "no TTL". Same millis basis
        // as `valid_to`/`now_millis()`. ADDITIVE — legacy/NULL rows are untouched.
        if let Some(expires_at) = item.expires_at {
            if expires_at <= now_millis() {
                discarded.push(discard("expired (expires_at in the past)"));
                continue;
            }
        }
        if let Some(pid) = project_id {
            // Global-scope memories apply everywhere; others must match the
            // project — UNLESS cross_project is set, which relaxes ONLY this
            // project-equality gate (every security/quality gate below still
            // applies, so items from other projects flow in but Secret never does).
            //
            // 1.0 (recall cross-project): items con project_id=NULL son AMBIENTE (no
            // pertenecen a ningun proyecto) y aplican en todas partes, como Global.
            // Sin esto, el 82% del corpus (project_id NULL) era INVISIBLE desde
            // cualquier sesion de proyecto -> "la memoria no funciona fuera de
            // ULTRON" (en Oryntics: 76 memorias reales devolvian 0). La relevancia
            // (RRF + denso + re-ranker) da la precision; el gate solo excluye
            // memorias de OTRO proyecto IDENTIFICADO.
            if !cross_project
                && item.scope != Scope::Global
                && item.project_id.is_some()
                && item.project_id.as_deref() != Some(pid)
            {
                discarded.push(discard(&format!("project filter ({pid})")));
                continue;
            }
        }
        // Ola 1b vault gate: imported_vault items (~92% of the corpus, confidence=0.5)
        // flood every query when a project filter is active because their scope=global
        // bypasses the project-equality check above.  Gate is keyed on
        // `project_id.is_some()` — when project_id is None (e.g. recall_hybrid or
        // a project-less recall) the gate does NOT fire and vault items surface
        // normally.  This is intentional: without a project context, vault is the
        // primary source.  The quality ranker (Pilar 1, build_trace) still
        // down-weights vault items relative to high-confidence codebase_fact.
        if project_id.is_some() && item.source == Source::ImportedVault {
            discarded.push(discard("vault off-by-default under project filter"));
            continue;
        }
        // Sensitivity gate (Ola 0 / audit top-risk #2): NEVER inject Secret items.
        if item.sensitivity == Sensitivity::Secret {
            discarded.push(discard("sensitivity=secret (excluded from context pack)"));
            continue;
        }
        // (cat1, 2026-07-02) CLAMP por entrada: cada item aporta como mucho
        // ENTRY_TOKEN_CLAMP (o limit_tokens si es menor — preserva B4 con caps
        // reducidos). El summary inyectado se trunca declarándolo; el contenido
        // completo sigue lazy por id. Antes un item gordo se DESCARTABA entero
        // y desalojaba a relevantes mejor rankeados (fused#3 fuera del pack).
        let entry_cap = ENTRY_TOKEN_CLAMP.min(limit_tokens);
        let clamped = item.token_estimate.min(entry_cap);
        if total_tokens + clamped > limit_tokens && !injected.is_empty() {
            discarded.push(discard("token budget exceeded"));
            continue;
        }
        let (summary, entry_tokens) = if item.token_estimate > entry_cap {
            let max_chars = (entry_cap * 4) as usize; // ~4 chars/token; chars() is UTF-8 safe
            let truncated = item.summary.as_ref().map(|s| {
                let mut t: String = s.chars().take(max_chars).collect();
                t.push_str(" …[truncated to budget]");
                t
            });
            (truncated, entry_cap)
        } else {
            (item.summary.clone(), item.token_estimate)
        };
        // READ-PATH PII gate: redact email/phone/user-path from the summary that
        // is injected into the prompt context. The item in brain.db is NOT mutated
        // here — this is a defence-in-depth read-path guard so that items stored
        // before the write-path PII classifier existed never expose raw PII to the
        // model. Only the injected text is redacted; the stored item is untouched.
        let summary = summary.map(|s| {
            if redaction::contains_pii(&s) {
                redaction::redact_pii(&s)
            } else {
                s
            }
        });
        total_tokens += entry_tokens;
        let reason = match (fh.dense_rank, fh.sparse_rank) {
            (Some(d), Some(s)) => format!("dense#{} + sparse#{}", d + 1, s + 1),
            (Some(d), None) => format!("dense#{}", d + 1),
            (None, Some(s)) => format!("sparse#{}", s + 1),
            (None, None) => "unranked".to_string(),
        };
        injected.push(RecallEntry {
            canonical_id: item.id.clone(),
            title: item.title.clone(),
            summary, // compact; full content lazy via get_item
            scope: item.scope.as_str().to_string(),
            project_id: item.project_id.clone(),
            score: fh.rrf_score,
            dense_rank: fh.dense_rank,
            sparse_rank: fh.sparse_rank,
            dense_score: fh.dense_score,
            reason,
            token_estimate: entry_tokens,
        });
    }
    (injected, discarded, total_tokens)
}

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
pub fn build_trace(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    dense_enabled: bool,
) -> Result<RecallTrace, String> {
    // (1) DENSE — E5 query embedding + Qdrant filtered k-NN. Empty if offline,
    //     OR skipped entirely when dense_enabled=false (the sparse-first hot
    //     path): embedding a query with E5-large on CPU costs ~1.1s, too slow
    //     for the UserPromptSubmit hook, so orchestrate() runs sparse-only there
    //     while manual recalls (Memory Browser) stay hybrid.
    //     Score-aware (B1): keep the cosine similarity to break RRF ties.
    let dense_scored = if dense_enabled {
        // Dense (Qdrant) project filter: drop it in cross-project mode so the
        // k-NN is not pre-restricted to the current project at the index level.
        let dense_project = if cross_project { None } else { project_id };
        qdrant_index::search_dense_scored(query, FANOUT_K as u32, dense_project)
    } else {
        Vec::new()
    };
    let dense_ids: Vec<String> = dense_scored.iter().map(|(id, _)| id.clone()).collect();
    let dense_score_map: HashMap<&str, f32> = dense_scored
        .iter()
        .map(|(id, s)| (id.as_str(), *s))
        .collect();
    // (2) SPARSE — FTS5/bm25 over ACTIVE items. When dense is OFF (sparse-first
    //     hot path) we widen the pool: the dense Qdrant project-filter that
    //     normally surfaces in-project items is gone, and under a project filter
    //     assemble_pack drops the global vault + off-project hits that dominate
    //     the BM25 top-30, leaving too few. A wider fanout lets in-project items
    //     reach the gate. Quality callers keep the tight FANOUT_K (dense covers them).
    let sparse_fanout = if dense_enabled {
        FANOUT_K
    } else {
        FANOUT_K * 12
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
    let mut fused: Vec<FusedHit> = rrf_fuse(&[dense_ids.clone(), sparse_ids.clone()], RRF_K)
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
        for hit in &mut fused {
            let (confidence, updated_at) = store::get_item(&conn, &hit.canonical_id)
                .ok()
                .flatten()
                .map(|it| (it.confidence, it.updated_at))
                .unwrap_or((0.5, 0)); // unknown → treat as vault-level confidence
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
            hit.rrf_score *= quality_factor * recency_factor;
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
    const RERANK_TOP_N: usize = 24;
    if crate::qdrant::reranker_enabled() {
        let top_n_len = RERANK_TOP_N.min(fused.len());
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
) -> Result<RecallPack, String> {
    // Manual recall path (UI inspection) keeps full hybrid quality (dense on).
    let t = build_trace(query, limit, project_id, cross_project, true)?;
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
