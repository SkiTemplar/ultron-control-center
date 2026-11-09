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

// ---------------------------------------------------------------------------
// Embedding E5 + liberación de modelos por inactividad — extraído a fichero
// hermano (límite 800 líneas). Mismo crate-path público vía re-export.
// ---------------------------------------------------------------------------
#[path = "qdrant_embed.rs"]
mod qdrant_embed;
pub use qdrant_embed::{embed_e5, loaded_models, release_idle_models};
#[cfg(feature = "qdrant")]
pub(crate) use qdrant_embed::{fastembed_cache_dir, now_ms, RERANK_LAST_USED_MS};

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
    dense_enabled()
        && !matches!(
            std::env::var("ULTRON_RERANK").as_deref(),
            Ok("0") | Ok("false")
        )
}

/// Master switch for the dense stack (E5 embeddings + cross-encoder):
/// `ULTRON_DENSE=0`/`false` turns both off at runtime without rebuilding
/// without the `qdrant` feature. Recall degrades to sparse FTS5 and neither
/// model (~1.5 GB each) is ever loaded. Default ON.
///
/// Not feature-gated, like [`reranker_enabled`].
pub fn dense_enabled() -> bool {
    !matches!(
        std::env::var("ULTRON_DENSE").as_deref(),
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

/// Modo del cross-encoder en el HOT PATH (`ULTRON_RERANK_HOT`):
///   `1`/`true`  -> siempre; `0`/`false` -> nunca;
///   sin definir o `route` -> solo cuando el intent del turno NO está en
///   `RERANK_HOT_SKIP_INTENTS` (`general`, `continue`, `quick`).
///
/// Decidido el 2026-09-06 sobre el golden v2 (30 prompts reales,
/// con proyecto): nDCG@8 0.391 -> 0.650 y MRR 0.256 -> 0.652 con re-rank, a
/// 2-2.4 s por prompt en CPU. En `general` (charla, "sigue", acks) el pack
/// no compensa la latencia; en el resto sí.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RerankHotMode {
    Always,
    Never,
    Route,
}

pub fn rerank_hot_mode() -> RerankHotMode {
    match std::env::var("ULTRON_RERANK_HOT").as_deref() {
        Ok("1") | Ok("true") => RerankHotMode::Always,
        Ok("0") | Ok("false") => RerankHotMode::Never,
        _ => RerankHotMode::Route,
    }
}

/// Intents que en modo `Route` NO pagan el cross-encoder: charla y acks
/// (`general`), "sigue con lo que estabas" (`continue`) y arreglos rápidos
/// (`quick`). En 30 días de tráfico real (494 turnos) suman el 39 %.
pub const RERANK_HOT_SKIP_INTENTS: &[&str] = &["general", "continue", "quick"];

/// Decisión por turno: re-rank en el hot path para este `intent`.
pub fn rerank_hot_for_intent(intent: &str) -> bool {
    if !reranker_enabled() {
        return false;
    }
    match rerank_hot_mode() {
        RerankHotMode::Always => true,
        RerankHotMode::Never => false,
        RerankHotMode::Route => !RERANK_HOT_SKIP_INTENTS.contains(&intent),
    }
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

// ---------------------------------------------------------------------------
// Cross-encoder BGE (re-ranker) — extraido a fichero hermano (limite 800
// lineas, cat7.3). Mismo crate-path publico: se re-exporta todo tal cual.
// ---------------------------------------------------------------------------
#[path = "qdrant_rerank.rs"]
mod qdrant_rerank;
pub use qdrant_rerank::*;
// Turno FIFO de los forward pass de ONNX (E5 + cross-encoder): uno a la vez.
#[cfg(feature = "qdrant")]
#[path = "qdrant_inference_gate.rs"]
mod qdrant_inference_gate;
#[cfg(feature = "qdrant")]
pub(crate) use qdrant_inference_gate::inference_turn;
#[cfg(feature = "qdrant")]
pub use qdrant_inference_gate::take_inference_wait_ms;
/// Sin la feature no hay modelos ni, por tanto, espera de turno.
#[cfg(not(feature = "qdrant"))]
pub fn take_inference_wait_ms() -> u64 {
    0
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
