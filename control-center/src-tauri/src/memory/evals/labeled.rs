// evals/labeled.rs — evaluacion labeled-golden externa (troceado de evals.rs, 2026-07-02).

use crate::commands::memory::recall_unified::build_trace;
use crate::memory::eval_metrics::{EvalMetrics, LabeledSet};

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
    pub(super) fn degraded(path: &str, k: usize, note: impl Into<String>) -> Self {
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
/// file with schema `{ "labeled": [...] }`), runs `build_trace` (quality path
/// dense+rerank by default; ULTRON_EVAL_DENSE/ULTRON_EVAL_RERANK override) for
/// each query, and returns the aggregate ranking-quality report.
///
/// FAIL-SAFE: a missing/invalid file degrades to `LabeledGoldenReport::degraded`.
/// Individual `build_trace` failures degrade ONLY that query to an empty ranking.
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

    // Path bajo medida: por DEFECTO el de calidad (dense+rerank), identico al
    // historico. ULTRON_EVAL_DENSE=0 / ULTRON_EVAL_RERANK=0 permiten medir el
    // pack del hot path del hook (sparse-first, sin cross-encoder) con el MISMO
    // oraculo — validacion del fast-path (frente B, 2026-07-22).
    let eval_dense = std::env::var("ULTRON_EVAL_DENSE")
        .map(|v| v != "0")
        .unwrap_or(true);
    let eval_rerank = std::env::var("ULTRON_EVAL_RERANK")
        .map(|v| v != "0")
        .unwrap_or(true);

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

        // build_trace directo (recall_pack fija dense=true): .injected son las
        // mismas entries que el pack, con dense/rerank gobernados por los knobs.
        let (retrieved_ids, degraded_query) =
            match build_trace(&label.query, k, None, false, eval_dense, eval_rerank) {
                Ok(t) => {
                    let ids: Vec<String> = t.injected.into_iter().map(|e| e.canonical_id).collect();
                    (ids, false)
                }
                Err(e) => {
                    eprintln!(
                        "[evals/labeled] build_trace failed for '{}': {e}",
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
