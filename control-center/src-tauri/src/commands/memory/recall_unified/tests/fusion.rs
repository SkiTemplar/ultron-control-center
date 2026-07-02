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
