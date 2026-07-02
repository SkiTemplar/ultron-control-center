// tests/fusion.rs — RRF fusion unit tests (no DB, no Qdrant).

use crate::commands::memory::recall_unified::rrf_fuse;
use crate::commands::memory::recall_unified::types_model::RRF_K;

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

// (cat1 ranking, 2026-07-02) — fusion PONDERADA: el caller puede pesar dense
// sobre sparse. Con pesos 1/1 debe ser identica a rrf_fuse (regresion).
#[test]
fn weighted_fusion_boosts_the_heavier_source_and_matches_unweighted_at_1_1() {
    use crate::commands::memory::recall_unified::rrf_fuse_weighted;

    let dense = vec!["d1".to_string(), "shared".to_string()];
    let sparse = vec!["s1".to_string(), "shared".to_string()];

    // Pesos 1/1 == rrf_fuse clasico (mismos scores por id; el orden de los
    // empates depende del HashMap, asi que comparamos normalizado por id).
    let norm = |mut v: Vec<(String, f32)>| {
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    };
    let unweighted = norm(rrf_fuse(&[dense.clone(), sparse.clone()], RRF_K));
    let w11 = norm(rrf_fuse_weighted(
        &[(dense.clone(), 1.0), (sparse.clone(), 1.0)],
        RRF_K,
    ));
    assert_eq!(unweighted, w11, "pesos 1/1 deben dar los mismos scores");

    // Con dense pesado x2, d1 (solo-dense rank0) supera a s1 (solo-sparse rank0).
    let w21 = rrf_fuse_weighted(&[(dense, 2.0), (sparse, 1.0)], RRF_K);
    let pos = |id: &str| w21.iter().position(|(x, _)| x == id).unwrap();
    assert!(
        pos("d1") < pos("s1"),
        "dense x2: d1 debe rankear sobre s1 ({w21:?})"
    );
    // 'shared' (en ambas fuentes) sigue primero: suma ponderada de dos señales.
    assert_eq!(
        w21[0].0, "shared",
        "presente en ambas fuentes sigue ganando"
    );
}
