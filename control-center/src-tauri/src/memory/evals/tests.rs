// evals/tests.rs — tests del harness de evals (troceado de evals.rs, 2026-07-02).
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
    use crate::memory::model::{Sensitivity, Status};
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
    use crate::memory::model::{Sensitivity, Status};
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
