// qdrant_rerank.rs — cross-encoder BGERerankerV2M3: carga lazy, warmup en
// background y liberacion por inactividad. Extraido de qdrant.rs (cat7.3).
#[cfg(feature = "qdrant")]
use super::{fastembed_cache_dir, now_ms, RERANK_LAST_USED_MS};
#[cfg(feature = "qdrant")]
use once_cell::sync::OnceCell;

/// Lazy `BGERerankerV2M3` — one instance per process, shared across threads.
/// Initialised on the first call to `rerank_pairs`; afterwards all calls pay
/// only the inference cost.
/// Igual que E5: soltable. El cross-encoder son otros ~1,5 GB y solo lo usan
/// los paths de calidad (recall manual, trace, evals), así que su ventana de
/// inactividad es la mitad.
#[cfg(feature = "qdrant")]
pub(super) static RERANKER: OnceCell<std::sync::RwLock<Option<fastembed::TextRerank>>> =
    OnceCell::new();

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
/// Tope de tokens por par (query, documento) del cross-encoder.
///
/// 512 (default de fastembed) -> 256 (2026-09-07, decidido por el usuario tras
/// medir): los documentos son resúmenes de memoria de 50-100 tokens y el
/// prompt se recorta antes, así que 256 no trunca nada útil, y las arenas de
/// activación de ONNX crecen con la longitud máxima (medido: +290 MB tras 20
/// orchestrates largos y +550 MB con 4 concurrentes, con 512).
/// `ULTRON_RERANK_MAX_LEN` lo cambia sin recompilar (solo se lee al cargar).
#[cfg(feature = "qdrant")]
const RERANK_MAX_LENGTH_DEFAULT: usize = 256;

#[cfg(feature = "qdrant")]
fn reranker_max_length() -> usize {
    std::env::var("ULTRON_RERANK_MAX_LEN")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n >= 64)
        .unwrap_or(RERANK_MAX_LENGTH_DEFAULT)
}

/// Cross-encoder a cargar. `ULTRON_RERANKER_MODEL` = `bge-m3` (default,
/// BGERerankerV2M3, ~1,8 GB residentes) o `jina-v2` (JINA v2 base multilingüe,
/// más pequeño). Solo se lee al cargar el modelo: para un A/B se lanza el
/// `eval` en un proceso nuevo con la variable puesta (el daemon vivo no la ve).
#[cfg(feature = "qdrant")]
fn reranker_model() -> (fastembed::RerankerModel, &'static str) {
    use fastembed::RerankerModel;
    match std::env::var("ULTRON_RERANKER_MODEL")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "jina-v2" | "jina" => (
            RerankerModel::JINARerankerV2BaseMultiligual,
            "JINARerankerV2BaseMultilingual",
        ),
        _ => (RerankerModel::BGERerankerV2M3, "BGERerankerV2M3"),
    }
}

/// Identificador del cross-encoder activo (para telemetría y evals).
#[cfg(feature = "qdrant")]
pub fn reranker_model_id() -> &'static str {
    reranker_model().1
}

#[cfg(feature = "qdrant")]
pub fn rerank_pairs(query: &str, docs: &[(String, String)]) -> Result<Vec<(String, f32)>, String> {
    use fastembed::{RerankInitOptions, TextRerank};

    if docs.is_empty() {
        return Ok(Vec::new());
    }

    let lock = RERANKER.get_or_init(|| std::sync::RwLock::new(None));
    RERANK_LAST_USED_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
    {
        let cargado = lock.read().map(|g| g.is_some()).unwrap_or(false);
        if !cargado {
            let mut guard = lock
                .write()
                .map_err(|_| "reranker lock poisoned".to_string())?;
            if guard.is_none() {
                let (model_name, model_id) = reranker_model();
                let model = TextRerank::try_new(
                    RerankInitOptions::new(model_name)
                        .with_max_length(reranker_max_length())
                        .with_cache_dir(fastembed_cache_dir())
                        .with_show_download_progress(false),
                )
                .map_err(|e| format!("reranker init ({model_id}): {e}"))?;
                *guard = Some(model);
            }
        }
    }

    let guard = lock
        .read()
        .map_err(|_| "reranker lock poisoned".to_string())?;
    let reranker = guard
        .as_ref()
        .ok_or_else(|| "reranker released mid-flight".to_string())?;

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

/// ¿Está el cross-encoder residente AHORA MISMO?
///
/// Lo pregunta el hot path antes de decidir si rerankea: cargarlo cuesta ~8,6 s
/// medidos (2026-08-16, con E5 ya caliente) contra un presupuesto de hook de
/// 6 s, así que pedirlo en frío no devolvía mejor recall — devolvía un prompt
/// SIN memoria. Los paths de calidad no llaman aquí: allí se carga y se espera.
#[cfg(feature = "qdrant")]
pub fn reranker_is_warm() -> bool {
    RERANKER
        .get()
        .and_then(|l| l.read().ok().map(|g| g.is_some()))
        .unwrap_or(false)
}

/// Evita N hilos de carga si llegan N peticiones mientras el modelo se carga.
#[cfg(feature = "qdrant")]
static RERANK_LOADING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Carga el cross-encoder EN BACKGROUND y devuelve al momento.
///
/// `true` = esta llamada lanzó la carga; `false` = ya había una en vuelo (o el
/// modelo está cargado). El turno en curso responde sin rerank; a partir del
/// siguiente el modelo está caliente y vuelve la calidad plena (recall@8
/// medido: 0.491 sin rerank, 0.810 con él).
#[cfg(feature = "qdrant")]
pub fn spawn_reranker_warmup() -> bool {
    use std::sync::atomic::Ordering;
    if reranker_is_warm() || RERANK_LOADING.swap(true, Ordering::SeqCst) {
        return false;
    }
    std::thread::spawn(|| {
        if let Err(e) = warmup_reranker() {
            eprintln!("[rerank] carga en background fallida: {e}");
        }
        RERANK_LOADING.store(false, Ordering::SeqCst);
    });
    true
}

/// Stubs sin la feature: sin modelos, nunca hay nada caliente que cargar.
#[cfg(not(feature = "qdrant"))]
pub fn reranker_is_warm() -> bool {
    false
}
#[cfg(not(feature = "qdrant"))]
pub fn spawn_reranker_warmup() -> bool {
    false
}
#[cfg(not(feature = "qdrant"))]
pub fn reranker_model_id() -> &'static str {
    "none"
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
