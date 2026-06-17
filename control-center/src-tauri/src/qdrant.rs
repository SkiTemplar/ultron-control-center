// ULTRON Control Center — Qdrant semantic recall.
//
// Provides local vector search over session facts stored in a Qdrant instance
// running on the same machine. Two public entry-points:
//
//   `embed(text)`               — produce a 384-d BGE-small-EN-v1.5 vector.
//   `search(collection, query, k)` — embed + query Qdrant, return top-k hits.
//
// Transport: Qdrant REST API on port 6333 (or QDRANT_URL env var). No gRPC
// dependency — we reuse the `reqwest` client already in Cargo.toml.
//
// Embedding: `fastembed` crate — BGE-small-EN-v1.5 (384d) for embed() and
// MultilingualE5Large (1024d, ~2.2 GB, the canonical recall embedder) for
// embed_e5(). ONNX models are cached at the canonical dir
// ULTRON_FASTEMBED_CACHE (default `~/.ultron/.fastembed_cache/`) on first
// use, and initialised lazily behind a `OnceCell` (first call pays init).
//
// Error handling: every function returns `Result<_, String>` — never panics.
// If Qdrant is unreachable the error message includes the expected start
// command so the user knows what to run.
//
// Feature gate: this module compiles unconditionally but the `fastembed` dep
// is guarded by the `qdrant` feature flag in Cargo.toml so non-qdrant builds
// stay lean. When the feature is absent, `embed` returns a stub zero-vector
// and the command still compiles.

use std::collections::HashMap;
use std::time::Duration;

use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A single result returned by `search`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QdrantHit {
    /// Qdrant point id (string or unsigned integer — we normalise to String).
    pub id: String,
    /// Cosine similarity score in [0, 1].
    pub score: f32,
    /// Arbitrary JSON payload stored alongside the vector.
    pub payload: HashMap<String, serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Qdrant URL resolver
// ---------------------------------------------------------------------------

fn qdrant_base_url() -> String {
    std::env::var("QDRANT_URL")
        .unwrap_or_else(|_| "http://localhost:6333".to_string())
        .trim_end_matches('/')
        .to_string()
}

/// Human-friendly hint when Qdrant is not reachable.
fn qdrant_not_running_msg(url: &str) -> String {
    format!(
        "Qdrant not running at {url}. \
         Start with: qdrant.exe  (download from https://github.com/qdrant/qdrant/releases)\n\
         Or set QDRANT_URL to point at a running instance."
    )
}

// ---------------------------------------------------------------------------
// HTTP helper — thin wrapper around reqwest::blocking
// ---------------------------------------------------------------------------

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("http client build: {e}"))
}

// ---------------------------------------------------------------------------
// fastembed — BGE-small-EN-v1.5, 384-dimensional
// ---------------------------------------------------------------------------

#[cfg(feature = "qdrant")]
static EMBEDDING_MODEL: OnceCell<fastembed::TextEmbedding> = OnceCell::new();

/// MultilingualE5Large (1024-d, multilingual) — the Fase B canonical embedder.
#[cfg(feature = "qdrant")]
static E5_MODEL: OnceCell<fastembed::TextEmbedding> = OnceCell::new();

/// Process-local memo of recent embeddings, keyed by the *prefixed* text (so
/// `is_query` is part of the key). WHY: one `orchestrate` embeds the SAME
/// `query: {prompt}` THREE times (catalog agents + catalog skills + dense recall);
/// each E5-large embed is ~700 ms on CPU, so memoizing turns 3 computes into
/// 1 + 2 hits (~1.4 s saved per prompt). In the resident `serve` daemon a repeated
/// prompt becomes near-instant. Bounded; wholesale clear when full (simple +
/// correct — E5 is deterministic, so a cached vector is never stale).
#[cfg(feature = "qdrant")]
static EMBED_CACHE: OnceCell<std::sync::Mutex<std::collections::HashMap<String, Vec<f32>>>> =
    OnceCell::new();
/// Cap for [`EMBED_CACHE`] (vectors are 1024×f32 ≈ 4 KB; 128 ≈ 0.5 MB).
#[cfg(feature = "qdrant")]
const EMBED_CACHE_CAP: usize = 128;

/// Canonical fastembed model-cache directory, shared by every process.
///
/// fastembed-rs defaults to `./.fastembed_cache` RELATIVE TO THE PROCESS CWD,
/// which scattered up to 8 duplicate copies of the e5-large model (~2.2 GB
/// each) across the repo depending on where each binary/hook was launched
/// from (Kirkardo Pass1 2026-06-10, cat5/C8). Pin one canonical location:
/// `ULTRON_FASTEMBED_CACHE` env override, else `~/.ultron/.fastembed_cache`.
#[cfg(feature = "qdrant")]
fn fastembed_cache_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("ULTRON_FASTEMBED_CACHE") {
        if !dir.trim().is_empty() {
            return std::path::PathBuf::from(dir);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".ultron")
        .join(".fastembed_cache")
}

/// Produce a normalised 384-d embedding vector for `text`.
///
/// On the first call the ONNX model is downloaded/verified from the fastembed
/// model hub and cached at the canonical dir (see [`fastembed_cache_dir`]).
/// Subsequent calls are served from the in-process `OnceCell`.
///
/// Returns `Err` if the model fails to initialise or inference fails.
#[cfg(feature = "qdrant")]
pub fn embed(text: &str) -> Result<Vec<f32>, String> {
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
    use std::sync::OnceLock;

    let model = EMBEDDING_MODEL.get_or_try_init(|| {
        TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::BGESmallENV15)
                .with_show_download_progress(false)
                .with_cache_dir(fastembed_cache_dir()),
        )
        .map_err(|e| format!("fastembed init: {e}"))
    })?;

    let mut results = model
        .embed(vec![text], None)
        .map_err(|e| format!("fastembed embed: {e}"))?;

    let vec = results
        .pop()
        .ok_or_else(|| "fastembed returned empty results".to_string())?;

    // Safety net: real fastembed should never return all-zeros for non-empty text.
    if vec.iter().all(|&x| x == 0.0) {
        static ZERO_WARNED: OnceLock<()> = OnceLock::new();
        ZERO_WARNED.get_or_init(|| {
            eprintln!(
                "[memory] EMBED STUB — embed() returned all-zeros despite qdrant feature being ON; \
                 recall will be degraded. Check the fastembed model cache at \
                 ULTRON_FASTEMBED_CACHE (default ~/.ultron/.fastembed_cache/)."
            );
        });
    }

    Ok(vec)
}

/// Stub when the `qdrant` feature is not enabled: returns a zero vector of
/// length 384 so callers compile and tests can run without the heavy dep.
#[cfg(not(feature = "qdrant"))]
pub fn embed(_text: &str) -> Result<Vec<f32>, String> {
    use std::sync::OnceLock;
    static WARNED: OnceLock<()> = OnceLock::new();
    WARNED.get_or_init(|| {
        eprintln!(
            "[memory] EMBED STUB — embeddings disabled; recall degraded. \
             Build with --features qdrant to enable real BGE-small-EN-v1.5 vectors."
        );
    });
    Ok(vec![0.0_f32; 384])
}

// ---------------------------------------------------------------------------
// MultilingualE5Large — 1024-d, multilingual (MEMORY KERNEL Fase B)
// ---------------------------------------------------------------------------

/// Dense 1024-d embedding with `MultilingualE5Large` (intfloat/multilingual-e5-large).
///
/// E5 was trained with ASYMMETRIC instruction prefixes that fastembed does NOT
/// add automatically: `is_query = true` prepends `"query: "`, `false` prepends
/// `"passage: "`. Output is L2-normalised by fastembed (ideal for Cosine).
#[cfg(feature = "qdrant")]
pub fn embed_e5(text: &str, is_query: bool) -> Result<Vec<f32>, String> {
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

    let prefixed = if is_query {
        format!("query: {text}")
    } else {
        format!("passage: {text}")
    };

    // Memo hit: identical prefixed text -> identical vector (E5 is deterministic).
    let cache = EMBED_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(v) = guard.get(&prefixed) {
            return Ok(v.clone());
        }
    }

    let model = E5_MODEL.get_or_try_init(|| {
        TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::MultilingualE5Large)
                .with_show_download_progress(false)
                .with_cache_dir(fastembed_cache_dir()),
        )
        .map_err(|e| format!("fastembed E5 init: {e}"))
    })?;

    let mut results = model
        .embed(vec![prefixed.clone()], None)
        .map_err(|e| format!("fastembed E5 embed: {e}"))?;

    let vector = results
        .pop()
        .ok_or_else(|| "fastembed E5 returned empty results".to_string())?;

    // Populate the memo (bounded; wholesale clear keeps it simple, not a strict LRU).
    if let Ok(mut guard) = cache.lock() {
        if guard.len() >= EMBED_CACHE_CAP {
            guard.clear();
        }
        guard.insert(prefixed, vector.clone());
    }
    Ok(vector)
}

/// Stub when the `qdrant` feature is off: 1024-d zero vector. Callers MUST treat
/// an all-zero vector as "E5 unavailable" and degrade to sparse-only recall.
#[cfg(not(feature = "qdrant"))]
pub fn embed_e5(_text: &str, _is_query: bool) -> Result<Vec<f32>, String> {
    Ok(vec![0.0_f32; 1024])
}

// ---------------------------------------------------------------------------
// Qdrant collection bootstrap
// ---------------------------------------------------------------------------

/// Ensure the collection exists with cosine distance + 384-d vectors.
/// Idempotent — no-op if the collection is already present.
pub fn ensure_collection(collection: &str) -> Result<(), String> {
    let base = qdrant_base_url();
    let client = http_client()?;
    let url = format!("{base}/collections/{collection}");

    // Check existence first.
    let resp = client.get(&url).send().map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            qdrant_not_running_msg(&base)
        } else {
            format!("qdrant GET collection: {e}")
        }
    })?;

    if resp.status().as_u16() == 200 {
        return Ok(()); // already exists
    }

    // Create it.
    let body = serde_json::json!({
        "vectors": {
            "size": 384,
            "distance": "Cosine"
        }
    });
    let create = client
        .put(&url)
        .json(&body)
        .send()
        .map_err(|e| format!("qdrant PUT collection: {e}"))?;

    if !create.status().is_success() {
        let status = create.status().as_u16();
        let text = create.text().unwrap_or_default();
        return Err(format!("qdrant create collection {status}: {text}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

/// Upsert a vector + payload into a Qdrant collection.
///
/// `id` must be either a UUID string or a u64. We accept any string and let
/// Qdrant validate it — if you pass an integer-looking string we wrap it in
/// a numeric JSON value.
pub fn upsert_point(
    collection: &str,
    id: &str,
    vector: Vec<f32>,
    payload: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    ensure_collection(collection)?;

    let base = qdrant_base_url();
    let client = http_client()?;

    // Qdrant accepts either a UUID string or u64 integer as point id.
    let id_value: serde_json::Value = if let Ok(n) = id.parse::<u64>() {
        serde_json::Value::Number(n.into())
    } else {
        serde_json::Value::String(id.to_string())
    };

    let body = serde_json::json!({
        "points": [{
            "id": id_value,
            "vector": vector,
            "payload": payload
        }]
    });

    let url = format!("{base}/collections/{collection}/points");
    let resp = client.put(&url).json(&body).send().map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            qdrant_not_running_msg(&base)
        } else {
            format!("qdrant upsert: {e}")
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        return Err(format!("qdrant upsert {status}: {text}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// E5 / 1024-d REST helpers (MEMORY KERNEL Fase B — additive, leaves the legacy
// 384-d path above untouched; that path is retired in Fase F)
// ---------------------------------------------------------------------------

/// Like `ensure_collection` but with a caller-specified vector dimension.
pub fn ensure_collection_dim(collection: &str, dim: usize) -> Result<(), String> {
    let base = qdrant_base_url();
    let client = http_client()?;
    let url = format!("{base}/collections/{collection}");
    let resp = client.get(&url).send().map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            qdrant_not_running_msg(&base)
        } else {
            format!("qdrant GET collection: {e}")
        }
    })?;
    if resp.status().as_u16() == 200 {
        return Ok(());
    }
    let body = serde_json::json!({ "vectors": { "size": dim, "distance": "Cosine" } });
    let create = client
        .put(&url)
        .json(&body)
        .send()
        .map_err(|e| format!("qdrant PUT collection: {e}"))?;
    if !create.status().is_success() {
        let status = create.status().as_u16();
        let text = create.text().unwrap_or_default();
        return Err(format!("qdrant create collection {status}: {text}"));
    }
    Ok(())
}

/// Upsert a 1024-d E5 vector + payload, ensuring the collection exists at dim 1024.
pub fn upsert_e5(
    collection: &str,
    id: &str,
    vector: Vec<f32>,
    payload: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    ensure_collection_dim(collection, 1024)?;
    let base = qdrant_base_url();
    let client = http_client()?;
    let id_value: serde_json::Value = if let Ok(n) = id.parse::<u64>() {
        serde_json::Value::Number(n.into())
    } else {
        serde_json::Value::String(id.to_string())
    };
    let body = serde_json::json!({
        "points": [{ "id": id_value, "vector": vector, "payload": payload }]
    });
    let url = format!("{base}/collections/{collection}/points");
    let resp = client.put(&url).json(&body).send().map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            qdrant_not_running_msg(&base)
        } else {
            format!("qdrant upsert: {e}")
        }
    })?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        return Err(format!("qdrant upsert {status}: {text}"));
    }
    Ok(())
}

/// Delete a point by id from a collection (best-effort retire-from-index, used
/// by "do not use again" / deprecate). A missing collection/point is not an error.
pub fn delete_point(collection: &str, id: &str) -> Result<(), String> {
    let base = qdrant_base_url();
    let client = http_client()?;
    let id_value: serde_json::Value = if let Ok(n) = id.parse::<u64>() {
        serde_json::Value::Number(n.into())
    } else {
        serde_json::Value::String(id.to_string())
    };
    let url = format!("{base}/collections/{collection}/points/delete");
    let body = serde_json::json!({ "points": [id_value] });
    let resp = client.post(&url).json(&body).send().map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            qdrant_not_running_msg(&base)
        } else {
            format!("qdrant delete: {e}")
        }
    })?;
    if resp.status().as_u16() == 404 {
        return Ok(());
    }
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        return Err(format!("qdrant delete {status}: {text}"));
    }
    Ok(())
}

/// k-NN search with a PRECOMPUTED vector (from `embed_e5`) + optional payload
/// filter. Returns up to `k` hits. Unlike `search`, this does not embed the
/// query itself — so the E5 `query:` prefix is applied by the caller.
pub fn search_with_vector(
    collection: &str,
    vector: Vec<f32>,
    k: u32,
    filter: Option<serde_json::Value>,
) -> Result<Vec<QdrantHit>, String> {
    let base = qdrant_base_url();
    let client = http_client()?;
    let url = format!("{base}/collections/{collection}/points/search");
    let mut body = serde_json::json!({
        "vector": vector, "limit": k, "with_payload": true, "with_vector": false
    });
    if let Some(f) = filter {
        body["filter"] = f;
    }
    let resp = client.post(&url).json(&body).send().map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            qdrant_not_running_msg(&base)
        } else {
            format!("qdrant search: {e}")
        }
    })?;
    if resp.status().as_u16() == 404 {
        return Ok(Vec::new());
    }
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        return Err(format!("qdrant search {status}: {text}"));
    }
    #[derive(Deserialize)]
    struct SearchResponse {
        result: Vec<RawHit>,
    }
    #[derive(Deserialize)]
    struct RawHit {
        id: serde_json::Value,
        score: f32,
        #[serde(default)]
        payload: HashMap<String, serde_json::Value>,
    }
    let parsed: SearchResponse = resp
        .json()
        .map_err(|e| format!("qdrant parse response: {e}"))?;
    Ok(parsed
        .result
        .into_iter()
        .map(|h| QdrantHit {
            id: match h.id {
                serde_json::Value::String(s) => s,
                other => other.to_string(),
            },
            score: h.score,
            payload: h.payload,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// Semantic search: embed `query`, run a k-NN search in `collection`, return
/// up to `k` results ordered by descending score.
///
/// Returns `Err` with a friendly message when Qdrant is unreachable.
/// A raw point fetched from Qdrant (id + payload, no vector).
#[derive(Debug, Clone)]
pub struct QdrantPoint {
    pub id: String,
    pub payload: serde_json::Map<String, serde_json::Value>,
}

/// Scroll up to `limit` points (payload only) from `collection`. Used by the
/// memory ETL (Fase A3) to migrate `ultron_sessions` into the canonical store.
/// Returns an empty vec when the collection does not exist.
pub fn scroll(collection: &str, limit: u32) -> Result<Vec<QdrantPoint>, String> {
    let base = qdrant_base_url();
    let client = http_client()?;
    let url = format!("{base}/collections/{collection}/points/scroll");
    let body = serde_json::json!({
        "limit": limit,
        "with_payload": true,
        "with_vector": false
    });
    let resp = client.post(&url).json(&body).send().map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            qdrant_not_running_msg(&base)
        } else {
            format!("qdrant scroll: {e}")
        }
    })?;
    if resp.status().as_u16() == 404 {
        return Ok(Vec::new());
    }
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        return Err(format!("qdrant scroll {status}: {text}"));
    }
    #[derive(Deserialize)]
    struct ScrollResponse {
        result: ScrollResult,
    }
    #[derive(Deserialize)]
    struct ScrollResult {
        points: Vec<RawPoint>,
    }
    #[derive(Deserialize)]
    struct RawPoint {
        id: serde_json::Value,
        #[serde(default)]
        payload: serde_json::Map<String, serde_json::Value>,
    }
    let parsed: ScrollResponse = resp
        .json()
        .map_err(|e| format!("qdrant scroll parse: {e}"))?;
    Ok(parsed
        .result
        .points
        .into_iter()
        .map(|p| QdrantPoint {
            id: match p.id {
                serde_json::Value::String(s) => s,
                other => other.to_string(),
            },
            payload: p.payload,
        })
        .collect())
}

pub fn search(collection: &str, query: &str, k: u32) -> Result<Vec<QdrantHit>, String> {
    let base = qdrant_base_url();

    // Embed the query.
    let vector = embed(query)?;

    let client = http_client()?;
    let url = format!("{base}/collections/{collection}/points/search");

    let body = serde_json::json!({
        "vector": vector,
        "limit": k,
        "with_payload": true,
        "with_vector": false
    });

    let resp = client.post(&url).json(&body).send().map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            qdrant_not_running_msg(&base)
        } else {
            format!("qdrant search: {e}")
        }
    })?;

    if resp.status().as_u16() == 404 {
        // Collection does not exist yet — return empty results rather than error.
        return Ok(Vec::new());
    }

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        return Err(format!("qdrant search {status}: {text}"));
    }

    #[derive(Deserialize)]
    struct SearchResponse {
        result: Vec<RawHit>,
    }
    #[derive(Deserialize)]
    struct RawHit {
        id: serde_json::Value,
        score: f32,
        #[serde(default)]
        payload: HashMap<String, serde_json::Value>,
    }

    let parsed: SearchResponse = resp
        .json()
        .map_err(|e| format!("qdrant parse response: {e}"))?;

    let hits = parsed
        .result
        .into_iter()
        .map(|h| QdrantHit {
            id: match h.id {
                serde_json::Value::String(s) => s,
                serde_json::Value::Number(n) => n.to_string(),
                other => other.to_string(),
            },
            score: h.score,
            payload: h.payload,
        })
        .collect();

    Ok(hits)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Tauri command: produce a 384-d BGE-small-EN-v1.5 embedding for `text`.
///
/// Intended for frontend use cases (e.g. client-side similarity comparison,
/// debugging). JS hooks cannot call Tauri commands — they must use the
/// `ultron-embed` sidecar binary instead.
///
/// # Errors
/// - `"spawn_blocking: …"` if the thread-pool is saturated.
/// - `"fastembed init: …"` on first call if the ONNX model cannot be loaded.
#[tauri::command]
pub async fn qdrant_embed_query(text: String) -> Result<Vec<f32>, String> {
    tauri::async_runtime::spawn_blocking(move || embed(&text))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Tauri command: semantic recall from the `ultron_sessions` Qdrant collection.
///
/// Returns up to `k` fact hits. If Qdrant is not running the error string
/// contains the expected start command.
///
/// # Errors
/// - Qdrant unreachable: `"Qdrant not running at …"` with start instructions.
/// - Model init failure (first call only): fastembed ONNX download issue.
#[tauri::command]
pub async fn recall_semantic(query: String, k: Option<u32>) -> Result<Vec<QdrantHit>, String> {
    let k = k.unwrap_or(5).min(20);
    tauri::async_runtime::spawn_blocking(move || search("ultron_sessions", &query, k))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

// ---------------------------------------------------------------------------
// Health / status (used by diagnostics panel)
// ---------------------------------------------------------------------------

/// Returns `Ok(version_string)` when Qdrant is reachable, `Err(hint)` otherwise.
pub fn qdrant_ping() -> Result<String, String> {
    let base = qdrant_base_url();
    let client = http_client()?;
    let resp = client.get(format!("{base}/")).send().map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            qdrant_not_running_msg(&base)
        } else {
            format!("qdrant ping: {e}")
        }
    })?;

    #[derive(Deserialize)]
    struct PingResponse {
        version: Option<String>,
        title: Option<String>,
    }
    let pr: PingResponse = resp.json().unwrap_or(PingResponse {
        version: None,
        title: None,
    });

    Ok(pr.version.or(pr.title).unwrap_or_else(|| "ok".to_string()))
}

/// Tauri command: ping Qdrant. Used by the Memory status panel.
#[tauri::command]
pub async fn qdrant_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(qdrant_ping)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
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
}
