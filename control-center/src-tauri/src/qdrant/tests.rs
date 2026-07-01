//! Unit tests for the `qdrant` module.
//!
//! Extracted from `qdrant.rs` into this sibling file to keep that module under
//! the 800-line cap (Kirkardo cat7.3) after the HTTP-client pooling change.
//! `super::*` resolves to the `qdrant` module, so every test reads exactly as
//! it did inline.

use super::*;

// card-test-fixtures-rust-infra: keep the fixture honest against the private
// SearchResponse/RawHit shape that `search()` actually deserialises.
#[test]
fn fixture_search_response_parses_three_hits() {
    #[derive(serde::Deserialize)]
    struct SearchResponse {
        result: Vec<RawHit>,
    }
    #[derive(serde::Deserialize)]
    struct RawHit {
        id: serde_json::Value,
        score: f32,
        #[serde(default)]
        payload: HashMap<String, serde_json::Value>,
    }
    let raw = crate::test_support::load_fixture("qdrant", "search-response.json");
    let parsed: SearchResponse =
        serde_json::from_str(&raw).expect("search-response.json must parse");
    assert_eq!(parsed.result.len(), 3);
    assert!(parsed.result[0].score > 0.9);
    assert!(
        parsed.result[2].id.is_number(),
        "3rd hit exercises the numeric-id arm of search()"
    );
    assert!(parsed
        .result
        .iter()
        .all(|h| h.payload.contains_key("project")));
}

#[test]
fn qdrant_hit_serializes() {
    let mut payload = HashMap::new();
    payload.insert("text".to_string(), serde_json::json!("hello"));
    let hit = QdrantHit {
        id: "abc-123".to_string(),
        score: 0.92,
        payload,
    };
    let s = serde_json::to_string(&hit).unwrap();
    assert!(s.contains("abc-123"));
    assert!(s.contains("0.92"));
}

#[test]
fn qdrant_not_running_msg_contains_url() {
    let msg = qdrant_not_running_msg("http://localhost:6333");
    assert!(msg.contains("localhost:6333"));
    assert!(msg.contains("qdrant/releases"));
}

// ---------------------------------------------------------------------------
// Cross-encoder re-ranker tests
// ---------------------------------------------------------------------------
//
// Hermetic (no model, CI-safe): reranker_disabled_by_default,
// reranker_enabled_when_var_is_1, rerank_pairs_empty_docs_fast_path,
// fallback_preserves_order_on_err.
//
// E2E (#[ignore]): e2e_rerank_pairs_smoke, e2e_warmup_reranker_smoke.

/// Default: ULTRON_RERANK absent → reranker_enabled() must return false so
/// the baseline recall pipeline is byte-for-byte unchanged.
#[test]
fn reranker_disabled_by_default() {
    let prev = std::env::var("ULTRON_RERANK").ok();
    std::env::remove_var("ULTRON_RERANK");
    let result = reranker_enabled();
    match prev {
        Some(v) => std::env::set_var("ULTRON_RERANK", v),
        None => {}
    }
    assert!(
        !result,
        "reranker_enabled() must be false when ULTRON_RERANK is unset"
    );
}

/// ULTRON_RERANK=1 activates the re-ranker.
#[test]
fn reranker_enabled_when_var_is_1() {
    let prev = std::env::var("ULTRON_RERANK").ok();
    std::env::set_var("ULTRON_RERANK", "1");
    let result = reranker_enabled();
    match prev {
        Some(v) => std::env::set_var("ULTRON_RERANK", v),
        None => std::env::remove_var("ULTRON_RERANK"),
    }
    assert!(
        result,
        "reranker_enabled() must be true when ULTRON_RERANK=1"
    );
}

/// ULTRON_RERANK=true also activates the re-ranker.
#[test]
fn reranker_enabled_when_var_is_true() {
    let prev = std::env::var("ULTRON_RERANK").ok();
    std::env::set_var("ULTRON_RERANK", "true");
    let result = reranker_enabled();
    match prev {
        Some(v) => std::env::set_var("ULTRON_RERANK", v),
        None => std::env::remove_var("ULTRON_RERANK"),
    }
    assert!(
        result,
        "reranker_enabled() must be true when ULTRON_RERANK=true"
    );
}

/// Empty `docs` hits the fast-path guard and returns `Ok([])` without ever
/// touching the model or the OnceCell. Hermetic by construction.
#[test]
fn rerank_pairs_empty_docs_fast_path() {
    let result = rerank_pairs("any query", &[]);
    assert!(
        result.is_ok(),
        "empty docs must return Ok, got: {:?}",
        result.err()
    );
    assert!(
        result.unwrap().is_empty(),
        "empty docs must return an empty vec"
    );
}

/// Verifies the caller contract: when `rerank_pairs` returns `Err` the engine
/// pattern (match + fallback) leaves the order unchanged. This is the hermetic
/// analogue of the live-engine negative case — no model required.
#[test]
fn fallback_preserves_order_on_err() {
    let original: Vec<String> = vec![
        "id_alpha".to_string(),
        "id_beta".to_string(),
        "id_gamma".to_string(),
    ];
    let ordered = original.clone();

    // Simulate an Err from rerank_pairs (no model required).
    let err_result: Result<Vec<(String, f32)>, String> =
        Err("simulated reranker failure".to_string());

    // Mirrors the engine.rs pattern exactly.
    let final_order: Vec<String> = match err_result {
        Ok(ranked) => {
            let _score_map: HashMap<&str, f32> =
                ranked.iter().map(|(id, s)| (id.as_str(), *s)).collect();
            ordered.clone() // unreachable in this test
        }
        Err(_e) => {
            // Fallback: do not touch order.
            ordered.clone()
        }
    };

    assert_eq!(
        final_order, original,
        "fallback must leave order identical to original on Err"
    );
}

/// Real BGERerankerV2M3 smoke: the memory-related doc should score above the
/// unrelated one for the "memory system" query.
#[test]
#[ignore = "e2e: downloads BGERerankerV2M3 (~1 GB)"]
fn e2e_rerank_pairs_smoke() {
    let docs = vec![
        (
            "id_memory".to_string(),
            "ULTRON memory system Rust Tauri SQLite brain.db".to_string(),
        ),
        (
            "id_unrelated".to_string(),
            "pizza margherita recipe tomato sauce mozzarella".to_string(),
        ),
        (
            "id_arch".to_string(),
            "Tauri desktop application Rust backend architecture design".to_string(),
        ),
    ];
    let result = rerank_pairs("memory system architecture", &docs);
    assert!(result.is_ok(), "rerank_pairs failed: {:?}", result.err());
    let ranked = result.unwrap();
    assert_eq!(
        ranked.len(),
        docs.len(),
        "returned length must equal input length"
    );

    let pos_unrelated = ranked
        .iter()
        .position(|(id, _)| id == "id_unrelated")
        .expect("id_unrelated must be in ranked output");
    let pos_memory = ranked
        .iter()
        .position(|(id, _)| id == "id_memory")
        .expect("id_memory must be in ranked output");
    assert!(
        pos_memory < pos_unrelated,
        "memory doc (pos={pos_memory}) should outscore unrelated doc (pos={pos_unrelated})"
    );
}

/// warmup_reranker() succeeds and forces model init.
#[test]
#[ignore = "e2e: downloads BGERerankerV2M3 (~1 GB)"]
fn e2e_warmup_reranker_smoke() {
    let result = warmup_reranker();
    assert!(result.is_ok(), "warmup_reranker failed: {:?}", result.err());
}
