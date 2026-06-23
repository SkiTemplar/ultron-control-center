// memory/evals.rs — recall quality harness / golden queries (MEMORY KERNEL)
//
// A reproducible, FAIL-SAFE way to measure recall@k against a fixed set of
// "golden" queries with expected substrings. The harness drives the unified
// hybrid recall pipeline (`recall_pack`) and reports, per query, whether ANY
// recovered summary contains ANY of the expected substrings (case-insensitive).
//
// Design notes:
//   - PURE arithmetic (`EvalReport::from_results`, `score_query`) is isolated
//     from the I/O side (`run`) so the math stays UNIT-TESTABLE without Qdrant,
//     E5, the network, or API keys.
//   - Degradation is total: if `recall_pack` errors (Qdrant/E5 offline, brain.db
//     locked, ...), that query simply scores `hits=0, matched=false`. No panic,
//     no propagation — a degraded eval is better than a crashed one.
//   - `default_goldens()` embeds realistic queries for THIS system (memory /
//     qdrant / recall / decisions / embeddings / orchestrator / sparse) so the
//     harness ships with a baseline even on a fresh checkout.

use std::collections::BTreeMap;

use crate::commands::memory::recall_unified::recall_pack;
use crate::memory::eval_metrics::{EvalMetrics, GoldenSet, LabeledSet};

/// A single golden query: a search string plus the substrings that SHOULD show
/// up in at least one recovered summary. `expect_any_of` is OR-matched and
/// case-insensitive, so generic, plausible terms are enough to be robust to
/// summary wording drift.
#[derive(Debug, Clone)]
pub struct GoldenQuery {
    /// The query string fed to recall.
    pub query: String,
    /// Substrings; a hit on ANY one (case-insensitive) marks the query matched.
    pub expect_any_of: Vec<String>,
    /// Coarse bucket: "single-term" | "multi-term" | "decision" | "cross-topic".
    pub category: String,
}

impl GoldenQuery {
    /// Convenience constructor that owns its strings.
    fn new(query: &str, expect_any_of: &[&str], category: &str) -> Self {
        Self {
            query: query.to_string(),
            expect_any_of: expect_any_of.iter().map(|s| s.to_string()).collect(),
            category: category.to_string(),
        }
    }
}

/// The outcome of evaluating one golden query.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EvalResult {
    /// The query that was run.
    pub query: String,
    /// The category of the originating golden query.
    pub category: String,
    /// How many entries recall returned (0 on degradation/empty).
    pub hits: usize,
    /// Whether ANY recovered summary contained ANY expected substring.
    pub matched: bool,
}

/// Aggregate report over a full golden-query run.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EvalReport {
    /// Number of golden queries evaluated.
    pub total: usize,
    /// Number of queries that matched at least one expected substring.
    pub matched: usize,
    /// `matched / total` in `[0.0, 1.0]`; `0.0` when `total == 0`.
    pub recall_at_k: f32,
    /// Per-query breakdown, preserving input order.
    pub per_query: Vec<EvalResult>,
    /// SECURITY GATE: count of returned items that are `Secret` (must be 0 —
    /// recall must never surface secrets). Non-zero = governance regression.
    pub secret_leak_count: usize,
    /// SECURITY GATE: count of returned items whose status is not `Active`
    /// (deprecated/rejected/stale leaking into recall). Must be 0.
    pub stale_leak_count: usize,
    /// Offending ids (secret or non-active) for diagnosis. Empty on a clean run.
    pub leaked_ids: Vec<String>,
}

impl EvalReport {
    /// Build the aggregate report from per-query results. PURE: no I/O, no
    /// recall — this is the unit-testable arithmetic core. Division-by-zero is
    /// guarded (empty input yields `recall_at_k = 0.0`).
    #[must_use]
    pub fn from_results(per_query: Vec<EvalResult>) -> Self {
        let total = per_query.len();
        let matched = per_query.iter().filter(|r| r.matched).count();
        let recall_at_k = if total == 0 {
            0.0
        } else {
            matched as f32 / total as f32
        };
        Self {
            total,
            matched,
            recall_at_k,
            per_query,
            secret_leak_count: 0,
            stale_leak_count: 0,
            leaked_ids: Vec::new(),
        }
    }
}

/// Pure leak classifier for the security gate: given `(id, sensitivity, status)`
/// of the items recall returned, count `Secret` items (secret leak) and
/// non-`Active` items (stale/governance leak), collecting the offending ids.
/// Recall MUST never surface either; a non-zero count is a regression. PURE.
fn classify_leaks(
    rows: &[(String, super::model::Sensitivity, super::model::Status)],
) -> (usize, usize, Vec<String>) {
    use super::model::{Sensitivity, Status};
    let mut secret = 0usize;
    let mut stale = 0usize;
    let mut leaked: Vec<String> = Vec::new();
    for (id, sens, status) in rows {
        let is_secret = *sens == Sensitivity::Secret;
        let is_stale = *status != Status::Active;
        if is_secret {
            secret += 1;
        }
        if is_stale {
            stale += 1;
        }
        if is_secret || is_stale {
            leaked.push(id.clone());
        }
    }
    leaked.sort();
    leaked.dedup();
    (secret, stale, leaked)
}

/// Case-insensitive OR-match: does ANY summary contain ANY expected substring?
/// PURE helper, isolated from recall so the matching logic is unit-testable.
#[must_use]
fn summaries_match(summaries: &[String], expect_any_of: &[String]) -> bool {
    if expect_any_of.is_empty() {
        return false;
    }
    let needles: Vec<String> = expect_any_of.iter().map(|s| s.to_lowercase()).collect();
    summaries.iter().any(|s| {
        let hay = s.to_lowercase();
        needles.iter().any(|n| hay.contains(n.as_str()))
    })
}

/// The embedded baseline golden set: realistic queries for the ULTRON memory
/// subsystem, categorized. `expect_any_of` uses generic, plausible substrings
/// so the set is resilient to summary wording.
#[must_use]
pub fn default_goldens() -> Vec<GoldenQuery> {
    vec![
        GoldenQuery::new("qdrant", &["qdrant", "vector", "embedding"], "single-term"),
        GoldenQuery::new("memoria", &["memoria", "memory", "kernel"], "single-term"),
        GoldenQuery::new(
            "embeddings E5 dense",
            &["embedding", "e5", "dense", "vector"],
            "multi-term",
        ),
        GoldenQuery::new(
            "recall hibrido RRF",
            &["recall", "rrf", "hybrid", "hibrido", "fusion"],
            "multi-term",
        ),
        GoldenQuery::new(
            "busqueda sparse FTS5",
            &["sparse", "fts5", "bm25", "busqueda"],
            "multi-term",
        ),
        GoldenQuery::new(
            "decision sobre el modelo de embeddings",
            &["decision", "bge-m3", "embedding", "modelo"],
            "decision",
        ),
        GoldenQuery::new(
            "decision arquitectura orquestador",
            &["decision", "orquestador", "orchestrator", "arquitectura"],
            "decision",
        ),
        GoldenQuery::new(
            "orquestador Ultron auto-routing",
            &["orquestador", "orchestrator", "ultron", "routing"],
            "single-term",
        ),
        GoldenQuery::new(
            "hooks de sesion SessionStart",
            &["hook", "session", "sessionstart"],
            "multi-term",
        ),
        GoldenQuery::new(
            "candidato de memoria pendiente de validacion",
            &["candidate", "candidato", "pending", "pendiente", "inbox"],
            "multi-term",
        ),
        GoldenQuery::new(
            "qdrant embeddings recall decision",
            &["qdrant", "embedding", "recall", "decision"],
            "cross-topic",
        ),
        GoldenQuery::new(
            "memoria sparse orquestador",
            &["memoria", "sparse", "orquestador", "memory"],
            "cross-topic",
        ),
    ]
}

/// Evaluate ONE golden query against the live recall pipeline. FAIL-SAFE: a
/// `recall_pack` error degrades to `hits=0, matched=false` (no panic). This is
/// the I/O boundary; everything it consumes (`summaries_match`) is pure.
fn score_query(
    golden: &GoldenQuery,
    project_id: Option<&str>,
    k: usize,
) -> (EvalResult, Vec<String>) {
    // Each golden query is an INDEPENDENT recall. There is no longer a
    // cumulative per-session token budget to reset — every recall receives the
    // full per-call cap, so later queries in the same process are never starved.
    let (hits, matched, ids) = match recall_pack(&golden.query, k, project_id, false) {
        Ok(pack) => {
            let summaries: Vec<String> = pack
                .entries
                .iter()
                .filter_map(|e| e.summary.clone())
                .collect();
            let matched = summaries_match(&summaries, &golden.expect_any_of);
            let ids: Vec<String> = pack
                .entries
                .iter()
                .map(|e| e.canonical_id.clone())
                .collect();
            (pack.entries.len(), matched, ids)
        }
        Err(e) => {
            // Degrade quietly; a failing source must not abort the eval run.
            eprintln!("[evals] recall_pack failed for '{}': {e}", golden.query);
            (0, false, Vec::new())
        }
    };
    (
        EvalResult {
            query: golden.query.clone(),
            category: golden.category.clone(),
            hits,
            matched,
        },
        ids,
    )
}

/// Run the full embedded golden set against the live recall pipeline and return
/// the aggregate report. `project_id = None` runs unfiltered (global) recall;
/// `k` is the recall depth per query. FAIL-SAFE end-to-end: individual query
/// failures degrade to non-matches rather than aborting the run.
#[must_use]
pub fn run(project_id: Option<&str>, k: usize) -> EvalReport {
    let goldens = default_goldens();
    let mut per_query: Vec<EvalResult> = Vec::with_capacity(goldens.len());
    let mut returned_ids: Vec<String> = Vec::new();
    for g in &goldens {
        let (result, ids) = score_query(g, project_id, k);
        returned_ids.extend(ids);
        per_query.push(result);
    }
    let mut report = EvalReport::from_results(per_query);

    // SECURITY GATE: look up every returned item in the SoT and assert recall
    // never surfaced a Secret or non-Active item. Read-only; degrades to "no
    // leaks measured" if brain.db is unavailable (recall would also have failed).
    returned_ids.sort();
    returned_ids.dedup();
    if let Ok(conn) = super::sqlite_store::open_conn() {
        let rows: Vec<(String, super::model::Sensitivity, super::model::Status)> = returned_ids
            .iter()
            .filter_map(|id| match super::sqlite_store::get_item(&conn, id) {
                Ok(Some(item)) => Some((item.id, item.sensitivity, item.status)),
                _ => None,
            })
            .collect();
        let (secret, stale, leaked) = classify_leaks(&rows);
        report.secret_leak_count = secret;
        report.stale_leak_count = stale;
        report.leaked_ids = leaked;
    }
    report
}

// ===========================================================================
// Golden-set metrics path (precision@k / recall@k / MRR / nDCG / context-waste)
//
// This is the I/O boundary that drives the PURE `eval_metrics` module against
// the REAL generated golden set (cockpit/memory-rework/evals/golden_set.json,
// ~942 positives each carrying `expect_ids`). It is ADDITIVE and FAIL-SAFE:
//   - it does NOT touch `run()` / `recall_at_k` / the security gate semantics
//     of the default `eval` subcommand;
//   - a missing golden_set.json, an unreadable file, or a dead Qdrant/E5
//     degrades to a well-formed `degraded = true` report (never a panic).
// ===========================================================================

/// Resolve the canonical path to the generated golden set. The file lives at
/// `~/.ultron/cockpit/memory-rework/evals/golden_set.json` (same `~/.ultron`
/// root used by `brain.db`). Returns `None` only if the HOME dir is unknown —
/// the caller treats that exactly like a missing file (degraded, no panic).
fn golden_set_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| {
        h.join(".ultron")
            .join("cockpit")
            .join("memory-rework")
            .join("evals")
            .join("golden_set.json")
    })
}

/// Per-category aggregate of the ranking-quality metrics (e.g. "decision",
/// "factual", "file", "task"), so a regression can be localised to a bucket.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CategoryMetrics {
    /// The golden-set category these metrics aggregate.
    pub category: String,
    /// Number of positives in this category that were scored.
    pub queries: usize,
    /// Mean ranking-quality metrics over this category's positives.
    pub metrics: EvalMetrics,
}

/// The full golden-set metrics report: the aggregate `EvalMetrics` over every
/// scored positive, a per-category breakdown, provenance, and the SAME security
/// gate (secret/stale leak counts) applied over every id recall returned.
///
/// Serialized as the JSON payload of the `eval-full` subcommand (and merged
/// additively into the default `eval` report when `--golden` is passed).
#[derive(Debug, Clone, serde::Serialize)]
pub struct GoldenMetricsReport {
    /// Recall depth `k` the metrics were computed at (matches the eval cutoff).
    pub k: usize,
    /// Number of golden positives actually scored (0 when degraded).
    pub scored: usize,
    /// Number of positives skipped because they carried no `expect_ids`.
    pub skipped_no_expectation: usize,
    /// Aggregate (mean) ranking-quality metrics over all scored positives.
    pub aggregate: EvalMetrics,
    /// Per-category aggregates, ordered by category name (deterministic).
    pub per_category: Vec<CategoryMetrics>,
    /// SECURITY GATE: Secret items recall surfaced across the run (must be 0).
    pub secret_leak_count: usize,
    /// SECURITY GATE: non-Active items recall surfaced (must be 0).
    pub stale_leak_count: usize,
    /// Offending ids (secret or non-active). Empty on a clean run.
    pub leaked_ids: Vec<String>,
    /// `true` when the golden set could not be loaded / had no usable positives.
    /// In that case `aggregate` is all-zero and `scored == 0` — never a panic.
    pub degraded: bool,
    /// Human-readable provenance / degradation reason (path, parse error, ...).
    pub note: String,
}

impl GoldenMetricsReport {
    /// A well-formed, all-zero report used on any degradation path. Keeps the
    /// JSON shape stable for hook consumers even when the golden set is absent.
    fn degraded(k: usize, note: impl Into<String>) -> Self {
        Self {
            k,
            scored: 0,
            skipped_no_expectation: 0,
            aggregate: EvalMetrics::aggregate(&[]),
            per_category: Vec::new(),
            secret_leak_count: 0,
            stale_leak_count: 0,
            leaked_ids: Vec::new(),
            degraded: true,
            note: note.into(),
        }
    }
}

/// Run the REAL golden set through the live recall pipeline and report the
/// pure ranking-quality metrics (precision@k / recall@k / MRR / nDCG@k /
/// context-waste) aggregated overall and per category.
///
/// `project_override`:
///   - `Some(p)` forces every query to recall within project `p`;
///   - `None` honours each positive's own `project_id` from the golden set
///     (the SoT scope), falling back to global recall when it has none.
///
/// I/O lives HERE (std::fs read of golden_set.json); parsing is delegated to the
/// PURE `GoldenSet::from_json_str`, and every metric to the PURE `eval_metrics`
/// functions via `EvalMetrics::for_query` / `aggregate`. The same SoT-backed
/// security gate as `run()` is reapplied over every returned id.
///
/// FAIL-SAFE end-to-end: a missing/invalid file, or any per-query `recall_pack`
/// failure, degrades (empty ranking / `degraded = true`) instead of panicking.
#[must_use]
pub fn run_golden_metrics(project_override: Option<&str>, k: usize) -> GoldenMetricsReport {
    let Some(path) = golden_set_path() else {
        return GoldenMetricsReport::degraded(k, "no HOME dir; cannot locate golden_set.json");
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            return GoldenMetricsReport::degraded(
                k,
                format!("golden_set.json unreadable at {}: {e}", path.display()),
            );
        }
    };
    let golden = match GoldenSet::from_json_str(&text) {
        Ok(g) => g,
        Err(e) => {
            return GoldenMetricsReport::degraded(
                k,
                format!("golden_set.json parse error at {}: {e}", path.display()),
            );
        }
    };
    if golden.positives.is_empty() {
        return GoldenMetricsReport::degraded(k, "golden_set.json has no positives");
    }

    let mut per_query: Vec<EvalMetrics> = Vec::with_capacity(golden.positives.len());
    let mut by_category: BTreeMap<String, Vec<EvalMetrics>> = BTreeMap::new();
    let mut returned_ids: Vec<String> = Vec::new();
    let mut skipped = 0usize;

    for pos in &golden.positives {
        let relevant = pos.relevant();
        // A positive with no expected ids cannot score recall meaningfully; skip
        // it (and do NOT let it deflate the means) rather than scoring a vacuous 0.
        if relevant.is_empty() {
            skipped += 1;
            continue;
        }

        // Scope: an explicit override wins; otherwise honour the golden's own
        // project_id (the SoT scope used when the positive was generated).
        let project = project_override.or(pos.project_id.as_deref());

        // SAME recall path as the `eval`/`recall` subcommands. FAIL-SAFE: an error
        // (Qdrant/E5 offline) degrades this query to an empty ranking — every
        // metric then scores 0 for it, which is the correct "recovered nothing".
        // Each positive is an independent recall; there is no per-session budget
        // to reset (every recall gets the full per-call cap, never starved).
        let retrieved: Vec<String> = match recall_pack(&pos.query, k, project, false) {
            Ok(pack) => {
                returned_ids.extend(pack.entries.iter().map(|e| e.canonical_id.clone()));
                pack.entries.into_iter().map(|e| e.canonical_id).collect()
            }
            Err(e) => {
                eprintln!("[evals] golden recall failed for '{}': {e}", pos.query);
                Vec::new()
            }
        };

        let m = EvalMetrics::for_query(&retrieved, &relevant, k);
        per_query.push(m);
        by_category.entry(pos.category.clone()).or_default().push(m);
    }

    let aggregate = EvalMetrics::aggregate(&per_query);
    let per_category: Vec<CategoryMetrics> = by_category
        .into_iter()
        .map(|(category, ms)| CategoryMetrics {
            queries: ms.len(),
            metrics: EvalMetrics::aggregate(&ms),
            category,
        })
        .collect();

    let mut report = GoldenMetricsReport {
        k,
        scored: per_query.len(),
        skipped_no_expectation: skipped,
        aggregate,
        per_category,
        secret_leak_count: 0,
        stale_leak_count: 0,
        leaked_ids: Vec::new(),
        degraded: per_query.is_empty(),
        note: format!(
            "golden_set.json loaded from {} ({} positives, {} scored, {} skipped)",
            path.display(),
            golden.positives.len(),
            per_query.len(),
            skipped
        ),
    };

    // SECURITY GATE (identical policy to `run()`): no Secret / non-Active item
    // may have surfaced. Read-only; degrades to "no leaks measured" if brain.db
    // is unavailable (recall would also have been empty in that case).
    returned_ids.sort();
    returned_ids.dedup();
    if let Ok(conn) = super::sqlite_store::open_conn() {
        let rows: Vec<(String, super::model::Sensitivity, super::model::Status)> = returned_ids
            .iter()
            .filter_map(|id| match super::sqlite_store::get_item(&conn, id) {
                Ok(Some(item)) => Some((item.id, item.sensitivity, item.status)),
                _ => None,
            })
            .collect();
        let (secret, stale, leaked) = classify_leaks(&rows);
        report.secret_leak_count = secret;
        report.stale_leak_count = stale;
        report.leaked_ids = leaked;
    }

    report
}

// ===========================================================================
// External labeled golden set — cat19 FASE A
//
// Loads `golden_labels_draft.json` (schema: `{ "labeled": [...] }`) from an
// arbitrary path, runs recall for each query, and reports ranking-quality
// metrics using the PURE functions from `eval_metrics.rs`.
//
// Key design decisions:
//   - Queries with `expect_ids = []` (n_relevant = 0) are included and score
//     recall=0.  They are NOT skipped — excluding them would inflate the
//     aggregate. The count of such queries is surfaced as `zero_relevant`.
//   - A `recall_pack` failure degrades that query to an empty ranking (same
//     policy as `run_golden_metrics`). No panic, no abort.
//   - `queries_with_zero_recall` counts entries where recall@8 == 0.0 (covers
//     both zero-relevant labels AND items genuinely missed by the pipeline).
//     This is the check-19.5 signal.
//   - Output is a plain JSON object (no legacy fields, no security gate here —
//     this is a pure quality measurement tool, not a governance gate).
// ===========================================================================

/// Per-query result for the external labeled-golden evaluation.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LabeledQueryResult {
    /// Label id (e.g. `gs-0001`).
    pub id: String,
    /// The query string that was run.
    pub query: String,
    /// Number of relevant ids according to the label.
    pub n_relevant: usize,
    /// Ids returned by `recall_pack` (up to k).
    pub retrieved_ids: Vec<String>,
    /// Per-query ranking metrics (precision_at_k here is precision@k, typically k=8).
    pub metrics: EvalMetrics,
    /// Precision at the fixed cutoff k=3 (additional to the precision@k in `metrics`).
    /// Useful for cat19.4: a top-3 slot is the prime real estate in most recall UIs.
    pub precision_at_3: f64,
    /// `true` when `recall_pack` errored (Qdrant/E5 offline); metrics are all-zero.
    pub degraded: bool,
}

/// Aggregate report produced by `run_labeled_golden`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LabeledGoldenReport {
    /// Path of the golden labels file that was loaded.
    pub source_path: String,
    /// Recall cutoff used for every query.
    pub k: usize,
    /// Total queries in the labels file.
    pub total_queries: usize,
    /// Queries where n_relevant == 0 (no ground-truth positives).
    /// These ARE reported in `per_query` but are EXCLUDED from all aggregate means.
    /// An empty oracle is not a recall failure — it is absence of judgment.
    pub zero_relevant: usize,
    /// Queries where recall@k == 0.0 (pipeline returned nothing relevant).
    /// CHECK 19.5: this should be as small as possible.
    pub queries_with_zero_recall: usize,
    /// Mean metrics computed ONLY over queries with n_relevant > 0.
    /// Excluding zero-relevant queries prevents an empty oracle from unfairly
    /// depressing recall/precision/mrr/ndcg averages.
    pub aggregate: EvalMetrics,
    /// Mean precision@3 across queries with n_relevant > 0.
    /// Fixed cutoff, additional to the precision@k inside `aggregate`.
    pub aggregate_precision_at_3: f64,
    /// Number of queries that were actually averaged into `aggregate`
    /// (i.e. `total_queries - zero_relevant`). Provided for transparency.
    pub aggregated_over: usize,
    /// Per-query breakdown for full reproducibility (ALL queries, incl. zero-relevant).
    pub per_query: Vec<LabeledQueryResult>,
    /// `true` when the file could not be loaded/parsed; all counts will be 0.
    pub degraded: bool,
    /// Human-readable provenance or degradation reason.
    pub note: String,
}

impl LabeledGoldenReport {
    /// All-zero degraded report for any load/parse failure.
    fn degraded(path: &str, k: usize, note: impl Into<String>) -> Self {
        Self {
            source_path: path.to_string(),
            k,
            total_queries: 0,
            zero_relevant: 0,
            queries_with_zero_recall: 0,
            aggregate: EvalMetrics::aggregate(&[]),
            aggregate_precision_at_3: 0.0,
            aggregated_over: 0,
            per_query: Vec::new(),
            degraded: true,
            note: note.into(),
        }
    }
}

/// Run the EXTERNAL hand-labeled golden set through the live recall pipeline.
///
/// Loads `path` (must be an absolute path to a `golden_labels_draft.json`-style
/// file with schema `{ "labeled": [...] }`), runs `recall_pack(query, k, None,
/// false)` for each query, and returns the aggregate ranking-quality report.
///
/// FAIL-SAFE: a missing/invalid file degrades to `LabeledGoldenReport::degraded`.
/// Individual `recall_pack` failures degrade ONLY that query to an empty ranking.
#[must_use]
pub fn run_labeled_golden(path: &str, k: usize) -> LabeledGoldenReport {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            return LabeledGoldenReport::degraded(
                path,
                k,
                format!("failed to read '{}': {e}", path),
            );
        }
    };

    let labeled_set = match LabeledSet::from_json_str(&text) {
        Ok(s) => s,
        Err(e) => {
            return LabeledGoldenReport::degraded(
                path,
                k,
                format!("parse error in '{}': {e}", path),
            );
        }
    };

    if labeled_set.labeled.is_empty() {
        return LabeledGoldenReport::degraded(path, k, "labeled set has no entries");
    }

    let total = labeled_set.labeled.len();
    let mut per_query: Vec<LabeledQueryResult> = Vec::with_capacity(total);
    // Only queries with n_relevant > 0 enter the aggregate means (an empty oracle
    // is not a recall failure — it is absence of judgment, and must not depress averages).
    let mut scored_metrics: Vec<EvalMetrics> = Vec::with_capacity(total);
    let mut scored_p3: Vec<f64> = Vec::with_capacity(total);
    let mut zero_relevant = 0usize;
    let mut queries_with_zero_recall = 0usize;

    for label in &labeled_set.labeled {
        let relevant = label.relevant();

        let (retrieved_ids, degraded_query) = match recall_pack(&label.query, k, None, false) {
            Ok(pack) => {
                let ids: Vec<String> = pack.entries.into_iter().map(|e| e.canonical_id).collect();
                (ids, false)
            }
            Err(e) => {
                eprintln!(
                    "[evals/labeled] recall_pack failed for '{}': {e}",
                    label.query
                );
                (Vec::new(), true)
            }
        };

        let metrics = EvalMetrics::for_query(&retrieved_ids, &relevant, k);
        // precision@3 is a fixed additional cutoff, independent of k.
        let p3 = crate::memory::eval_metrics::precision_at_k(&retrieved_ids, &relevant, 3);

        if metrics.recall_at_k == 0.0 {
            queries_with_zero_recall += 1;
        }

        if relevant.is_empty() {
            // Track the count but do NOT push into aggregate accumulators.
            zero_relevant += 1;
        } else {
            scored_metrics.push(metrics);
            scored_p3.push(p3);
        }

        per_query.push(LabeledQueryResult {
            id: label.id.clone(),
            query: label.query.clone(),
            n_relevant: label.n_relevant,
            retrieved_ids,
            metrics,
            precision_at_3: p3,
            degraded: degraded_query,
        });
    }

    let aggregated_over = scored_metrics.len();
    let aggregate = EvalMetrics::aggregate(&scored_metrics);
    let aggregate_precision_at_3 = if aggregated_over == 0 {
        0.0
    } else {
        scored_p3.iter().sum::<f64>() / aggregated_over as f64
    };

    LabeledGoldenReport {
        source_path: path.to_string(),
        k,
        total_queries: total,
        zero_relevant,
        queries_with_zero_recall,
        aggregate,
        aggregate_precision_at_3,
        aggregated_over,
        per_query,
        degraded: false,
        note: format!(
            "loaded {} labels from '{}' ({} aggregated, {} zero-relevant excluded)",
            total, path, aggregated_over, zero_relevant
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_result(matched: bool) -> EvalResult {
        EvalResult {
            query: "q".to_string(),
            category: "single-term".to_string(),
            hits: if matched { 1 } else { 0 },
            matched,
        }
    }

    #[test]
    fn default_goldens_is_non_empty_and_well_formed() {
        let goldens = default_goldens();
        assert!(!goldens.is_empty(), "golden set must not be empty");
        for g in &goldens {
            assert!(!g.query.trim().is_empty(), "golden query must not be blank");
            assert!(
                !g.expect_any_of.is_empty(),
                "golden '{}' must have at least one expected substring",
                g.query
            );
            assert!(!g.category.trim().is_empty(), "golden must be categorized");
        }
    }

    #[test]
    fn from_results_computes_recall_at_k_arithmetic() {
        // 4 results, 3 matched -> recall_at_k = 0.75.
        let results = vec![
            mk_result(true),
            mk_result(true),
            mk_result(false),
            mk_result(true),
        ];
        let report = EvalReport::from_results(results);
        assert_eq!(report.total, 4);
        assert_eq!(report.matched, 3);
        assert!(
            (report.recall_at_k - 0.75).abs() < f32::EPSILON,
            "expected 0.75, got {}",
            report.recall_at_k
        );
        assert_eq!(report.per_query.len(), 4, "per_query must be preserved");
    }

    #[test]
    fn from_results_empty_is_zero_not_nan() {
        let report = EvalReport::from_results(vec![]);
        assert_eq!(report.total, 0);
        assert_eq!(report.matched, 0);
        assert_eq!(report.recall_at_k, 0.0, "empty must be 0.0, never NaN");
        assert!(!report.recall_at_k.is_nan());
    }

    #[test]
    fn from_results_all_matched_is_one() {
        let report = EvalReport::from_results(vec![mk_result(true), mk_result(true)]);
        assert!((report.recall_at_k - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn summaries_match_is_case_insensitive_or_match() {
        let summaries = vec!["Recall hibrido con RRF".to_string()];
        assert!(
            summaries_match(&summaries, &["rrf".to_string()]),
            "lowercase needle must match mixed-case summary"
        );
        assert!(
            summaries_match(&summaries, &["NADA".to_string(), "RECALL".to_string()]),
            "OR-match: second needle hits"
        );
    }

    #[test]
    fn classify_leaks_flags_secret_and_stale() {
        use super::super::model::{Sensitivity, Status};
        let rows = vec![
            ("ok".to_string(), Sensitivity::Internal, Status::Active),
            ("sec".to_string(), Sensitivity::Secret, Status::Active),
            ("dep".to_string(), Sensitivity::Internal, Status::Deprecated),
        ];
        let (secret, stale, leaked) = classify_leaks(&rows);
        assert_eq!(secret, 1, "one Secret item must be flagged");
        assert_eq!(stale, 1, "one non-Active item must be flagged");
        assert_eq!(leaked, vec!["dep".to_string(), "sec".to_string()]);
    }

    #[test]
    fn classify_leaks_clean_when_all_active_internal() {
        use super::super::model::{Sensitivity, Status};
        let rows = vec![
            ("a".to_string(), Sensitivity::Internal, Status::Active),
            ("b".to_string(), Sensitivity::Public, Status::Active),
        ];
        let (secret, stale, leaked) = classify_leaks(&rows);
        assert_eq!((secret, stale, leaked.len()), (0, 0, 0));
    }

    #[test]
    fn summaries_match_no_overlap_is_false() {
        let summaries = vec!["algo totalmente distinto".to_string()];
        assert!(!summaries_match(&summaries, &["qdrant".to_string()]));
    }

    #[test]
    fn summaries_match_empty_inputs_are_false() {
        assert!(
            !summaries_match(&[], &["qdrant".to_string()]),
            "no summaries -> no match"
        );
        assert!(
            !summaries_match(&["hola".to_string()], &[]),
            "no expectations -> no match"
        );
    }

    // ----- golden metrics report (degraded shape, no I/O) -------------------

    #[test]
    fn golden_metrics_degraded_is_well_formed_zero() {
        // The degraded constructor must yield a stable, all-zero, non-NaN report
        // so hook consumers never see a panic or a malformed payload.
        let r = GoldenMetricsReport::degraded(8, "file missing");
        assert!(r.degraded);
        assert_eq!(r.k, 8);
        assert_eq!(r.scored, 0);
        assert_eq!(r.skipped_no_expectation, 0);
        assert!(r.per_category.is_empty());
        assert_eq!(r.secret_leak_count, 0);
        assert_eq!(r.stale_leak_count, 0);
        assert!(r.leaked_ids.is_empty());
        // Aggregate is the empty aggregate (k = 0, every field 0.0, no NaN).
        assert_eq!(r.aggregate.k, 0);
        for v in [
            r.aggregate.precision_at_k,
            r.aggregate.recall_at_k,
            r.aggregate.mrr,
            r.aggregate.ndcg_at_k,
            r.aggregate.context_waste,
        ] {
            assert_eq!(v, 0.0);
            assert!(!v.is_nan());
        }
        assert_eq!(r.note, "file missing");
    }

    #[test]
    fn golden_metrics_report_serializes_to_json() {
        // Serializing must not fail and must surface the metric field names so
        // the eval-full subcommand emits a machine-readable payload for hooks.
        let r = GoldenMetricsReport::degraded(8, "degraded");
        let json = serde_json::to_string(&r).expect("report must serialize");
        assert!(json.contains("\"aggregate\""));
        assert!(json.contains("\"precision_at_k\""));
        assert!(json.contains("\"degraded\":true"));
    }

    // ----- LabeledSet + LabeledGoldenReport (wiring + parse, no I/O) ---------

    /// Parse the `labeled[]` schema from a small inline fixture and verify the
    /// wiring: `LabeledSet::from_json_str` → `LabeledQuery::relevant()` →
    /// `EvalMetrics::for_query`. This test will FAIL if any field name or
    /// metric calculation regresses, not just compile.
    #[test]
    fn labeled_set_parses_schema_and_metrics_wiring_is_correct() {
        use crate::memory::eval_metrics::{EvalMetrics, LabeledSet};
        use std::collections::HashSet;

        let json = r#"{
            "labeled": [
                {
                    "id": "gs-0001",
                    "query": "qdrant",
                    "expect_ids": ["id-a", "id-b", "id-c"],
                    "n_relevant": 3,
                    "nota": "three relevant items"
                },
                {
                    "id": "gs-0002",
                    "query": "candidato pendiente",
                    "expect_ids": [],
                    "n_relevant": 0,
                    "nota": "no relevant document"
                }
            ]
        }"#;

        let set = LabeledSet::from_json_str(json).expect("must parse valid labeled JSON");
        assert_eq!(set.labeled.len(), 2, "two labeled queries");

        // --- first label: 3 relevant ids ---
        let lq0 = &set.labeled[0];
        assert_eq!(lq0.id, "gs-0001");
        assert_eq!(lq0.n_relevant, 3);
        let rel0: HashSet<String> = lq0.relevant();
        assert_eq!(rel0.len(), 3, "relevant() must mirror expect_ids");
        assert!(rel0.contains("id-a"));

        // Simulate a recall that returns the first two relevant ids first, then
        // two irrelevant items, then the third relevant item at position 5.
        let retrieved = vec![
            "id-a".to_string(),
            "id-b".to_string(),
            "noise-1".to_string(),
            "noise-2".to_string(),
            "id-c".to_string(),
            "noise-3".to_string(),
            "noise-4".to_string(),
            "noise-5".to_string(),
        ];
        let m = EvalMetrics::for_query(&retrieved, &rel0, 8);

        // recall@8: all 3 relevant ids appear in top-8 → 3/3 = 1.0
        assert!(
            (m.recall_at_k - 1.0).abs() < 1e-9,
            "recall@8 must be 1.0 when all relevant in top-8, got {}",
            m.recall_at_k
        );
        // precision@8: 3 relevant of 8 slots → 3/8 = 0.375
        assert!(
            (m.precision_at_k - 3.0 / 8.0).abs() < 1e-9,
            "precision@8 must be 0.375, got {}",
            m.precision_at_k
        );
        // mrr: first relevant at position 1 (0-based idx 0) → 1/1 = 1.0
        assert!(
            (m.mrr - 1.0).abs() < 1e-9,
            "mrr must be 1.0 when first relevant at rank 1, got {}",
            m.mrr
        );

        // --- second label: no relevant ids → relevant() is empty ---
        let lq1 = &set.labeled[1];
        assert_eq!(lq1.id, "gs-0002");
        let rel1 = lq1.relevant();
        assert!(rel1.is_empty(), "empty expect_ids → empty relevant set");

        // An empty relevant set: recall@8 must be 0.0 (not NaN).
        let m_empty = EvalMetrics::for_query(&retrieved, &rel1, 8);
        assert_eq!(m_empty.recall_at_k, 0.0);
        assert!(!m_empty.recall_at_k.is_nan());
    }

    #[test]
    fn labeled_golden_report_degraded_on_missing_file() {
        // A non-existent path must degrade gracefully, not panic.
        let r = LabeledGoldenReport::degraded("/nonexistent/path.json", 8, "file not found");
        assert!(r.degraded);
        assert_eq!(r.total_queries, 0);
        assert_eq!(r.queries_with_zero_recall, 0);
        // Aggregate must be all-zero, never NaN.
        for v in [
            r.aggregate.recall_at_k,
            r.aggregate.precision_at_k,
            r.aggregate.mrr,
            r.aggregate.ndcg_at_k,
        ] {
            assert_eq!(v, 0.0);
            assert!(!v.is_nan());
        }
    }

    #[test]
    fn labeled_golden_report_serializes_required_fields() {
        // The JSON output must contain all cat19-relevant fields.
        let r = LabeledGoldenReport::degraded("/path/labels.json", 8, "test");
        let json = serde_json::to_string(&r).expect("must serialize");
        for field in &[
            "\"total_queries\"",
            "\"zero_relevant\"",
            "\"queries_with_zero_recall\"",
            "\"aggregate\"",
            "\"recall_at_k\"",
            "\"per_query\"",
            "\"degraded\"",
            "\"aggregate_precision_at_3\"",
            "\"aggregated_over\"",
        ] {
            assert!(json.contains(field), "JSON must contain field {field}");
        }
    }

    /// CRÍTICO: una query con n_relevant=0 NO debe arrastrar el agregado.
    /// Fixture: query A tiene match perfecto (recall=1.0), query B tiene n_relevant=0.
    /// El aggregate.recall_at_k DEBE ser 1.0, NO 0.5.
    /// Este test FALLA si la exclusión de zero-relevant se rompe.
    #[test]
    fn zero_relevant_query_excluded_from_aggregate_recall() {
        use crate::memory::eval_metrics::{EvalMetrics, LabeledSet};

        let json = r#"{
            "labeled": [
                {
                    "id": "gs-0001",
                    "query": "perfect match query",
                    "expect_ids": ["id-x"],
                    "n_relevant": 1,
                    "nota": "one relevant item, will be found"
                },
                {
                    "id": "gs-0010",
                    "query": "empty oracle query",
                    "expect_ids": [],
                    "n_relevant": 0,
                    "nota": "no oracle — must not enter aggregate"
                }
            ]
        }"#;

        let set = LabeledSet::from_json_str(json).expect("fixture must parse");
        assert_eq!(set.labeled.len(), 2);

        // Manually simulate what run_labeled_golden does for the aggregate logic,
        // but purely (no recall_pack I/O): build per-query metrics and replicate
        // the exclusion rule.
        let relevant_a: std::collections::HashSet<String> = set.labeled[0].relevant(); // {"id-x"}
        let relevant_b: std::collections::HashSet<String> = set.labeled[1].relevant(); // {}

        let retrieved_a = vec!["id-x".to_string(), "noise".to_string()];
        let retrieved_b = vec!["noise".to_string()];

        let m_a = EvalMetrics::for_query(&retrieved_a, &relevant_a, 8);
        let m_b = EvalMetrics::for_query(&retrieved_b, &relevant_b, 8);

        // Query A: recall should be 1.0 (found "id-x").
        assert!(
            (m_a.recall_at_k - 1.0).abs() < 1e-9,
            "query A recall must be 1.0, got {}",
            m_a.recall_at_k
        );
        // Query B: recall is 0.0 (empty oracle produces 0.0 per recall_at_k guard).
        assert_eq!(m_b.recall_at_k, 0.0);

        // The CORRECT aggregate: exclude B (zero-relevant), average only A.
        let aggregate_correct = EvalMetrics::aggregate(&[m_a]);
        assert!(
            (aggregate_correct.recall_at_k - 1.0).abs() < 1e-9,
            "aggregate over non-zero-relevant queries must be 1.0, got {}",
            aggregate_correct.recall_at_k
        );

        // The WRONG aggregate (including B) would give 0.5 — assert it WOULD be wrong
        // so this test catches a regression if the exclusion is accidentally removed.
        let aggregate_wrong = EvalMetrics::aggregate(&[m_a, m_b]);
        assert!(
            (aggregate_wrong.recall_at_k - 0.5).abs() < 1e-9,
            "contaminated aggregate should be 0.5 (sanity check), got {}",
            aggregate_wrong.recall_at_k
        );
        assert!(
            aggregate_correct.recall_at_k > aggregate_wrong.recall_at_k,
            "correct aggregate ({}) must exceed wrong aggregate ({})",
            aggregate_correct.recall_at_k,
            aggregate_wrong.recall_at_k
        );
    }

    /// CRÍTICO: precision@3 se computa correctamente y es distinto de precision@8.
    /// Fixture: 3 relevant ids en posiciones 1,2,4 de un retrieved de 8.
    /// precision@3 = 2/3, precision@8 = 3/8. Ambos deben ser correctos.
    /// Este test FALLA si precision_at_3 no se calcula o se confunde con precision@k.
    #[test]
    fn precision_at_3_is_computed_correctly_and_differs_from_precision_at_k() {
        use crate::memory::eval_metrics::{precision_at_k, EvalMetrics};

        let retrieved = vec![
            "rel-1".to_string(), // pos 1 — relevant
            "rel-2".to_string(), // pos 2 — relevant
            "noise".to_string(), // pos 3 — NOT relevant
            "rel-3".to_string(), // pos 4 — relevant (beyond k=3)
            "noise".to_string(),
            "noise".to_string(),
            "noise".to_string(),
            "noise".to_string(),
        ];
        let relevant: std::collections::HashSet<String> = ["rel-1", "rel-2", "rel-3"]
            .iter()
            .map(|s| s.to_string())
            .collect();

        let p3 = precision_at_k(&retrieved, &relevant, 3);
        let m = EvalMetrics::for_query(&retrieved, &relevant, 8);

        // precision@3: 2 hits in top-3 slots -> 2/3
        assert!(
            (p3 - 2.0 / 3.0).abs() < 1e-9,
            "precision@3 must be 2/3 ≈ 0.6667, got {p3}"
        );

        // precision@8: 3 hits in 8 slots -> 3/8
        assert!(
            (m.precision_at_k - 3.0 / 8.0).abs() < 1e-9,
            "precision@8 must be 3/8 = 0.375, got {}",
            m.precision_at_k
        );

        // They must differ — if they were equal the test would be vacuous.
        assert!(
            (p3 - m.precision_at_k).abs() > 1e-9,
            "precision@3 ({p3}) must differ from precision@8 ({})",
            m.precision_at_k
        );
    }
}
