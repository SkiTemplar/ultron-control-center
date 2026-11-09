// ULTRON Control Center — embedding E5 y ciclo de vida de los modelos ONNX.
//
// Extraído de `qdrant.rs` (límite de 800 líneas) sin cambio de comportamiento;
// el path público no cambia: `qdrant.rs` re-exporta `embed_e5`,
// `release_idle_models`, `loaded_models` y, dentro del crate, `now_ms`,
// `fastembed_cache_dir` y `RERANK_LAST_USED_MS` (los usa `qdrant_rerank.rs`).

#[cfg(feature = "qdrant")]
use once_cell::sync::OnceCell;

#[cfg(feature = "qdrant")]
use super::{dense_enabled, inference_turn, qdrant_rerank};

/// MultilingualE5Large (1024-d, multilingual) — the Fase B canonical embedder.
///
/// Vive en un `RwLock<Option<_>>` y no en un `OnceCell` para poder SOLTARLO:
/// el modelo ocupa ~1,5 GB residentes y hasta 2026-08-15 se quedaba cargado
/// para siempre en cada proceso que lo tocara (medido: app 1.523 MB + daemon
/// 1.223 MB a la vez, con picos de 3,2 GB cuando un CLI hacía recall con
/// cross-encoder). Ahora `release_idle_models` lo libera tras un rato sin uso
/// y la siguiente llamada lo recarga.
#[cfg(feature = "qdrant")]
static E5_MODEL: OnceCell<std::sync::RwLock<Option<fastembed::TextEmbedding>>> = OnceCell::new();

/// Epoch ms del último uso de E5 / del reranker. Los pone a cero el release.
#[cfg(feature = "qdrant")]
static E5_LAST_USED_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
#[cfg(feature = "qdrant")]
pub(crate) static RERANK_LAST_USED_MS: std::sync::atomic::AtomicI64 =
    std::sync::atomic::AtomicI64::new(0);

#[cfg(feature = "qdrant")]
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Minutos de inactividad tras los que se sueltan los modelos. `0` = nunca
/// (comportamiento anterior, para quien prefiera latencia constante).
/// E5: `ULTRON_MODEL_IDLE_MIN` (default 30). Reranker: la mitad, mínimo 1 —
/// pesa otros ~1,5 GB y se usa mucho menos. El default subió de 5 a 30 el
/// 2026-08-17: con 5 min cualquier pausa corta enfriaba el daemon y el primer
/// prompt al volver pagaba la recarga de ~3 GB y entraba sin memoria (12 casos
/// medidos en 3 días). 30 min cubre una sesión de trabajo real; una máquina
/// frugal puede seguir bajándolo por variable de entorno.
#[cfg(feature = "qdrant")]
fn idle_release_ms(reranker: bool) -> i64 {
    let min: i64 = std::env::var("ULTRON_MODEL_IDLE_MIN")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);
    if min <= 0 {
        return 0;
    }
    let min = if reranker { (min / 2).max(1) } else { min };
    min * 60_000
}

/// Suelta los modelos que lleven más de su ventana de inactividad sin usarse.
/// Devuelve qué se ha liberado, para que el llamante lo pueda registrar.
/// Es idempotente y barato: sin nada cargado no toca ningún lock de escritura.
#[cfg(feature = "qdrant")]
pub fn release_idle_models() -> Vec<&'static str> {
    let mut soltados = Vec::new();
    let ahora = now_ms();

    let ventana_e5 = idle_release_ms(false);
    if ventana_e5 > 0 {
        let ultimo = E5_LAST_USED_MS.load(std::sync::atomic::Ordering::Relaxed);
        if ultimo > 0 && ahora - ultimo > ventana_e5 {
            if let Some(lock) = E5_MODEL.get() {
                if let Ok(mut guard) = lock.write() {
                    if guard.take().is_some() {
                        soltados.push("e5");
                        E5_LAST_USED_MS.store(0, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            }
        }
    }

    let ventana_rr = idle_release_ms(true);
    if ventana_rr > 0 {
        let ultimo = RERANK_LAST_USED_MS.load(std::sync::atomic::Ordering::Relaxed);
        if ultimo > 0 && ahora - ultimo > ventana_rr {
            if let Some(lock) = qdrant_rerank::RERANKER.get() {
                if let Ok(mut guard) = lock.write() {
                    if guard.take().is_some() {
                        soltados.push("reranker");
                        RERANK_LAST_USED_MS.store(0, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            }
        }
    }
    soltados
}

/// ¿Qué modelos están cargados ahora mismo? Para diagnóstico (doctor / logs).
#[cfg(feature = "qdrant")]
pub fn loaded_models() -> Vec<&'static str> {
    let mut v = Vec::new();
    if E5_MODEL
        .get()
        .and_then(|l| l.read().ok().map(|g| g.is_some()))
        .unwrap_or(false)
    {
        v.push("e5");
    }
    if qdrant_rerank::RERANKER
        .get()
        .and_then(|l| l.read().ok().map(|g| g.is_some()))
        .unwrap_or(false)
    {
        v.push("reranker");
    }
    v
}

/// Stubs sin la feature: no hay modelos que soltar.
#[cfg(not(feature = "qdrant"))]
pub fn release_idle_models() -> Vec<&'static str> {
    Vec::new()
}
#[cfg(not(feature = "qdrant"))]
pub fn loaded_models() -> Vec<&'static str> {
    Vec::new()
}

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
pub(crate) fn fastembed_cache_dir() -> std::path::PathBuf {
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

    // Runtime kill switch: same contract as the non-`qdrant` stub (all-zero
    // vector = "E5 unavailable", callers degrade to sparse-only) and the model
    // is never loaded, so the daemon stays at its idle footprint.
    if !dense_enabled() {
        return Ok(vec![0.0_f32; 1024]);
    }

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

    let lock = E5_MODEL.get_or_init(|| std::sync::RwLock::new(None));
    E5_LAST_USED_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);

    // Carga perezosa bajo lock de escritura solo cuando de verdad falta: si el
    // release lo soltó, la siguiente llamada lo vuelve a traer.
    {
        let cargado = lock.read().map(|g| g.is_some()).unwrap_or(false);
        if !cargado {
            let mut guard = lock
                .write()
                .map_err(|_| "E5 model lock poisoned".to_string())?;
            if guard.is_none() {
                let model = TextEmbedding::try_new(
                    InitOptions::new(EmbeddingModel::MultilingualE5Large)
                        .with_show_download_progress(false)
                        .with_cache_dir(fastembed_cache_dir()),
                )
                .map_err(|e| format!("fastembed E5 init: {e}"))?;
                *guard = Some(model);
            }
        }
    }

    let guard = lock
        .read()
        .map_err(|_| "E5 model lock poisoned".to_string())?;
    let model = guard
        .as_ref()
        .ok_or_else(|| "E5 model released mid-flight".to_string())?;

    // Turno de inferencia (ver qdrant_inference_gate.rs): un forward pass a la
    // vez en todo el proceso. Tras conseguirlo se vuelve a mirar el memo: si
    // otra petición del MISMO prompt (el `skill_judge`/`skill_query` del
    // dispatcher y el `orchestrate` llegan casi a la vez) lo calculó mientras
    // esta esperaba, se reutiliza en vez de repetir el embed. Es el
    // single-flight por texto, sin mapa de peticiones en vuelo.
    let _turno = inference_turn();
    if let Ok(memo) = cache.lock() {
        if let Some(v) = memo.get(&prefixed) {
            return Ok(v.clone());
        }
    }
    let mut results = model
        .embed(vec![prefixed.clone()], None)
        .map_err(|e| format!("fastembed E5 embed: {e}"))?;
    drop(guard);

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
