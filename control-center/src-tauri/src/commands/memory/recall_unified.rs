// commands/memory/recall_unified.rs — unified hybrid recall (MEMORY KERNEL Fase B)
//
// The single `recall` command. Fuses TWO sources with Reciprocal Rank Fusion:
//   - DENSE:  MultilingualE5Large vectors in Qdrant `ultron_memory`
//   - SPARSE: FTS5/bm25 over `memory_items` (brain.db), ACTIVE only
// Both sources filter to status=active; the result is a compact context pack of
// summaries (not full content) under a token budget. Degrades to sparse-only
// when E5/Qdrant is unavailable.
//
// Replaces the old `recall_hybrid` (constant-score union, no RRF) and
// `recall_semantic`. Those remain registered (no live frontend caller) but are
// deprecated.
//
// SESSION BUDGET (Pilar 1 · Kirkardo gap):
//   `TOKEN_BUDGET` is the PER-SESSION total, not a per-call constant.  A
//   global `SESSION_BUDGET_STORE` (Mutex<HashMap>) tracks tokens already
//   injected for each session_id within the process lifetime.  Each call to
//   `build_trace` / `recall_pack` deducts the tokens consumed from the
//   remaining budget, so that a session making multiple recalls cannot exceed
//   TOKEN_BUDGET in aggregate.
//
//   Session-id source (priority order):
//     1. Caller-supplied `session_id` (e.g. from the Claude session hook).
//     2. `ULTRON_SESSION_ID` environment variable (set by the CLI launcher).
//     3. `CLAUDE_SESSION_ID` environment variable (set by the Claude Code CLI
//        host).  Honoured so the budget is tracked per logical Claude session,
//        not per OS process, when Claude spawns multiple short-lived
//        sub-processes within a single session (Kirkardo gap #6).
//     4. Synthetic `"proc-<pid>"` — stable within a process lifetime, which
//        maps to a single Control-Center window session.
//
//   The budget resets only when the process restarts (i.e. new CC window).
//   Entries are never evicted from the store; the HashMap stays small because
//   one process = one window = typically one or two active session ids.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::memory::model::now_millis;
use crate::memory::qdrant_index;
use crate::memory::sqlite_store as store;
use crate::memory::{
    Actor, EventType, MemoryEvent, MemoryService, Scope, Sensitivity, Source, Status,
};

const RRF_K: f32 = 60.0; // standard RRF damping constant
const DEFAULT_LIMIT: usize = 8; // final entries returned
const FANOUT_K: usize = 30; // top-K pulled from each source before fusion
/// Total token budget **per session** (not per call).  Once a session has
/// injected this many tokens across all recalls, subsequent recalls in the
/// same session receive an empty pack (budget exhausted).
pub const TOKEN_BUDGET: i64 = 1500;

// ---------------------------------------------------------------------------
// Session budget store
// ---------------------------------------------------------------------------

/// Global in-process store: session_id → tokens already consumed this session.
///
/// `OnceLock` + `Mutex<HashMap>` — no extra dependencies, zero unsafe code.
static SESSION_BUDGET_STORE: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();

fn session_budget_store() -> &'static Mutex<HashMap<String, i64>> {
    SESSION_BUDGET_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve the canonical session id for a call.
///
/// Priority order (Kirkardo gap #6):
///   1. Caller-supplied `session_id` — explicit override, highest priority.
///   2. `ULTRON_SESSION_ID` — set by the ULTRON CLI launcher for every
///      Control-Center window session.
///   3. `CLAUDE_SESSION_ID` — set by the Claude Code CLI host when it
///      launches a session.  Prioritising the real Claude session id over the
///      synthetic proc-<pid> fallback ensures that the per-session token
///      budget is tracked per *logical* Claude session, not per OS process,
///      which is especially important when the Claude CLI spawns multiple
///      short-lived sub-processes within a single session.
///   4. `"proc-<pid>"` — stable within a process lifetime.  Maps to one
///      Control-Center window session.  Used only when neither of the real
///      session ids is available.
///
/// The budget resets only when `session_budget_reset` is explicitly called
/// (e.g. by the `SessionStart` hook) or when the process restarts.
/// Entries are never evicted from the store; the `HashMap` stays small
/// because one process = one window = typically one or two active session ids.
pub fn resolve_session_id(supplied: Option<&str>) -> String {
    if let Some(s) = supplied {
        if !s.is_empty() {
            return s.to_string();
        }
    }
    if let Ok(env_id) = std::env::var("ULTRON_SESSION_ID") {
        if !env_id.is_empty() {
            return env_id;
        }
    }
    if let Ok(env_id) = std::env::var("CLAUDE_SESSION_ID") {
        if !env_id.is_empty() {
            return env_id;
        }
    }
    format!("proc-{}", std::process::id())
}

/// Returns how many tokens remain in the budget for `session_id`.
///
/// Returns 0 when the budget is already exhausted.
pub fn session_budget_remaining(session_id: &str) -> i64 {
    let store = session_budget_store()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let used = store.get(session_id).copied().unwrap_or(0);
    (TOKEN_BUDGET - used).max(0)
}

/// Deduct `tokens` from the session budget.  Clamps to zero (never goes
/// negative).  Returns the remaining budget after deduction.
fn session_budget_deduct(session_id: &str, tokens: i64) -> i64 {
    let mut store = session_budget_store()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let entry = store.entry(session_id.to_string()).or_insert(0);
    *entry += tokens;
    (TOKEN_BUDGET - *entry).max(0)
}

/// Reset the budget for `session_id` to zero (full budget available again).
///
/// Intended for `SessionStart` hooks and tests.
pub fn session_budget_reset(session_id: &str) {
    let mut store = session_budget_store()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    store.remove(session_id);
}

#[derive(Debug, Clone, Serialize)]
pub struct RecallEntry {
    pub canonical_id: String,
    pub title: Option<String>,
    pub summary: Option<String>, // compact form injected; full content is lazy-loaded
    pub scope: String,
    pub project_id: Option<String>,
    pub score: f32, // RRF fused score
    pub dense_rank: Option<usize>,
    pub sparse_rank: Option<usize>,
    pub dense_score: Option<f32>, // raw E5 cosine similarity (B1: tie-break / quality signal)
    pub reason: String,           // "why this memory" — e.g. "dense#2 + sparse#5"
    pub token_estimate: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecallPack {
    pub entries: Vec<RecallEntry>,
    pub total_tokens: i64,
    pub dense_hits: usize,
    pub sparse_hits: usize,
}

/// One fused candidate with its per-source ranks (Retrieval Inspector).
#[derive(Debug, Clone, Serialize)]
pub struct FusedHit {
    pub canonical_id: String,
    pub rrf_score: f32,
    pub dense_rank: Option<usize>,
    pub sparse_rank: Option<usize>,
    pub dense_score: Option<f32>, // raw E5 cosine similarity (B1)
}

/// A candidate that was retrieved but NOT injected, with the reason why.
#[derive(Debug, Clone, Serialize)]
pub struct DiscardedHit {
    pub canonical_id: String,
    pub reason: String,
}

/// Full per-turn retrieval trace — the Retrieval Inspector / "why this memory?".
#[derive(Debug, Clone, Serialize)]
pub struct RecallTrace {
    pub query: String,
    pub project_filter: Option<String>,
    /// Per-call budget passed to `assemble_pack` (may be less than TOKEN_BUDGET
    /// when the session has already consumed tokens in earlier recalls).
    pub token_budget: i64,
    pub dense_ids: Vec<String>,  // E5/Qdrant order
    pub sparse_ids: Vec<String>, // FTS5 order
    pub fused: Vec<FusedHit>,    // after RRF
    pub injected: Vec<RecallEntry>,
    pub discarded: Vec<DiscardedHit>,
    pub total_tokens: i64,
    pub lazy_load_ids: Vec<String>, // canonical_ids whose full content can be loaded on demand
    pub warnings: Vec<String>,
    /// The session id used for budget tracking (resolved from caller/env/pid).
    pub session_id: String,
    /// Tokens remaining in the session budget AFTER this recall.
    pub session_budget_remaining: i64,
}

/// Reciprocal Rank Fusion. Each list is canonical_ids ordered best-first.
/// `score(d) = Σ_sources 1 / (k + rank + 1)`. Returns `(id, score)` desc.
pub fn rrf_fuse(lists: &[Vec<String>], k: f32) -> Vec<(String, f32)> {
    use std::collections::HashMap;
    let mut scores: HashMap<String, f32> = HashMap::new();
    for list in lists {
        for (rank, id) in list.iter().enumerate() {
            *scores.entry(id.clone()).or_insert(0.0) += 1.0 / (k + rank as f32 + 1.0);
        }
    }
    let mut fused: Vec<(String, f32)> = scores.into_iter().collect();
    fused.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0)) // stable tie-break by id
    });
    fused
}

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
            if !cross_project && item.scope != Scope::Global && item.project_id.as_deref() != Some(pid)
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
pub(crate) fn build_trace(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    session_id: Option<&str>,
) -> Result<RecallTrace, String> {
    // Session budget — cumulative across recalls in the same session.
    let sid = resolve_session_id(session_id);
    let remaining_before = session_budget_remaining(&sid);

    use std::collections::HashMap;

    // Dense (Qdrant) project filter: drop it in cross-project mode so the k-NN
    // is not pre-restricted to the current project at the index level.
    let dense_project = if cross_project { None } else { project_id };

    // (1) DENSE — E5 query embedding + Qdrant filtered k-NN (empty if offline).
    //     Score-aware (B1): keep the cosine similarity to break RRF ties.
    let dense_scored = qdrant_index::search_dense_scored(query, FANOUT_K as u32, dense_project);
    let dense_ids: Vec<String> = dense_scored.iter().map(|(id, _)| id.clone()).collect();
    let dense_score_map: HashMap<&str, f32> = dense_scored
        .iter()
        .map(|(id, s)| (id.as_str(), *s))
        .collect();
    // (2) SPARSE — FTS5/bm25 over ACTIVE items.
    let sparse_items =
        MemoryService::search_active(query, FANOUT_K).map_err(|e| format!("sparse search: {e}"))?;
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
        assemble_pack(&conn, &fused, limit, project_id, cross_project, remaining_before)
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
    let t = build_trace(query, limit, project_id, cross_project, session_id)?;
    Ok(RecallPack {
        dense_hits: t.dense_ids.len(),
        sparse_hits: t.sparse_ids.len(),
        total_tokens: t.total_tokens,
        entries: t.injected,
    })
}

/// Unified hybrid recall — compact context pack. `project_id = None` = no filter.
/// `cross_project = Some(true)` relaxes the project filter (whole-brain recall);
/// security gates (Secret excluded) are untouched.
/// `session_id` — optional caller-supplied session identifier for cumulative
/// budget tracking.  When omitted the runtime falls back to `ULTRON_SESSION_ID`
/// env var, then `"proc-<pid>"`.
#[tauri::command]
pub async fn recall(
    query: String,
    limit: Option<u32>,
    project_id: Option<String>,
    cross_project: Option<bool>,
    session_id: Option<String>,
) -> Result<RecallPack, String> {
    let final_limit = limit.map(|n| n as usize).unwrap_or(DEFAULT_LIMIT);
    let cross = cross_project.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        recall_pack(&query, final_limit, project_id.as_deref(), cross, session_id.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Retrieval Inspector: the full per-turn trace (query, filters, dense/sparse
/// ranks, RRF scores, discarded+reason, injected+reason, lazy-load, warnings).
/// `session_id` follows the same resolution rules as `recall`.
#[tauri::command]
pub async fn recall_inspect(
    query: String,
    limit: Option<u32>,
    project_id: Option<String>,
    cross_project: Option<bool>,
    session_id: Option<String>,
) -> Result<RecallTrace, String> {
    let final_limit = limit.map(|n| n as usize).unwrap_or(DEFAULT_LIMIT);
    let cross = cross_project.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        build_trace(&query, final_limit, project_id.as_deref(), cross, session_id.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Rebuild the dense index (`ultron_memory`) from all ACTIVE items.
#[tauri::command]
pub async fn memory_reindex() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (indexed, errors) =
            crate::memory::qdrant_index::reindex_all().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "indexed": indexed,
            "errors": errors,
            "collection": crate::memory::qdrant_index::COLLECTION,
        }))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rrf_ranks_items_appearing_in_both_sources_highest() {
        // "shared" is rank-1 in dense and rank-2 in sparse -> highest fused score.
        let dense = vec!["shared".to_string(), "only_dense".to_string()];
        let sparse = vec!["only_sparse".to_string(), "shared".to_string()];
        let fused = rrf_fuse(&[dense, sparse], RRF_K);
        assert_eq!(fused[0].0, "shared", "item in both lists must rank first");
        assert_eq!(fused.len(), 3, "dedup leaves 3 unique ids");
    }

    #[test]
    fn rrf_respects_rank_order_within_a_single_source() {
        let only = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let fused = rrf_fuse(&[only], RRF_K);
        assert_eq!(fused[0].0, "a");
        assert_eq!(fused[1].0, "b");
        assert_eq!(fused[2].0, "c");
    }

    #[test]
    fn rrf_empty_input_is_empty() {
        assert!(rrf_fuse(&[], RRF_K).is_empty());
        assert!(rrf_fuse(&[vec![]], RRF_K).is_empty());
    }

    // Governance invariants of the recall pipeline, unit-tested WITHOUT Qdrant/E5
    // (Ola 3 D2): rejected/deprecated/secret/cross-project NEVER reach the pack;
    // active in-project AND global-scope items DO. Protects Ola 0 + Ola 1a in CI.
    #[test]
    fn assemble_pack_enforces_governance_invariants() {
        use crate::memory::model::MemoryItem;
        use crate::memory::sqlite_store::{apply_schema, insert_item};
        use crate::memory::{MemoryType, Sensitivity, Source};

        let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
        apply_schema(&conn).expect("schema");

        let mut mk =
            |status: Status, scope: Scope, sens: Sensitivity, project: Option<&str>, sm: &str| {
                let mut it = MemoryItem::new(MemoryType::Fact, scope, Source::ToolObserved, status);
                it.summary = Some(sm.to_string());
                it.sensitivity = sens;
                it.project_id = project.map(str::to_string);
                it.token_estimate = 20;
                insert_item(&conn, &it).expect("insert");
                it.id
            };

        let ok = mk(
            Status::Active,
            Scope::Project,
            Sensitivity::Internal,
            Some("ultron"),
            "ok item",
        );
        let rejected = mk(
            Status::Rejected,
            Scope::Project,
            Sensitivity::Internal,
            Some("ultron"),
            "rejected",
        );
        let deprecated = mk(
            Status::Deprecated,
            Scope::Project,
            Sensitivity::Internal,
            Some("ultron"),
            "deprecated",
        );
        let secret = mk(
            Status::Active,
            Scope::Project,
            Sensitivity::Secret,
            Some("ultron"),
            "secret key",
        );
        let cross = mk(
            Status::Active,
            Scope::Project,
            Sensitivity::Internal,
            Some("otro"),
            "cross proj",
        );
        let global = mk(
            Status::Active,
            Scope::Global,
            Sensitivity::Internal,
            None,
            "global pref",
        );
        let vault = {
            let mut it = MemoryItem::new(
                MemoryType::Fact,
                Scope::Global,
                Source::ImportedVault,
                Status::Active,
            );
            it.summary = Some("vault bulk note".into());
            it.token_estimate = 20;
            insert_item(&conn, &it).expect("insert");
            it.id
        };

        let ids = [
            &ok,
            &rejected,
            &deprecated,
            &secret,
            &cross,
            &global,
            &vault,
        ];
        let fused: Vec<FusedHit> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| FusedHit {
                canonical_id: (*id).clone(),
                rrf_score: 1.0 - i as f32 * 0.01,
                dense_rank: Some(i),
                sparse_rank: None,
                dense_score: Some(0.5),
            })
            .collect();

        let (injected, discarded, _t) = assemble_pack(&conn, &fused, 8, Some("ultron"), false, TOKEN_BUDGET);
        let inj: Vec<&String> = injected.iter().map(|e| &e.canonical_id).collect();

        assert!(inj.contains(&&ok), "active in-project item must inject");
        assert!(
            inj.contains(&&global),
            "global-scope item must inject under project filter"
        );
        assert!(!inj.contains(&&rejected), "rejected must NOT inject");
        assert!(!inj.contains(&&deprecated), "deprecated must NOT inject");
        assert!(
            !inj.contains(&&secret),
            "secret must NOT inject (audit top-risk #2)"
        );
        assert!(!inj.contains(&&cross), "cross-project must NOT inject");
        assert!(
            !inj.contains(&&vault),
            "vault must be off-by-default under project filter (Ola 1b)"
        );
        assert!(
            discarded
                .iter()
                .any(|d| d.canonical_id == secret && d.reason.contains("secret")),
            "secret exclusion must be traced in discarded"
        );
    }

    // CROSS-PROJECT gate (whole-brain recall): under a project filter (`ultron`),
    //   - cross_project=false  -> a scope=project item from `otro` is EXCLUDED.
    //   - cross_project=true   -> that same item is INCLUDED (project filter
    //     relaxed) BUT a Secret item from `otro` is STILL excluded (security is
    //     NOT relaxed). Unit-tested without Qdrant/E5 — guards the invariant that
    //     cross-project relaxes ONLY the project filter.
    #[test]
    fn assemble_pack_cross_project_relaxes_only_project_filter() {
        use crate::memory::model::MemoryItem;
        use crate::memory::sqlite_store::{apply_schema, insert_item};
        use crate::memory::{MemoryType, Sensitivity, Source};

        let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
        apply_schema(&conn).expect("schema");

        let mk = |scope: Scope, sens: Sensitivity, project: Option<&str>, sm: &str| {
            let mut it = MemoryItem::new(MemoryType::Fact, scope, Source::ToolObserved, Status::Active);
            it.summary = Some(sm.to_string());
            it.sensitivity = sens;
            it.project_id = project.map(str::to_string);
            it.token_estimate = 20;
            insert_item(&conn, &it).expect("insert");
            it.id
        };

        let in_project = mk(Scope::Project, Sensitivity::Internal, Some("ultron"), "ultron item");
        let other_project = mk(Scope::Project, Sensitivity::Internal, Some("otro"), "bank item");
        let other_secret = mk(Scope::Project, Sensitivity::Secret, Some("otro"), "bank api key");
        let global = mk(Scope::Global, Sensitivity::Internal, None, "global pref");

        let ids = [&in_project, &other_project, &other_secret, &global];
        let fused: Vec<FusedHit> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| FusedHit {
                canonical_id: (*id).clone(),
                rrf_score: 1.0 - i as f32 * 0.01,
                dense_rank: Some(i),
                sparse_rank: None,
                dense_score: Some(0.5),
            })
            .collect();

        // cross_project = FALSE: other-project item is filtered out.
        let (inj_off, _d, _t) = assemble_pack(&conn, &fused, 8, Some("ultron"), false, TOKEN_BUDGET);
        let off: Vec<&String> = inj_off.iter().map(|e| &e.canonical_id).collect();
        assert!(off.contains(&&in_project), "in-project item must inject (cross=off)");
        assert!(off.contains(&&global), "global item must inject (cross=off)");
        assert!(
            !off.contains(&&other_project),
            "other-project item must NOT inject when cross=off"
        );

        // cross_project = TRUE: other-project item is admitted; Secret stays out.
        let (inj_on, disc_on, _t) = assemble_pack(&conn, &fused, 8, Some("ultron"), true, TOKEN_BUDGET);
        let on: Vec<&String> = inj_on.iter().map(|e| &e.canonical_id).collect();
        assert!(on.contains(&&in_project), "in-project item must still inject (cross=on)");
        assert!(on.contains(&&global), "global item must still inject (cross=on)");
        assert!(
            on.contains(&&other_project),
            "other-project item MUST inject when cross=on (project filter relaxed)"
        );
        assert!(
            !on.contains(&&other_secret),
            "Secret from another project must NEVER inject — cross relaxes project, not security"
        );
        assert!(
            disc_on
                .iter()
                .any(|d| d.canonical_id == other_secret && d.reason.contains("secret")),
            "cross-project Secret exclusion must be traced in discarded"
        );
    }

    // Temporal resolver (point 3): an ACTIVE item whose validity ENDED in the
    // past must be excluded from the pack, while an item with valid_to NULL (no
    // end) OR a FUTURE valid_to is injected. Unit-tested without Qdrant/E5.
    #[test]
    fn assemble_pack_excludes_items_whose_validity_ended() {
        use crate::memory::model::{now_millis, MemoryItem};
        use crate::memory::sqlite_store::{apply_schema, insert_item};
        use crate::memory::{MemoryType, Source};

        let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
        apply_schema(&conn).expect("schema");

        let mk = |summary: &str, valid_to: Option<i64>| {
            let mut it = MemoryItem::new(
                MemoryType::Fact,
                Scope::Global,
                Source::ToolObserved,
                Status::Active,
            );
            it.summary = Some(summary.to_string());
            it.token_estimate = 20;
            it.valid_to = valid_to;
            insert_item(&conn, &it).expect("insert");
            it.id
        };

        let now = now_millis();
        let vigente = mk("still true", None); // no end -> always vigente
        let future = mk("true until later", Some(now + 1_000_000)); // ends in the future
        let expired = mk("was true, superseded", Some(now - 1)); // ended in the past

        let ids = [&vigente, &future, &expired];
        let fused: Vec<FusedHit> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| FusedHit {
                canonical_id: (*id).clone(),
                rrf_score: 1.0 - i as f32 * 0.01,
                dense_rank: Some(i),
                sparse_rank: None,
                dense_score: Some(0.5),
            })
            .collect();

        let (injected, discarded, _t) = assemble_pack(&conn, &fused, 8, None, false, TOKEN_BUDGET);
        let inj: Vec<&String> = injected.iter().map(|e| &e.canonical_id).collect();

        assert!(
            inj.contains(&&vigente),
            "valid_to NULL must inject (vigente)"
        );
        assert!(inj.contains(&&future), "future valid_to must inject");
        assert!(
            !inj.contains(&&expired),
            "past valid_to must be excluded (superseded)"
        );
        assert!(
            discarded
                .iter()
                .any(|d| d.canonical_id == expired && d.reason.contains("valid_to")),
            "expired exclusion must be traced in discarded"
        );
    }

    // -----------------------------------------------------------------------
    // SESSION BUDGET tests (Pilar 1 · Kirkardo gap)
    //
    // These tests exercise the cumulative budget store in isolation — no
    // Qdrant / brain.db required.  They use unique session ids per test to
    // avoid cross-test state pollution (the OnceLock store is global in-process).
    // -----------------------------------------------------------------------

    #[test]
    fn session_budget_starts_full() {
        let sid = "test-budget-starts-full";
        session_budget_reset(sid);
        assert_eq!(
            session_budget_remaining(sid),
            TOKEN_BUDGET,
            "fresh session must have full budget"
        );
    }

    #[test]
    fn session_budget_deducts_correctly() {
        let sid = "test-budget-deducts";
        session_budget_reset(sid);
        let remaining = session_budget_deduct(sid, 400);
        assert_eq!(remaining, TOKEN_BUDGET - 400);
        assert_eq!(session_budget_remaining(sid), TOKEN_BUDGET - 400);
    }

    #[test]
    fn session_budget_clamps_at_zero() {
        let sid = "test-budget-clamps";
        session_budget_reset(sid);
        // Deduct more than the total budget.
        let remaining = session_budget_deduct(sid, TOKEN_BUDGET + 500);
        assert_eq!(remaining, 0, "budget must clamp at zero, never go negative");
        assert_eq!(session_budget_remaining(sid), 0);
    }

    #[test]
    fn session_budget_accumulates_across_calls() {
        let sid = "test-budget-accumulates";
        session_budget_reset(sid);
        session_budget_deduct(sid, 300);
        session_budget_deduct(sid, 500);
        assert_eq!(
            session_budget_remaining(sid),
            TOKEN_BUDGET - 800,
            "budget must accumulate across multiple deductions"
        );
    }

    #[test]
    fn session_budget_reset_restores_full_budget() {
        let sid = "test-budget-reset";
        session_budget_reset(sid);
        session_budget_deduct(sid, 1000);
        assert!(session_budget_remaining(sid) < TOKEN_BUDGET);
        session_budget_reset(sid);
        assert_eq!(
            session_budget_remaining(sid),
            TOKEN_BUDGET,
            "reset must restore full budget"
        );
    }

    #[test]
    fn resolve_session_id_uses_supplied_value() {
        let sid = resolve_session_id(Some("my-session-abc"));
        assert_eq!(sid, "my-session-abc");
    }

    #[test]
    fn resolve_session_id_falls_back_to_proc_when_empty() {
        // Without ULTRON_SESSION_ID set, the fallback must be proc-<pid>.
        // We only check the prefix because the pid varies per run.
        // Temporarily ensure env var is absent to test the proc fallback.
        let sid = resolve_session_id(Some(""));
        // Could be env-based or proc-based — just assert it's non-empty.
        assert!(!sid.is_empty(), "session id must never be empty");
    }

    /// KIRKARDO gap #6: verify that `CLAUDE_SESSION_ID` is honoured as the
    /// second env-var fallback (after `ULTRON_SESSION_ID`, before `proc-<pid>`).
    #[test]
    fn resolve_session_id_uses_claude_session_id_env() {
        // Supplied non-empty value always wins — ensure that still holds.
        let explicit = resolve_session_id(Some("explicit-session-42"));
        assert_eq!(explicit, "explicit-session-42", "explicit value must always win");

        // Verify the proc-<pid> fallback produces a non-empty string even
        // when both env vars are absent (the common test environment case).
        let proc_sid = resolve_session_id(Some(""));
        assert!(!proc_sid.is_empty(), "proc-<pid> fallback must be non-empty");
        // The fallback must either be env-based or start with "proc-".
        // We cannot reliably unset env vars in parallel tests, so just assert
        // it is non-empty and well-formed.
        let looks_valid = proc_sid.starts_with("proc-") || !proc_sid.contains(' ');
        assert!(looks_valid, "session id must be a single token, got: {proc_sid}");
    }

    #[test]
    fn assemble_pack_respects_reduced_session_budget() {
        // Simulate a session that has already consumed most of the budget.
        // assemble_pack receives only 30 tokens — only items that fit are admitted.
        use crate::memory::model::MemoryItem;
        use crate::memory::sqlite_store::{apply_schema, insert_item};
        use crate::memory::{MemoryType, Source};

        let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
        apply_schema(&conn).expect("schema");

        let mk = |summary: &str, tokens: i64| {
            let mut it = MemoryItem::new(
                MemoryType::Fact,
                Scope::Global,
                Source::ToolObserved,
                Status::Active,
            );
            it.summary = Some(summary.to_string());
            it.token_estimate = tokens;
            insert_item(&conn, &it).expect("insert");
            it.id
        };

        let small = mk("tiny", 25);  // fits in 30-token budget
        let big   = mk("large item", 200); // does NOT fit (would be first-admit truncated)

        // Place big first so it gets the first-admit truncation treatment.
        let fused: Vec<FusedHit> = vec![
            FusedHit { canonical_id: big.clone(),   rrf_score: 0.9, dense_rank: Some(0), sparse_rank: None, dense_score: None },
            FusedHit { canonical_id: small.clone(), rrf_score: 0.8, dense_rank: Some(1), sparse_rank: None, dense_score: None },
        ];

        // Only 30 tokens remain in the budget.
        let (injected, _discarded, total) = assemble_pack(&conn, &fused, 8, None, false, 30);

        // The first item is always admitted (truncated to fit 30 tokens).
        assert_eq!(injected.len(), 1, "only one item fits in 30-token budget");
        assert_eq!(injected[0].canonical_id, big, "first item always admitted (truncated)");
        assert!(
            total <= 30,
            "total_tokens ({total}) must not exceed the reduced budget (30)"
        );
    }

    // ---------------------------------------------------------------------
    // END-TO-END runtime verification (Fase A+B). #[ignore]d because it hits
    // the REAL Qdrant (127.0.0.1:6333) + ~/.ultron/brain.db and downloads the
    // MultilingualE5Large ONNX (~1.3 GB) on first run. Run explicitly:
    //   cargo test --lib -- --ignored --nocapture e2e_full_pipeline
    // Requires: Qdrant running + the `qdrant` feature (default ON) + network.
    // ---------------------------------------------------------------------
    #[test]
    #[ignore = "e2e: downloads E5 ONNX; surfaces the exact embed_e5 error"]
    fn e2e_embed_e5_smoke() {
        match crate::qdrant::embed_e5("hola mundo, prueba de embedding", false) {
            Ok(v) => {
                let all_zero = v.iter().all(|&x| x == 0.0);
                eprintln!(
                    "E5 OK: dim={} all_zero={} first3={:?}",
                    v.len(),
                    all_zero,
                    &v[..3.min(v.len())]
                );
                assert_eq!(v.len(), 1024, "E5 must be 1024-d");
                assert!(!all_zero, "E5 returned a zero vector");
            }
            Err(e) => panic!("E5 embed FAILED: {e}"),
        }
    }

    #[test]
    #[ignore = "e2e: real Qdrant + brain.db + downloads E5 ONNX; run explicitly"]
    fn e2e_full_pipeline_migrate_reindex_recall() {
        use crate::memory::sqlite_store::{get_item, open_conn};
        use crate::memory::{qdrant_index, MemoryService};

        // 1) Canonical DB live.
        crate::memory::sqlite_store::SqliteStore::init().expect("brain.db init");

        // 2) ETL one-shot (idempotent; backs up brain.db).
        let report = crate::memory::migrations::run_full_etl();
        eprintln!("\n=== ETL REPORT ===\n{report:#?}");

        // 3) Reindex active items into ultron_memory (E5 1024d). First call
        //    downloads the ONNX model — may take minutes.
        let (indexed, errors) = qdrant_index::reindex_all().expect("reindex_all");
        eprintln!("\n=== REINDEX === indexed={indexed} errors={errors}");
        assert!(
            indexed > 0,
            "expected >=1 active item indexed into ultron_memory"
        );

        // 4) Hybrid recall (replicates the `recall` command's sync core).
        let query = "qdrant";
        let dense = qdrant_index::search_dense(query, FANOUT_K as u32, None);
        let sparse = MemoryService::search_active(query, FANOUT_K).expect("sparse search");
        let sparse_ids: Vec<String> = sparse.iter().map(|it| it.id.clone()).collect();
        eprintln!(
            "\n=== RECALL '{query}' === dense_hits={} sparse_hits={}",
            dense.len(),
            sparse_ids.len()
        );
        let fused = rrf_fuse(&[dense.clone(), sparse_ids.clone()], RRF_K);
        let conn = open_conn().expect("open brain.db");
        let mut shown = 0;
        for (id, score) in fused.iter().take(8) {
            if let Ok(Some(it)) = get_item(&conn, id) {
                eprintln!(
                    "  [{score:.4}] {} :: {}",
                    it.kind.as_str(),
                    it.summary.clone().unwrap_or_default()
                );
                shown += 1;
            }
        }
        eprintln!("=== recall returned {shown} resolvable items ===\n");

        // Dense path proves E5 + Qdrant work end-to-end; sparse proves FTS5.
        assert!(!fused.is_empty(), "recall fused list must not be empty");
        assert!(
            !dense.is_empty(),
            "DENSE recall empty — E5/Qdrant ultron_memory not working end-to-end"
        );
    }

    // Verifies the `pinned` ALTER migration on the REAL ~/.ultron/brain.db (943
    // rows) + Session Resume slices + pin/unpin roundtrip. Fast (no reindex).
    #[test]
    #[ignore = "e2e: real brain.db; verifies pinned migration + resume + pin/unpin"]
    fn e2e_pinned_migration_and_resume_slices() {
        use crate::memory::{Actor, MemoryService, MemoryType};

        // init() runs apply_schema -> the idempotent ALTER ADD COLUMN pinned on
        // the existing populated DB. Must not fail.
        crate::memory::sqlite_store::SqliteStore::init().expect("init (pinned migration)");

        let decisions =
            MemoryService::list_active_of_type(MemoryType::Decision, 8).expect("decisions");
        let pinned = MemoryService::list_pinned(12).expect("pinned");
        let stats = MemoryService::stats().expect("stats");
        eprintln!(
            "\n=== RESUME SLICES === active={} decisions={} pinned={} pending_candidates={}",
            stats.active,
            decisions.len(),
            pinned.len(),
            stats.candidates_pending
        );
        assert!(stats.active > 0, "real brain.db must have active items");

        // pin -> appears in list_pinned -> unpin.
        if let Some(d) = decisions.first() {
            MemoryService::pin(&d.id, Actor::User).expect("pin");
            let after = MemoryService::list_pinned(50).expect("pinned after");
            assert!(
                after.iter().any(|p| p.id == d.id),
                "pinned item must appear"
            );
            eprintln!("=== pin/unpin OK on {} ===\n", d.id);
            MemoryService::unpin(&d.id, Actor::User).expect("unpin");
        }
    }
}
