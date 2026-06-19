// recall_unified/engine.rs — assemble_pack, build_trace, recall_pack.
//
// `assemble_pack`: pure governance filter over a pre-fused candidate list.
//    Unit-testable without Qdrant/E5.
// `build_trace`: full hybrid recall pipeline (dense + sparse + RRF + quality
//    re-ranker + session budget), returns the Retrieval Inspector trace.
// `recall_pack`: thin wrapper over `build_trace` that returns the compact pack.

use std::collections::HashMap;

use crate::memory::model::now_millis;
use crate::memory::qdrant_index;
use crate::memory::sqlite_store as store;
use crate::memory::{
    Actor, EventType, MemoryEvent, MemoryService, Scope, Sensitivity, Source, Status,
};

use super::session_budget::{resolve_session_id, session_budget_deduct, session_budget_remaining};
use super::types_model::{
    DiscardedHit, FusedHit, RecallEntry, RecallPack, RecallTrace, FANOUT_K, RRF_K, TOKEN_BUDGET,
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
/// `TOKEN_BUDGET` for the default, or a custom value from the caller. Items are
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
        if let Some(pid) = project_id {
            // Global-scope memories apply everywhere; others must match the
            // project — UNLESS cross_project is set, which relaxes ONLY this
            // project-equality gate (every security/quality gate below still
            // applies, so items from other projects flow in but Secret never does).
            if !cross_project
                && item.scope != Scope::Global
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
        if total_tokens + item.token_estimate > limit_tokens && !injected.is_empty() {
            discarded.push(discard("token budget exceeded"));
            continue;
        }
        // B4: the FIRST item is always admitted even if oversized, but its summary is
        // truncated to limit_tokens so a single huge memory can't blow the pack.
        let (summary, entry_tokens) = if injected.is_empty() && item.token_estimate > limit_tokens {
            let max_chars = (limit_tokens * 4) as usize; // ~4 chars/token; chars() is UTF-8 safe
            let truncated = item.summary.as_ref().map(|s| {
                let mut t: String = s.chars().take(max_chars).collect();
                t.push_str(" …[truncated to budget]");
                t
            });
            (truncated, limit_tokens)
        } else {
            (item.summary.clone(), item.token_estimate)
        };
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
/// SESSION BUDGET: `session_id` is used to track cumulative token consumption
/// across multiple recalls in the same session. When the session has already
/// consumed TOKEN_BUDGET tokens, this call injects zero items (budget exhausted)
/// and records a warning. Pass `None` to use the resolved default session id
/// (env var → proc-<pid>).
pub fn build_trace(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    session_id: Option<&str>,
    dense_enabled: bool,
) -> Result<RecallTrace, String> {
    // Session budget — cumulative across recalls in the same session.
    let sid = resolve_session_id(session_id);
    let remaining_before = session_budget_remaining(&sid);

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

    // (4)+(5) load items + apply governance + budget via the pure assemble_pack.
    // The per-call budget is the REMAINING session budget (not the full constant),
    // so a session that has already consumed tokens in earlier recalls gets a
    // proportionally smaller pack — or an empty pack when exhausted.
    // The first item is still always admitted (assemble_pack truncates it to
    // fit the budget), but only if remaining_before > 0.
    let (injected, discarded, total_tokens) = if remaining_before > 0 {
        assemble_pack(
            &conn,
            &fused,
            limit,
            project_id,
            cross_project,
            remaining_before,
        )
    } else {
        // Budget fully exhausted: admit nothing, mark all fused hits as discarded.
        let disc: Vec<DiscardedHit> = fused
            .iter()
            .map(|fh| DiscardedHit {
                canonical_id: fh.canonical_id.clone(),
                reason: "session token budget exhausted".to_string(),
            })
            .collect();
        (vec![], disc, 0)
    };

    // Deduct tokens consumed this call from the session budget.
    let remaining_after = session_budget_deduct(&sid, total_tokens);

    let mut warnings: Vec<String> = Vec::new();
    if remaining_before == 0 {
        warnings.push(format!(
            "session token budget exhausted (budget={TOKEN_BUDGET}); no items injected — \
             start a new session or call session_budget_reset to continue"
        ));
    } else if remaining_after == 0 {
        warnings.push(format!(
            "session token budget now exhausted after this recall \
             (consumed={total_tokens}, session_total={TOKEN_BUDGET})"
        ));
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
        token_budget: remaining_before,
        dense_ids,
        sparse_ids,
        fused,
        injected,
        discarded,
        total_tokens,
        lazy_load_ids,
        warnings,
        session_id: sid,
        session_budget_remaining: remaining_after,
    })
}

/// Sync compact recall pack — reused by the CLI sidecar (`ultron-memory recall`).
/// `cross_project` relaxes ONLY the project filter (whole-brain recall); Secret
/// items are still excluded.
/// `session_id` is used for cumulative budget tracking; pass `None` to use the
/// default (env → proc-<pid>).
pub fn recall_pack(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    session_id: Option<&str>,
) -> Result<RecallPack, String> {
    // Manual recall path (UI inspection) keeps full hybrid quality (dense on).
    let t = build_trace(query, limit, project_id, cross_project, session_id, true)?;
    Ok(RecallPack {
        dense_hits: t.dense_ids.len(),
        sparse_hits: t.sparse_ids.len(),
        total_tokens: t.total_tokens,
        entries: t.injected,
    })
}
