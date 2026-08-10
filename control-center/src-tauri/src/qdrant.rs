// ULTRON Control Center — Qdrant semantic recall.
//
// Provides local vector search over session facts stored in a Qdrant instance
// running on the same machine. Public entry-points:
//
//   `embed_e5(text, is_query)` — produce a 1024-d MultilingualE5Large vector.
//   `search_with_vector(...)` — k-NN search in Qdrant with a precomputed vector.
//   `scroll(...)`, `upsert_e5(...)`, `delete_point(...)` — collection helpers.
//
// Transport: Qdrant REST API on port 6333 (or QDRANT_URL env var). No gRPC
// dependency — we reuse the `reqwest` client already in Cargo.toml.
//
// Embedding: `fastembed` crate — MultilingualE5Large (1024d, ~2.2 GB, the
// canonical recall embedder). ONNX models are cached at the canonical dir
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

/// Shared `reqwest::blocking::Client`, built once per process.
///
/// WHY a `OnceCell` and not a fresh client per call: every `reqwest::Client`
/// owns its own connection pool, so rebuilding one on each request (the prior
/// behaviour) threw away the keep-alive TCP connection to Qdrant AND repaid the
/// client construction cost (DNS resolver, TLS backend, pool setup) every time.
/// A single `orchestrate` issues several Qdrant calls (dense recall + scrolls);
/// reusing one pooled client keeps the localhost connection warm across them
/// (~1.3s → ~0.7s measured). The client is internally `Arc`-shared and `Send`/
/// `Sync`, so the `&'static` reference is safe to hand to every caller — and
/// since every call site only uses `&self` methods (`.post`/`.get`), the
/// signature change is transparent to them.
fn http_client() -> Result<&'static reqwest::blocking::Client, String> {
    static HTTP_CLIENT: OnceCell<reqwest::blocking::Client> = OnceCell::new();
    HTTP_CLIENT.get_or_try_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            // Fail-fast (2026-08-10): con Qdrant caído/colgado el connect no
            // puede consumir los 10s del timeout total — 1s y a sparse. El
            // timeout total alto se mantiene para transferencias legítimas
            // (scroll de 100k puntos).
            .connect_timeout(Duration::from_secs(1))
            // Keep idle connections to Qdrant alive between calls within a
            // session so repeated recalls reuse the same socket.
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .build()
            .map_err(|e| format!("http client build: {e}"))
    })
}

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
// E5 / 1024-d REST helpers (MEMORY KERNEL Fase B)
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

/// Fetch a point's STORED vector by id (`None` si el punto no existe). El
/// backfill de project_id vota con el vector ya embebido: re-embedar ~3.4k
/// items a ~1 s/query E5 costaría una hora; el vector ya vive en el índice.
pub fn get_point_vector(collection: &str, id: &str) -> Result<Option<Vec<f32>>, String> {
    let base = qdrant_base_url();
    let client = http_client()?;
    let id_value: serde_json::Value = if let Ok(n) = id.parse::<u64>() {
        serde_json::Value::Number(n.into())
    } else {
        serde_json::Value::String(id.to_string())
    };
    let url = format!("{base}/collections/{collection}/points");
    let body = serde_json::json!({ "ids": [id_value], "with_vector": true, "with_payload": false });
    let resp = client.post(&url).json(&body).send().map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            qdrant_not_running_msg(&base)
        } else {
            format!("qdrant get point: {e}")
        }
    })?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        return Err(format!("qdrant get point {status}: {text}"));
    }
    #[derive(Deserialize)]
    struct RetrieveResponse {
        result: Vec<RawPoint>,
    }
    #[derive(Deserialize)]
    struct RawPoint {
        #[serde(default)]
        vector: Option<Vec<f32>>,
    }
    let parsed: RetrieveResponse = resp
        .json()
        .map_err(|e| format!("qdrant parse retrieve: {e}"))?;
    Ok(parsed.result.into_iter().next().and_then(|p| p.vector))
}

/// Overwrite payload KEYS on an existing point (merge semantics del endpoint
/// `points/payload` de Qdrant: solo pisa las claves enviadas, no toca el
/// vector ni el resto del payload). Missing collection/point no es error.
pub fn set_payload(collection: &str, id: &str, payload: serde_json::Value) -> Result<(), String> {
    let base = qdrant_base_url();
    let client = http_client()?;
    let id_value: serde_json::Value = if let Ok(n) = id.parse::<u64>() {
        serde_json::Value::Number(n.into())
    } else {
        serde_json::Value::String(id.to_string())
    };
    let url = format!("{base}/collections/{collection}/points/payload");
    let body = serde_json::json!({ "points": [id_value], "payload": payload });
    let resp = client.post(&url).json(&body).send().map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            qdrant_not_running_msg(&base)
        } else {
            format!("qdrant set payload: {e}")
        }
    })?;
    if resp.status().as_u16() == 404 {
        return Ok(());
    }
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        return Err(format!("qdrant set payload {status}: {text}"));
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
// Scroll / point types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Health / status (used by diagnostics panel)
// ---------------------------------------------------------------------------

/// `/healthz` con caché de proceso y TTL asimétrico — el gate fail-fast de los
/// paths densos. Audit 2026-08-09: con Qdrant caído cada prompt pagaba embed E5
/// más timeout HTTP para inyectar contexto VACÍO; el modo sparse existía pero
/// nada lo activaba. Sano se re-verifica cada 30s; caído cada 5s para detectar
/// rápido el relaunch del watchdog. Coste acotado: un probe corto por ventana.
pub fn qdrant_healthy_cached() -> bool {
    const TTL_OK: Duration = Duration::from_secs(30);
    const TTL_DOWN: Duration = Duration::from_secs(5);
    static CACHE: OnceCell<std::sync::Mutex<Option<(std::time::Instant, bool)>>> = OnceCell::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(None));
    let mut guard = match cache.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some((at, healthy)) = *guard {
        let ttl = if healthy { TTL_OK } else { TTL_DOWN };
        if at.elapsed() < ttl {
            return healthy;
        }
    }
    let healthy = probe_healthz();
    *guard = Some((std::time::Instant::now(), healthy));
    healthy
}

/// Probe crudo (sin caché) de `/healthz`. Timeout por-request corto: el gate no
/// puede costar más que lo que ahorra.
fn probe_healthz() -> bool {
    let base = qdrant_base_url();
    let Ok(client) = http_client() else {
        return false;
    };
    client
        .get(format!("{base}/healthz"))
        .timeout(Duration::from_millis(1500))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

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
// Cross-encoder re-ranker — BGERerankerV2M3 (feature = "qdrant")
// ---------------------------------------------------------------------------
//
// Opt-in via `ULTRON_RERANK=1` (default OFF). With the flag absent the recall
// pipeline is byte-for-byte identical to the baseline (nDCG@8 / recall@8
// unchanged). When active, `engine.rs` passes the top RERANK_TOP_N (24)
// fused candidates through the cross-encoder after the heuristic quality
// multiplier and before `assemble_pack`.
//
// Public API (consumed by engine.rs and the warmup subcommand):
//   `reranker_enabled()`               — flag check; non-feature-gated
//   `rerank_pairs(query, docs)`        — cross-encoder score; feature-gated
//   `warmup_reranker()`                — force model init; feature-gated

/// Cross-encoder re-ranker: **ON por defecto** desde 2026-07-03; opt-out con
/// `ULTRON_RERANK=0`/`false` (y `=1`/`true` sigue siendo un ON explícito).
///
/// Justificación MEDIDA contra el oráculo golden (29 queries, 2026-07-03):
/// recall@8 0.682→0.709, p@3 0.379→0.483, nDCG 0.559→0.633 con N=24. El
/// veredicto negativo del A/B de 2026-07-02 era contra el bench y el corpus
/// pre-higiene; contra el golden actual el cross-encoder gana en todo.
///
/// Not feature-gated — callers can check the flag regardless of whether the
/// `qdrant` Cargo feature is enabled.
pub fn reranker_enabled() -> bool {
    !matches!(
        std::env::var("ULTRON_RERANK").as_deref(),
        Ok("0") | Ok("false")
    )
}

/// Opt-in del cross-encoder en el HOT PATH del hook UserPromptSubmit
/// (`ULTRON_RERANK_HOT=1`/`true`). Default OFF: el re-rank cuesta ~2-2.4 s por
/// llamada en CPU y el prefetch por prompt vive en p50 ~134 ms — quien acepte
/// pagar la latencia en cada prompt lo enciende explicitamente. Los paths de
/// calidad (recall CLI/browser/trace/evals) NO consultan este flag: alli el
/// re-rank va ON salvo apagado global (`ULTRON_RERANK=0`).
pub fn rerank_hot_enabled() -> bool {
    matches!(
        std::env::var("ULTRON_RERANK_HOT").as_deref(),
        Ok("1") | Ok("true")
    )
}

/// Returns `true` when `ULTRON_CR` is set to `"1"` or `"true"`.
///
/// Controls **Contextual Retrieval (CR)**: when active, `MemoryItem::searchable_text`
/// prefixes each passage with project and type context before embedding:
/// `"Proyecto: {project_id}. Tipo: {kind}.\n{title}\n{summary}\n{content}"`.
/// This separates items from different projects/types in the vector space,
/// reducing cross-project recall collisions (e.g. a "decision" query for
/// `ultron` retrieving unrelated decisions from `sistemasdistribuidos`).
///
/// Default **OFF** — with the flag absent the baseline (nDCG@8 / recall@8)
/// is byte-for-byte identical to the previous behaviour.
///
/// Not feature-gated — callers can check the flag regardless of whether the
/// `qdrant` Cargo feature is enabled.
pub fn cr_enabled() -> bool {
    matches!(std::env::var("ULTRON_CR").as_deref(), Ok("1") | Ok("true"))
}

/// Lazy `BGERerankerV2M3` — one instance per process, shared across threads.
/// Initialised on the first call to `rerank_pairs`; afterwards all calls pay
/// only the inference cost.
#[cfg(feature = "qdrant")]
static RERANKER: OnceCell<fastembed::TextRerank> = OnceCell::new();

/// Re-rank `docs` (id, text) pairs against `query` using `BGERerankerV2M3`.
///
/// Returns `Vec<(id, cross_encoder_score)>` ordered by score **DESC**. The
/// caller maps the returned order back onto its candidate list.
///
/// The fast-path guard (`docs.is_empty()`) returns immediately without
/// touching the model — used for hermetic tests.
///
/// # Errors
///
/// Returns `Err(String)` when the model cannot be initialised or the rerank
/// call fails. The caller in `engine.rs` **must** fall back to the existing
/// order on `Err` and never propagate the error — recall must continue even
/// if the re-ranker is unavailable.
#[cfg(feature = "qdrant")]
pub fn rerank_pairs(query: &str, docs: &[(String, String)]) -> Result<Vec<(String, f32)>, String> {
    use fastembed::{RerankInitOptions, RerankerModel, TextRerank};

    if docs.is_empty() {
        return Ok(Vec::new());
    }

    let reranker = RERANKER.get_or_try_init(|| {
        TextRerank::try_new(
            RerankInitOptions::new(RerankerModel::BGERerankerV2M3)
                .with_cache_dir(fastembed_cache_dir())
                .with_show_download_progress(false),
        )
        .map_err(|e| format!("reranker init (BGERerankerV2M3): {e}"))
    })?;

    let texts: Vec<&str> = docs.iter().map(|(_, text)| text.as_str()).collect();
    let results = reranker
        .rerank(query, texts, false, None)
        .map_err(|e| format!("reranker rerank call: {e}"))?;

    // `results` is already sorted score DESC by fastembed; map index → id.
    Ok(results
        .iter()
        .map(|r| (docs[r.index].0.clone(), r.score))
        .collect())
}

/// Stub when the `qdrant` feature is absent. Always returns `Err` so callers
/// fall back to the existing order (identical to flag-OFF behaviour).
#[cfg(not(feature = "qdrant"))]
pub fn rerank_pairs(
    _query: &str,
    _docs: &[(String, String)],
) -> Result<Vec<(String, f32)>, String> {
    Err("rerank_pairs: qdrant feature not enabled".to_string())
}

/// Force `BGERerankerV2M3` to initialise (downloading ~1 GB on first use) by
/// running one trivial rerank. Call from the `warmup` sidecar subcommand
/// **only** when `reranker_enabled()` is true — the download must not be
/// triggered for users who have not opted in.
///
/// # Errors
/// Returns `Err` if the model download or init fails. The caller logs the
/// error but must not block the session.
#[cfg(feature = "qdrant")]
pub fn warmup_reranker() -> Result<(), String> {
    rerank_pairs(
        "warmup",
        &[("__warmup__".to_string(), "warmup document".to_string())],
    )
    .map(|_| ())
}

/// Stub when the `qdrant` feature is absent.
#[cfg(not(feature = "qdrant"))]
pub fn warmup_reranker() -> Result<(), String> {
    Err("warmup_reranker: qdrant feature not enabled".to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
