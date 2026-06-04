// memory/eval_metrics.rs — PURE ranking-quality metrics for the golden set.
//
// This module is the unit-testable arithmetic core for evaluating recall
// quality against the generated golden set (cockpit/memory-rework/evals/
// golden_set.json, 942 positives each carrying `expect_ids`). It mirrors the
// design discipline of `evals.rs` (`EvalReport::from_results`, `classify_leaks`):
//
//   - EVERY function here is PURE: no I/O, no Qdrant, no E5, no network, no
//     brain.db. Given a ranking (an ordered `&[String]` of retrieved ids) and
//     the set of relevant ids (`&HashSet<String>`), it returns a metric. That
//     makes the whole module testable with `cargo test --no-default-features
//     --lib eval_metrics` (no `qdrant` feature, no sidecar, no DB).
//   - Division-by-zero is guarded everywhere: empty `k`, empty relevant set,
//     or empty ranking yield well-defined `0.0` (never `NaN`).
//   - Binary relevance: an id is either relevant (in `relevant`) or not. This
//     matches the golden set, where `expect_ids` is the membership oracle.
//
// The I/O boundary (loading `golden_set.json`, driving live recall, mapping the
// returned pack ids into the `EvalMetrics` struct) lives in `evals.rs` — see the
// `GoldenSet` loader below and the wiring notes accompanying this change.

use std::collections::HashSet;

/// Precision@k: of the top-`k` retrieved ids, the fraction that are relevant.
///
/// `precision = |relevant ∩ top_k| / k`. PURE.
///
/// Guards: `k == 0` (or an empty ranking) yields `0.0`. The denominator is `k`
/// (the requested cutoff), NOT `min(k, retrieved.len())` — under-retrieval is a
/// real quality loss and is penalised, consistent with standard IR practice.
#[must_use]
pub fn precision_at_k(retrieved: &[String], relevant: &HashSet<String>, k: usize) -> f64 {
    if k == 0 {
        return 0.0;
    }
    let hits = retrieved
        .iter()
        .take(k)
        .filter(|id| relevant.contains(*id))
        .count();
    hits as f64 / k as f64
}

/// Recall@k: of all relevant ids, the fraction recovered within the top-`k`.
///
/// `recall = |relevant ∩ top_k| / |relevant|`. PURE.
///
/// Guards: an empty `relevant` set yields `0.0` (no relevant items to recover —
/// vacuously not useful, and avoids `0/0`). `k == 0` yields `0.0`.
#[must_use]
pub fn recall_at_k(retrieved: &[String], relevant: &HashSet<String>, k: usize) -> f64 {
    if k == 0 || relevant.is_empty() {
        return 0.0;
    }
    let hits = retrieved
        .iter()
        .take(k)
        .filter(|id| relevant.contains(*id))
        .count();
    hits as f64 / relevant.len() as f64
}

/// Mean Reciprocal Rank contribution for ONE query: the reciprocal of the
/// 1-based rank of the FIRST relevant id in the full ranking.
///
/// First relevant at position 1 -> `1.0`; at position 3 -> `1/3`; none -> `0.0`.
/// Aggregating these across queries (via [`EvalMetrics::aggregate`]) yields the
/// classic MRR. PURE; not cut off at `k` by definition — MRR rewards finding the
/// first relevant item however deep it sits.
#[must_use]
pub fn mrr(retrieved: &[String], relevant: &HashSet<String>) -> f64 {
    for (idx, id) in retrieved.iter().enumerate() {
        if relevant.contains(id) {
            // idx is 0-based; reciprocal rank uses the 1-based position.
            return 1.0 / (idx as f64 + 1.0);
        }
    }
    0.0
}

/// Normalized Discounted Cumulative Gain at `k` with BINARY gain (relevant = 1,
/// irrelevant = 0). PURE.
///
/// `DCG@k = Σ_{i=1..k} rel_i / log2(i + 1)`, and `IDCG@k` is the DCG of the
/// ideal ranking (all relevant items first), i.e. the first `min(k, |relevant|)`
/// positions each contributing gain 1. `nDCG = DCG / IDCG`, clamped to `[0, 1]`.
///
/// Guards: `k == 0`, an empty `relevant` set, or `IDCG == 0` all yield `0.0`. A
/// perfect ranking (every top-`min(k,|relevant|)` slot relevant) yields `1.0`.
#[must_use]
pub fn ndcg_at_k(retrieved: &[String], relevant: &HashSet<String>, k: usize) -> f64 {
    if k == 0 || relevant.is_empty() {
        return 0.0;
    }

    // DCG of the actual ranking over the top-k positions.
    let dcg: f64 = retrieved
        .iter()
        .take(k)
        .enumerate()
        .filter(|(_, id)| relevant.contains(*id))
        .map(|(i, _)| 1.0 / ((i as f64 + 2.0).log2()))
        .sum();

    // IDCG: the ideal places all relevant items at the front. The number of
    // relevant items that CAN appear in the top-k is min(k, |relevant|).
    let ideal_hits = k.min(relevant.len());
    let idcg: f64 = (0..ideal_hits)
        .map(|i| 1.0 / ((i as f64 + 2.0).log2()))
        .sum();

    if idcg == 0.0 {
        return 0.0;
    }
    // Clamp guards against floating-point overshoot above 1.0.
    (dcg / idcg).clamp(0.0, 1.0)
}

/// Context-waste ratio at `k`: the fraction of the top-`k` slots occupied by
/// NON-relevant ids — i.e. tokens the recall pack spends on noise. PURE.
///
/// `waste = (k - |relevant ∩ top_k|) / k = 1 - precision_at_k`. We measure
/// against the requested cutoff `k`, so unfilled slots (under-retrieval) also
/// count as waste — a short pack still reserves the budget.
///
/// Guards: `k == 0` yields `0.0` (no budget, no waste).
#[must_use]
pub fn context_waste_ratio(retrieved: &[String], relevant: &HashSet<String>, k: usize) -> f64 {
    if k == 0 {
        return 0.0;
    }
    1.0 - precision_at_k(retrieved, relevant, k)
}

/// A bundle of per-query (or, after [`EvalMetrics::aggregate`], averaged)
/// ranking-quality metrics at a fixed cutoff `k`.
///
/// Field names match the underlying functions for discoverability. Serializable
/// so `evals.rs` can surface it directly in the `eval` subcommand report.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct EvalMetrics {
    /// Precision@k for this query (or mean precision after aggregation).
    pub precision_at_k: f64,
    /// Recall@k for this query (or mean recall after aggregation).
    pub recall_at_k: f64,
    /// Reciprocal rank for this query (or MRR after aggregation).
    pub mrr: f64,
    /// nDCG@k for this query (or mean nDCG after aggregation).
    pub ndcg_at_k: f64,
    /// Context-waste ratio for this query (or mean waste after aggregation).
    pub context_waste: f64,
    /// The cutoff `k` these metrics were computed at.
    pub k: usize,
}

impl EvalMetrics {
    /// Compute every metric for ONE query from its ranking and relevant set.
    /// PURE convenience constructor; pairs each public metric fn with the same
    /// inputs so callers cannot get the wiring out of sync.
    #[must_use]
    pub fn for_query(retrieved: &[String], relevant: &HashSet<String>, k: usize) -> Self {
        Self {
            precision_at_k: precision_at_k(retrieved, relevant, k),
            recall_at_k: recall_at_k(retrieved, relevant, k),
            mrr: mrr(retrieved, relevant),
            ndcg_at_k: ndcg_at_k(retrieved, relevant, k),
            context_waste: context_waste_ratio(retrieved, relevant, k),
            k,
        }
    }

    /// Aggregate per-query metrics into their arithmetic means. PURE.
    ///
    /// Returns an all-zero bundle (with `k = 0`) for an empty input — never
    /// `NaN`. When non-empty, the reported `k` is taken from the first entry;
    /// mixing different `k` values across queries is a caller error (the means
    /// would be meaningless), so the first `k` is reported as-is rather than
    /// silently averaged.
    #[must_use]
    pub fn aggregate(per_query: &[EvalMetrics]) -> EvalMetrics {
        let n = per_query.len();
        if n == 0 {
            return EvalMetrics {
                precision_at_k: 0.0,
                recall_at_k: 0.0,
                mrr: 0.0,
                ndcg_at_k: 0.0,
                context_waste: 0.0,
                k: 0,
            };
        }
        let denom = n as f64;
        let sum = |f: fn(&EvalMetrics) -> f64| per_query.iter().map(f).sum::<f64>() / denom;
        EvalMetrics {
            precision_at_k: sum(|m| m.precision_at_k),
            recall_at_k: sum(|m| m.recall_at_k),
            mrr: sum(|m| m.mrr),
            ndcg_at_k: sum(|m| m.ndcg_at_k),
            context_waste: sum(|m| m.context_waste),
            k: per_query[0].k,
        }
    }
}

// ---------------------------------------------------------------------------
// Golden-set loader types (pure deserialization — used by the I/O side in
// evals.rs to read cockpit/memory-rework/evals/golden_set.json).
// ---------------------------------------------------------------------------

/// One positive entry of the generated golden set. Mirrors the JSON shape:
/// `{ id, query, category, type, scope, project_id, expect_ids: [..] }`.
/// Unknown/extra fields are tolerated. PURE data; deserialize-only.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct GoldenPositive {
    /// Stable golden-set entry id (e.g. `gs-<uuid>`).
    #[serde(default)]
    pub id: String,
    /// The query string fed to recall.
    pub query: String,
    /// Coarse bucket: "decision" | "factual" | "file" | "task" | ...
    #[serde(default)]
    pub category: String,
    /// Optional project scope filter for recall (`project_id` in the SoT).
    #[serde(default)]
    pub project_id: Option<String>,
    /// The relevant item ids this query is expected to recover.
    #[serde(default)]
    pub expect_ids: Vec<String>,
}

impl GoldenPositive {
    /// The relevant set as a `HashSet`, ready for the metric functions. PURE.
    #[must_use]
    pub fn relevant(&self) -> HashSet<String> {
        self.expect_ids.iter().cloned().collect()
    }
}

/// The deserialized `golden_set.json`. Only the fields the metrics path needs
/// are modeled; the rich `stats`/provenance block is ignored. PURE.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct GoldenSet {
    /// The list of positive (query, expected-ids) pairs.
    #[serde(default)]
    pub positives: Vec<GoldenPositive>,
}

impl GoldenSet {
    /// Parse a golden set from raw JSON text. PURE (no file I/O — the caller
    /// reads the bytes; this only decodes them), so it is unit-testable.
    ///
    /// # Errors
    ///
    /// Returns the underlying `serde_json` error if the text is not a valid
    /// golden-set document.
    pub fn from_json_str(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a ranking from string literals.
    fn ranking(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    /// Build a relevant set from string literals.
    fn relset(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    // ----- precision@k -----------------------------------------------------

    #[test]
    fn precision_full_when_all_topk_relevant() {
        let r = ranking(&["a", "b", "c", "x"]);
        let rel = relset(&["a", "b", "c"]);
        // top-3 are all relevant -> 3/3 = 1.0
        assert!(approx(precision_at_k(&r, &rel, 3), 1.0));
    }

    #[test]
    fn precision_half_when_one_of_two_relevant() {
        let r = ranking(&["a", "x"]);
        let rel = relset(&["a"]);
        assert!(approx(precision_at_k(&r, &rel, 2), 0.5));
    }

    #[test]
    fn precision_penalises_under_retrieval_against_k() {
        // Only one item retrieved, but k=4 -> denominator is k, not len.
        let r = ranking(&["a"]);
        let rel = relset(&["a"]);
        assert!(approx(precision_at_k(&r, &rel, 4), 0.25));
    }

    #[test]
    fn precision_k_zero_is_zero_not_nan() {
        let r = ranking(&["a"]);
        let rel = relset(&["a"]);
        let p = precision_at_k(&r, &rel, 0);
        assert_eq!(p, 0.0);
        assert!(!p.is_nan());
    }

    // ----- recall@k --------------------------------------------------------

    #[test]
    fn recall_full_when_all_relevant_recovered() {
        let r = ranking(&["a", "b", "c"]);
        let rel = relset(&["a", "b"]);
        // both relevant ids inside top-3 -> 2/2 = 1.0
        assert!(approx(recall_at_k(&r, &rel, 3), 1.0));
    }

    #[test]
    fn recall_partial_when_some_relevant_beyond_k() {
        let r = ranking(&["a", "x", "b"]);
        let rel = relset(&["a", "b"]);
        // top-2 contains only "a" -> 1/2 = 0.5
        assert!(approx(recall_at_k(&r, &rel, 2), 0.5));
    }

    #[test]
    fn recall_empty_relevant_is_zero_not_nan() {
        let r = ranking(&["a"]);
        let rel = relset(&[]);
        let v = recall_at_k(&r, &rel, 5);
        assert_eq!(v, 0.0);
        assert!(!v.is_nan());
    }

    // ----- mrr -------------------------------------------------------------

    #[test]
    fn mrr_is_one_when_first_relevant_at_pos_one() {
        let r = ranking(&["a", "x", "y"]);
        let rel = relset(&["a"]);
        assert!(approx(mrr(&r, &rel), 1.0));
    }

    #[test]
    fn mrr_is_one_third_when_first_relevant_at_pos_three() {
        let r = ranking(&["x", "y", "a", "b"]);
        let rel = relset(&["a", "b"]);
        // first relevant ("a") at 1-based position 3 -> 1/3
        assert!(approx(mrr(&r, &rel), 1.0 / 3.0));
    }

    #[test]
    fn mrr_is_zero_when_no_relevant_in_ranking() {
        let r = ranking(&["x", "y", "z"]);
        let rel = relset(&["a"]);
        assert_eq!(mrr(&r, &rel), 0.0);
    }

    // ----- ndcg@k ----------------------------------------------------------

    #[test]
    fn ndcg_perfect_ranking_is_one() {
        // All relevant items first -> DCG == IDCG -> nDCG = 1.0.
        let r = ranking(&["a", "b", "x", "y"]);
        let rel = relset(&["a", "b"]);
        assert!(approx(ndcg_at_k(&r, &rel, 4), 1.0));
    }

    #[test]
    fn ndcg_single_relevant_at_top_is_one() {
        let r = ranking(&["a", "x", "y"]);
        let rel = relset(&["a"]);
        assert!(approx(ndcg_at_k(&r, &rel, 3), 1.0));
    }

    #[test]
    fn ndcg_relevant_at_pos_two_matches_formula() {
        // One relevant id, sitting at 1-based position 2.
        //   DCG  = 1 / log2(2 + 1) = 1 / log2(3)
        //   IDCG = 1 / log2(1 + 1) = 1 / log2(2) = 1.0
        //   nDCG = (1/log2(3)) / 1.0
        let r = ranking(&["x", "a", "y"]);
        let rel = relset(&["a"]);
        let expected = (1.0 / 3.0_f64.log2()) / 1.0;
        assert!(approx(ndcg_at_k(&r, &rel, 3), expected));
    }

    #[test]
    fn ndcg_worse_when_relevant_is_lower() {
        let rel = relset(&["a"]);
        let top = ndcg_at_k(&ranking(&["a", "x", "y"]), &rel, 3);
        let low = ndcg_at_k(&ranking(&["x", "y", "a"]), &rel, 3);
        assert!(
            top > low,
            "relevant higher must score better: {top} vs {low}"
        );
    }

    #[test]
    fn ndcg_empty_relevant_is_zero_not_nan() {
        let r = ranking(&["a"]);
        let v = ndcg_at_k(&r, &relset(&[]), 5);
        assert_eq!(v, 0.0);
        assert!(!v.is_nan());
    }

    // ----- context_waste ---------------------------------------------------

    #[test]
    fn waste_is_complement_of_precision() {
        let r = ranking(&["a", "x", "b", "y"]);
        let rel = relset(&["a", "b"]);
        // precision@4 = 2/4 = 0.5 -> waste = 0.5
        assert!(approx(context_waste_ratio(&r, &rel, 4), 0.5));
        assert!(approx(
            context_waste_ratio(&r, &rel, 4),
            1.0 - precision_at_k(&r, &rel, 4)
        ));
    }

    #[test]
    fn waste_zero_when_all_relevant() {
        let r = ranking(&["a", "b"]);
        let rel = relset(&["a", "b"]);
        assert!(approx(context_waste_ratio(&r, &rel, 2), 0.0));
    }

    #[test]
    fn waste_k_zero_is_zero() {
        let r = ranking(&["x"]);
        let rel = relset(&["a"]);
        assert_eq!(context_waste_ratio(&r, &rel, 0), 0.0);
    }

    // ----- EvalMetrics::for_query + aggregate ------------------------------

    #[test]
    fn for_query_bundles_all_metrics_consistently() {
        let r = ranking(&["a", "x", "b", "y"]);
        let rel = relset(&["a", "b"]);
        let m = EvalMetrics::for_query(&r, &rel, 4);
        assert_eq!(m.k, 4);
        assert!(approx(m.precision_at_k, precision_at_k(&r, &rel, 4)));
        assert!(approx(m.recall_at_k, recall_at_k(&r, &rel, 4)));
        assert!(approx(m.mrr, mrr(&r, &rel)));
        assert!(approx(m.ndcg_at_k, ndcg_at_k(&r, &rel, 4)));
        assert!(approx(m.context_waste, context_waste_ratio(&r, &rel, 4)));
    }

    #[test]
    fn aggregate_averages_each_field() {
        let q1 = EvalMetrics {
            precision_at_k: 1.0,
            recall_at_k: 1.0,
            mrr: 1.0,
            ndcg_at_k: 1.0,
            context_waste: 0.0,
            k: 8,
        };
        let q2 = EvalMetrics {
            precision_at_k: 0.0,
            recall_at_k: 0.0,
            mrr: 0.0,
            ndcg_at_k: 0.0,
            context_waste: 1.0,
            k: 8,
        };
        let agg = EvalMetrics::aggregate(&[q1, q2]);
        assert!(approx(agg.precision_at_k, 0.5));
        assert!(approx(agg.recall_at_k, 0.5));
        assert!(approx(agg.mrr, 0.5));
        assert!(approx(agg.ndcg_at_k, 0.5));
        assert!(approx(agg.context_waste, 0.5));
        assert_eq!(agg.k, 8, "aggregate reports the shared k");
    }

    #[test]
    fn aggregate_empty_is_all_zero_not_nan() {
        let agg = EvalMetrics::aggregate(&[]);
        assert_eq!(agg.k, 0);
        for v in [
            agg.precision_at_k,
            agg.recall_at_k,
            agg.mrr,
            agg.ndcg_at_k,
            agg.context_waste,
        ] {
            assert_eq!(v, 0.0);
            assert!(!v.is_nan());
        }
    }

    // ----- golden-set loader -----------------------------------------------

    #[test]
    fn golden_set_parses_positives_and_expect_ids() {
        let json = r#"{
            "schema": 1,
            "stats": { "positives": 2 },
            "positives": [
                {
                    "id": "gs-1",
                    "query": "memoria pipeline",
                    "category": "file",
                    "type": "codebase_fact",
                    "scope": "project",
                    "project_id": "ultron",
                    "expect_ids": ["1"]
                },
                {
                    "id": "gs-2",
                    "query": "decision embeddings",
                    "category": "decision",
                    "expect_ids": ["2", "3"]
                }
            ]
        }"#;
        let gs = GoldenSet::from_json_str(json).expect("golden set must parse");
        assert_eq!(gs.positives.len(), 2);
        assert_eq!(gs.positives[0].query, "memoria pipeline");
        assert_eq!(gs.positives[0].project_id.as_deref(), Some("ultron"));
        let rel0 = gs.positives[0].relevant();
        assert!(rel0.contains("1"));
        let rel1 = gs.positives[1].relevant();
        assert_eq!(rel1.len(), 2);
        assert!(gs.positives[1].project_id.is_none());
    }

    #[test]
    fn golden_set_end_to_end_perfect_recall_scores_one() {
        // A query whose expected id is returned first -> all metrics perfect.
        let json = r#"{
            "positives": [
                { "id": "gs-x", "query": "q", "expect_ids": ["target"] }
            ]
        }"#;
        let gs = GoldenSet::from_json_str(json).unwrap();
        let p = &gs.positives[0];
        let retrieved = ranking(&["target", "noise1", "noise2"]);
        let m = EvalMetrics::for_query(&retrieved, &p.relevant(), 8);
        assert!(approx(m.recall_at_k, 1.0), "all relevant recovered");
        assert!(approx(m.mrr, 1.0), "relevant first -> mrr 1.0");
        assert!(approx(m.ndcg_at_k, 1.0), "relevant first -> ndcg 1.0");
        // 1 relevant of 8 slots -> precision 1/8, waste 7/8.
        assert!(approx(m.precision_at_k, 1.0 / 8.0));
        assert!(approx(m.context_waste, 7.0 / 8.0));
    }
}
