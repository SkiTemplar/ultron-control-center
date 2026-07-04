// evals/golden.rs — metricas de ranking sobre el golden set externo (troceado de evals.rs, 2026-07-02).

use std::collections::BTreeMap;

use crate::commands::memory::recall_unified::recall_pack;
use crate::memory::eval_metrics::{EvalMetrics, GoldenSet};

use super::{classify_leaks, golden_set_path};
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
    pub(super) fn degraded(k: usize, note: impl Into<String>) -> Self {
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
///
/// `rerank`: los comandos de CALIDAD (`eval-full`, `eval --golden`) pasan
/// `true`; el check `evals` del doctor pasa `false` — con el cross-encoder el
/// doctor pasaba de ~10s a ~62s (medido 2026-07-04) y reventaba los timeouts
/// de todos los checks del harness que lo consultan (cat1.2/1.3/5.2 en rojo
/// falso). El doctor es fontanería, no medidor de calidad.
#[must_use]
pub fn run_golden_metrics(
    project_override: Option<&str>,
    k: usize,
    rerank: bool,
) -> GoldenMetricsReport {
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
        let retrieved: Vec<String> = match recall_pack(&pos.query, k, project, false, rerank) {
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
    if let Ok(conn) = crate::memory::sqlite_store::open_conn() {
        let rows: Vec<(
            String,
            crate::memory::model::Sensitivity,
            crate::memory::model::Status,
        )> = returned_ids
            .iter()
            .filter_map(
                |id| match crate::memory::sqlite_store::get_item(&conn, id) {
                    Ok(Some(item)) => Some((item.id, item.sensitivity, item.status)),
                    _ => None,
                },
            )
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
