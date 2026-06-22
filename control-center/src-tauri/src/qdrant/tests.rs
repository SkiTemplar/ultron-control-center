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
fn embed_returns_384_dims() {
    let v = embed("hello world semantic recall").expect("embed should succeed");
    assert_eq!(v.len(), 384, "BGE-small-EN-v1.5 must return 384 dims");
}

#[test]
fn embed_non_empty_text_nonzero() {
    #[cfg(feature = "qdrant")]
    {
        let v = embed("testing embeddings").unwrap();
        let nonzero = v.iter().any(|&x| x != 0.0);
        assert!(nonzero, "a real embedding should not be all zeros");
    }
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

#[test]
fn embed_stub_is_384_when_feature_absent() {
    // This test always runs regardless of feature flag — it exercises the
    // stub path (cfg(not(feature = "qdrant"))) when the feature is off and
    // the real embed path when it is on.
    let v = embed("stub").unwrap();
    assert_eq!(v.len(), 384);
}
