// qdrant_rerank.rs — cross-encoder BGERerankerV2M3: carga lazy, warmup en
// background y liberacion por inactividad. Extraido de qdrant.rs (cat7.3).
#[cfg(feature = "qdrant")]
use super::{fastembed_cache_dir, now_ms, RERANK_LAST_USED_MS};
#[cfg(feature = "qdrant")]
use once_cell::sync::OnceCell;
#[cfg(feature = "qdrant")]
use std::time::Duration;

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
    if docs.is_empty() {
        return Ok(Vec::new());
    }
    // Un forward pass a la vez en el proceso (ver qdrant_inference_gate.rs).
    let _turno = super::inference_turn();
    rerank_pairs_en_turno(query, docs)
}

/// Cuerpo de `rerank_pairs` para quien YA tiene el turno de inferencia. La
/// carga perezosa del modelo también ocurre dentro del turno: cargar ocupa la
/// CPU igual que inferir.
#[cfg(feature = "qdrant")]
fn rerank_pairs_en_turno(
    query: &str,
    docs: &[(String, String)],
) -> Result<Vec<(String, f32)>, String> {
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

/// Techo de CUELGUE del forward pass del cross-encoder, contado desde que la
/// llamada consigue el turno de inferencia (no incluye la cola).
///
/// Historia: 2026-09-22 se puso un tope de 3,5 s porque, con el modelo
/// caliente, había re-ranks de 15-25 s que se comían el presupuesto del hook.
/// Esa varianza no era el cómputo sino la CONTENCIÓN: varias inferencias de
/// ONNX a la vez, cada una con 32 hilos intra-op, sobresuscribiendo la CPU. El
/// tope convertía la contención en degradación — medido 2026-09-27 con 3
/// sesiones simultáneas: 40 re-ranks abandonados en 30 prompts ("timeout tras
/// 3500ms" o "ya en curso"). Con el turno FIFO (qdrant_inference_gate.rs) el
/// forward pass corre solo y a velocidad plena (2-3 s con 24 pares), así que
/// la espera por contención ya no cuenta aquí y este techo queda solo para un
/// cuelgue real: 10 veces el cómputo normal.
#[cfg(feature = "qdrant")]
const RERANK_HANG_TIMEOUT: Duration = Duration::from_secs(30);

/// `rerank_pairs` para el daemon: ESPERA su turno de inferencia sin tope (la
/// contención ya no degrada el pack) y acota solo el cómputo a
/// `RERANK_HANG_TIMEOUT`. Si ese techo vence es un cuelgue: el hilo sigue
/// calculando (un forward pass de ONNX no se interrumpe a medias) pero
/// CONSERVA el turno hasta acabar, así que ningún huérfano compite por CPU con
/// la inferencia siguiente — ese era el papel del antiguo guard "uno en vuelo",
/// que en vez de encolar descartaba el re-rank de quien llegaba segundo.
#[cfg(feature = "qdrant")]
pub fn rerank_pairs_bounded(
    query: &str,
    docs: &[(String, String)],
) -> Result<Vec<(String, f32)>, String> {
    if docs.is_empty() {
        return Ok(Vec::new());
    }
    let turno = super::inference_turn();
    let query = query.to_string();
    let docs = docs.to_vec();
    computo_acotado(turno, RERANK_HANG_TIMEOUT, move || {
        rerank_pairs_en_turno(&query, &docs)
    })
}

/// Ejecuta `computo` en un hilo que se lleva `turno` y espera su resultado
/// como mucho `techo`. Separado de `rerank_pairs_bounded` para probar el
/// mecanismo sin cargar el modelo real.
#[cfg(feature = "qdrant")]
fn computo_acotado<T, F>(
    turno: super::qdrant_inference_gate::InferenceTurn,
    techo: Duration,
    computo: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // El turno se suelta al acabar el cómputo (también por pánico, al
        // desenrollar), nunca al vencer el techo del llamante.
        let _turno = turno;
        // Si el llamante ya se rindió, `send` falla y se ignora.
        let _ = tx.send(computo());
    });
    rx.recv_timeout(techo).unwrap_or_else(|_| {
        Err(format!(
            "rerank colgado: sin resultado tras {} s de cómputo — pack servido con el orden fusionado",
            techo.as_secs()
        ))
    })
}

/// Stub sin la feature: mismo contrato que `rerank_pairs` (siempre `Err`).
#[cfg(not(feature = "qdrant"))]
pub fn rerank_pairs_bounded(
    _query: &str,
    _docs: &[(String, String)],
) -> Result<Vec<(String, f32)>, String> {
    Err("rerank_pairs_bounded: qdrant feature not enabled".to_string())
}

#[cfg(all(test, feature = "qdrant"))]
mod bounded_tests {
    use super::*;
    use std::time::Instant;

    /// Los tests que toman el turno GLOBAL se serializan entre sí: el runner
    /// de cargo los lanza en paralelo y uno retendría el turno del otro.
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Caso negativo: un cómputo colgado no retiene al llamante más allá del
    /// techo — vuelve con `Err` y el pack sale con el orden fusionado.
    #[test]
    fn un_computo_colgado_vuelve_al_vencer_el_techo() {
        let _s = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let turno = super::super::inference_turn();
        let t0 = Instant::now();
        let r: Result<(), String> = computo_acotado(turno, Duration::from_millis(100), || {
            std::thread::sleep(Duration::from_millis(400));
            Ok(())
        });
        assert!(r.is_err(), "debe vencer el techo");
        assert!(t0.elapsed() < Duration::from_millis(350));
        // El huérfano CONSERVA el turno: el siguiente espera a que acabe en vez
        // de competir con él por la CPU.
        let t1 = Instant::now();
        let _siguiente = super::super::inference_turn();
        assert!(
            t1.elapsed() >= Duration::from_millis(150),
            "el turno sigue tomado por el cómputo huérfano"
        );
    }

    /// Lo que cambia el 2026-09-27: con el turno ocupado, la llamada nueva
    /// ESPERA y devuelve el resultado completo — ni "ya en curso" ni timeout.
    #[test]
    fn con_el_turno_ocupado_se_espera_y_no_se_degrada() {
        let _s = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let ocupado = super::super::inference_turn();
        let liberador = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(ocupado);
        });
        let t0 = Instant::now();
        let turno = super::super::inference_turn();
        let r = computo_acotado(turno, Duration::from_secs(5), || Ok(42));
        liberador.join().unwrap();
        assert_eq!(
            r,
            Ok(42),
            "tras esperar su turno, el cómputo se sirve entero"
        );
        assert!(t0.elapsed() >= Duration::from_millis(250), "esperó la cola");
    }

    /// Un pánico en el cómputo no deja el turno tomado para siempre.
    #[test]
    fn un_panico_en_el_computo_devuelve_el_turno() {
        let _s = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let turno = super::super::inference_turn();
        let r: Result<(), String> = computo_acotado(turno, Duration::from_secs(2), || {
            panic!("forward pass simulado que revienta")
        });
        assert!(r.is_err());
        let t0 = Instant::now();
        let _t = super::super::inference_turn();
        assert!(t0.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn sin_documentos_no_toma_turno_ni_modelo() {
        let _s = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _ocupado = super::super::inference_turn();
        // Con el turno tomado por este mismo hilo, pedir otro colgaría el
        // test: la vía rápida tiene que salir antes de pedirlo.
        assert_eq!(rerank_pairs_bounded("q", &[]), Ok(Vec::new()));
        assert_eq!(rerank_pairs("q", &[]), Ok(Vec::new()));
    }
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
