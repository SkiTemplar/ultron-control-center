// recall_unified/engine.rs — assemble_pack, build_trace, recall_pack.
//
// `assemble_pack`: pure governance filter over a pre-fused candidate list.
//    Unit-testable without Qdrant/E5.
// `build_trace`: full hybrid recall pipeline (dense + sparse + RRF + quality
//    re-ranker), returns the Retrieval Inspector trace. Each call gets the full
//    per-call token cap — no cumulative per-session budget.
// `recall_pack`: thin wrapper over `build_trace` that returns the compact pack.

use crate::memory::sqlite_store as store;
use crate::memory::{MemoryType, Scope};

use super::pack::assemble_pack;
use super::types_model::{RecallEntry, RecallPack, RecallTrace, PER_CALL_TOKEN_CAP};
use super::usage::RecallUse;

/// Core hybrid recall + full trace (Retrieval Inspector). Synchronous; both the
/// compact `recall` and the verbose trace (sidecar `trace`) derive from this so there is
/// ONE retrieval path. Global-scope items bypass the project filter (they apply
/// everywhere). Emits a `Retrieved` audit event and touches the injected items
/// (only real recalls; diagnostic ones go through `super::usage`).
///
/// CROSS-PROJECT: when `cross_project` is true the dense (Qdrant) k-NN is run
/// WITHOUT the `project_id` payload filter and the project-equality gate in
/// `assemble_pack` is relaxed, so the recall searches the WHOLE brain across
/// projects. Security is untouched: Secret items are still excluded downstream.
///
/// PER-CALL TOKEN CAP: every recall receives the full `PER_CALL_TOKEN_CAP` —
/// there is NO cumulative per-session budget, so the memory is never silenced
/// mid-session (the old accumulator starved every query after the first few).
///
/// RERANK (cat1 2026-07-03, split MEDIDO): `rerank=true` re-ordena el top-N
/// fusionado con el cross-encoder BGE-v2-m3 (recall@8 0.682→0.709, p@3
/// 0.379→0.483 contra el oráculo golden) a un coste de ~2-2.4 s por llamada en
/// CPU (24 pares, 568M params). Los callers de CALIDAD (recall CLI/browser,
/// trace, evals) pasan `true`.
///
/// El hot path del hook NO es ya un `false` fijo (lo era hasta el rerank
/// selectivo de 2026-08-13): `orchestrate` pasa `true` en los prompts técnicos
/// —donde la memoria decide— y `false` en la charla. Desde 2026-08-16 añade una
/// condición más: solo `true` si el cross-encoder YA está residente, porque
/// cargarlo cuesta 8762 ms medidos contra un presupuesto de hook de 6000 y el
/// turno se quedaba sin memoria en vez de con memoria peor. `ULTRON_RERANK_HOT=1`
/// fuerza el intento en todos los prompts; `ULTRON_RERANK=0` lo apaga
/// GLOBALMENTE (restaura el baseline byte-a-byte, verificado e2e).
pub fn build_trace(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    dense_enabled: bool,
    rerank: bool,
) -> Result<RecallTrace, String> {
    build_trace_typed(
        query,
        limit,
        project_id,
        cross_project,
        dense_enabled,
        rerank,
        None,
    )
}

/// [`build_trace`] restringido a UN tipo de memoria (`only_type`): el k-NN
/// denso y el FTS buscan solo entre items de ese tipo, y el resto del pipeline
/// (fusión RRF, multiplicador de calidad, floor, poda por margen, trust gate,
/// `assemble_pack`) es idéntico. F1.3 (2026-09-03): la pasada de lecciones
/// cross-project busca solo entre `lesson`; con el recall general sin reranker
/// la lección relevante (dense 0.888) caía al rango 15 y nunca se inyectaba.
pub fn build_trace_typed(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    dense_enabled: bool,
    rerank: bool,
    only_type: Option<MemoryType>,
) -> Result<RecallTrace, String> {
    build_trace_with(
        query,
        limit,
        project_id,
        cross_project,
        dense_enabled,
        rerank,
        only_type,
        RecallUse::Live,
    )
}

/// Pipeline común de [`build_trace_typed`] y de los recalls de diagnóstico
/// (`super::usage`). `usage` decide si el recall deja telemetría de uso en
/// `brain.db` (evento Retrieved + `touch_injected`): solo los recalls reales.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_trace_with(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    dense_enabled: bool,
    rerank: bool,
    only_type: Option<MemoryType>,
    usage: RecallUse,
) -> Result<RecallTrace, String> {
    // (1)-(3) denso + sparse + fusión RRF ponderada (ver `stages`).
    let mut candidates = stages::retrieve_and_fuse(
        query,
        project_id,
        cross_project,
        dense_enabled,
        rerank,
        only_type,
    )?;
    // Single connection reuse: the same `conn` feeds the quality re-ranker,
    // the cross-encoder pairs and assemble_pack, avoiding a second open_conn.
    let conn = store::open_conn().map_err(|e| format!("open brain.db: {e}"))?;
    stages::apply_quality_factors(&conn, &mut candidates.fused, project_id, cross_project);
    stages::cross_encoder_rerank(&conn, query, rerank, &mut candidates.fused);

    // (4)+(5) load items + apply governance + the per-call token cap via the
    // pure assemble_pack. Every recall receives the FULL per-call cap — there is
    // NO cumulative per-session budget, so the memory is never silenced
    // mid-session. The item-count `limit` is the primary bloat ceiling.
    let (injected, discarded, total_tokens) = assemble_pack(
        &conn,
        &candidates.fused,
        limit,
        project_id,
        cross_project,
        PER_CALL_TOKEN_CAP,
    );
    let mut gates = stages::PackGates {
        injected,
        discarded,
        total_tokens,
        warnings: Vec::new(),
    };
    gates.abstain_without_signal();
    gates.prune_by_margin();
    gates.abstain_on_unknown_terms(query);
    stages::context_warnings(
        &mut gates.warnings,
        project_id,
        cross_project,
        dense_enabled,
        candidates.dense_ids.len(),
    );
    let lazy_load_ids: Vec<String> = gates
        .injected
        .iter()
        .map(|e| e.canonical_id.clone())
        .collect();
    if let Some(w) =
        stages::record_retrieved(&conn, usage, query, &candidates, &gates, &lazy_load_ids)
    {
        gates.warnings.push(w);
    }

    Ok(RecallTrace {
        query: query.to_string(),
        project_filter: project_id.map(str::to_string),
        token_budget: PER_CALL_TOKEN_CAP,
        dense_ids: candidates.dense_ids,
        sparse_ids: candidates.sparse_ids,
        fused: candidates.fused,
        injected: gates.injected,
        discarded: gates.discarded,
        total_tokens: gates.total_tokens,
        lazy_load_ids,
        warnings: gates.warnings,
    })
}

/// Etapas del pipeline de [`build_trace_with`] (calidad-rust-4, 2026-10-23).
#[path = "engine_stages.rs"]
mod stages;

/// Floor por defecto del gate de abstención (E5 cosine). Barrido empírico
/// 2026-07-02 sobre golden eval-full + memory-bench abstain:
///   off   -> recall@8 0.637 · abstain 0/3
///   0.83  -> recall@8 0.610 · abstain 3/3   <- elegido entonces
///   0.84  -> recall@8 0.588 · abstain 3/3
///
/// (2026-08-16) Bajado a 0.81 tras re-medirlo sobre TRAFICO REAL en vez de solo
/// sobre conjuntos escritos a mano: 0.83 silenciaba el 24,2% de los prompts del
/// usuario y 0.81 baja al 15,8% sin perder una sola casilla del memory-bench.
/// La tabla completa y la fragilidad del umbral están documentadas en
/// `recall_floor()`. Tuneable por ULTRON_RECALL_FLOOR (incluido `off`).
const DEFAULT_RECALL_FLOOR: f32 = 0.81;

/// Rank FTS máximo que cuenta como "sparse FUERTE" (match léxico exacto, p.ej.
/// un identificador). Los matches de stopwords caen a ranks profundos (probe
/// "paella": ranks 11-13), así que no compran confianza.
///
/// (2026-08-16, decidido por el usuario) Subido de 2 a 5. Con 2, la query
/// `qdrant` —un término que aparece literalmente por todo el corpus— devolvía
/// CERO memorias: sus mejores candidatos maxean dense 0.8240 contra un floor de
/// 0.83, y el ítem que BM25 colocaba TERCERO de todo el corpus no llegaba a
/// contar como señal porque el corte estaba en el segundo. El gate se quedaba
/// sin ninguna prueba que aceptar y vaciaba el pack entero. Medido en el
/// oráculo golden: era la única query con pack vacío de las 29.
///
/// 5 sigue muy por encima de los ranks 11-13 donde caen los matches de
/// stopwords que motivaron el corte original, así que la query sin anclaje
/// léxico real se sigue absteniendo.
const STRONG_SPARSE_RANK: usize = 5;

/// (cat1 ranking, 2026-07-02) Knobs de retrieval por env para el A/B honesto:
/// `ULTRON_FANOUT_K` (candidatos por fuente antes de fusionar, default 30) y
/// `ULTRON_RRF_K` (damping de la fusión, default 60). Fail-safe: ausente o
/// basura -> default compilado. Mismo patrón que ULTRON_RECALL_FLOOR.
fn env_knob_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

fn env_knob_f32(name: &str, default: f32) -> f32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

/// (2026-07-13) Factor de ranking para items AMBIENTE (project_id=NULL) bajo un
/// filtro de proyecto activo. Complementa la regla ambiente del pack (que los
/// mantiene VISIBLES): aquí solo se hunden en el orden para que las memorias del
/// proyecto activo ganen cuando compiten. Devuelve `penalty` únicamente cuando:
/// hay proyecto en la query, NO es cross_project (cerebro entero pedido
/// explícitamente), el item no tiene proyecto y su scope no es Global (las
/// memorias Global son deliberadamente universales). En cualquier otro caso 1.0.
/// (2026-08-11, decidido por el usuario — atribucion fase 2) Un item con
/// scope=Project pero SIN project_id es una atribucion ILEGAL (la fabricaba un
/// bug del write-path: capture decidia el scope con el project pero nunca lo
/// estampaba). Bajo un filtro de proyecto activo se EXCLUYE del pack — no hay
/// forma de saber de quien es y se colaba como comodin en cualquier proyecto.
/// Activado tras `backfill-projects --apply` (residuo: 639 items ambiente que
/// ni provenance ni dense-vote pudieron atribuir). Con cross_project (cerebro
/// entero pedido explicitamente) sigue visible. Pure -> unit-tested.
pub(crate) fn is_orphan_project_item(
    query_project: Option<&str>,
    cross_project: bool,
    item_project: Option<&str>,
    item_scope: Scope,
) -> bool {
    query_project.is_some()
        && !cross_project
        && item_project.is_none()
        && item_scope == Scope::Project
}

pub(crate) fn ambient_rank_factor(
    query_project: Option<&str>,
    cross_project: bool,
    item_project: Option<&str>,
    item_scope: Scope,
    penalty: f32,
) -> f32 {
    if query_project.is_some()
        && !cross_project
        && item_project.is_none()
        && item_scope != Scope::Global
    {
        penalty
    } else {
        1.0
    }
}

/// Lee `ULTRON_RECALL_FLOOR`: ausente -> default; "off"/"0" -> gate desactivado;
/// número -> override; basura -> default (fail-safe: nunca desactiva en silencio).
/// (margen 2026-08-13) Cuántas entradas se conservan SIEMPRE en cabeza, pase lo
/// que pase con la poda: 2 = la mejor y su respaldo. Con 1 un pack legítimo de
/// dos hechos complementarios perdería la mitad por un margen apretado.
const PRUNE_KEEP_MIN: usize = 2;

/// Margen (en dense cosine) por debajo del MEJOR del pack a partir del cual una
/// entrada se poda. Default = None: **VEREDICTO NEGATIVO, MEDIDO** (golden 29
/// queries, sidecar fresco, 2026-08-13):
///
///   poda off   -> recall@8 0.8103 · p@8 0.2672 · waste 0.7328  <- se queda
///   margen 0.08 -> recall@8 0.7776 · p@8 0.2500 · waste 0.7500
///   margen 0.04 -> recall@8 0.7506 · p@8 0.2371 · waste 0.7629
///
/// La hipótesis era que la precisión baja (0.267) venía de cola inyectada por
/// el gate todo-o-nada, y que el dense separaba lo bueno de la cola. La medida
/// la REFUTA: cuanto más se poda, PEOR va todo — las memorias relevantes viven
/// repartidas por toda la banda 0.79-0.82, así que cortar por margen se lleva
/// señal, no ruido. (El p@8 del eval divide por k fijo, así que podar nunca
/// puede subirlo; el dato decisivo es el recall cayendo 6 puntos.) El código
/// se conserva OFF y tuneable por ULTRON_PRUNE_MARGIN para futuros A/B con
/// otra señal (p.ej. score del cross-encoder en vez del dense crudo), no para
/// encenderlo a ciegas. Mismo patrón que el A/B del reranker y Contextual
/// Retrieval: experimento medido, negativo, declarado.
const DEFAULT_PRUNE_MARGIN: f32 = 0.04;

fn prune_margin() -> Option<f32> {
    match std::env::var("ULTRON_PRUNE_MARGIN") {
        Ok(v) if v.eq_ignore_ascii_case("off") || v.trim() == "0" => None,
        Ok(v) => Some(v.trim().parse::<f32>().unwrap_or(DEFAULT_PRUNE_MARGIN)),
        // Sin env var: OFF por veredicto medido (ver tabla arriba).
        Err(_) => None,
    }
}

/// Floor de confianza. Bajado de 0.83 a 0.81 el 2026-08-16 (decidido por el
/// usuario). `ULTRON_RECALL_FLOOR=off` lo desactiva sin recompilar.
///
/// El 0.83 venía de un barrido de julio contra el golden. Medido ahora sobre el
/// TRAFICO REAL —120 prompts del log, re-ejecutados contra el binario del día—
/// resultó estar cobrando mucho más de lo que se creía:
///
///   floor   silencio real   memorias/turno   memory-bench   abstain
///   0.83    29/120 (24,2%)      6,07            9,47         9,17
///   0.81    19/120 (15,8%)      6,66            9,47         9,17   <- elegido
///   off      8/120 ( 6,7%)      7,24            9,35         8,33
///
/// 0.81 es el único punto que no sacrifica nada medible: recupera 10 prompts de
/// trabajo que 0.83 silenciaba y conserva el bench entero. Separa los dos casos
/// límite reales — `paella` (dense máx 0.8049, off-topic: debe callarse) por
/// debajo, `qdrant` (0.8240, la palabra más central del proyecto) por encima.
///
/// Retirarlo del todo recuperaría el triple de prompts, pero entonces las
/// preguntas off-topic reciben 8 memorias irrelevantes en vez de abstenerse
/// (bench 9.35, abstain 8.33): el floor SI compra abstención, al contrario de lo
/// que parecía en una medición anterior que resultó estar mal hecha — la env var
/// no llega al daemon, que es quien resuelve el recall, así que aquellas
/// corridas "sin floor" en realidad lo llevaban puesto. Para un A/B honesto de
/// este knob hay que relanzar el daemon con la variable, o pararlo.
///
/// FRAGILIDAD DECLARADA: los dense reales se apiñan en 0.79-0.82, así que 0.81
/// corta por el medio de la masa. Un cambio de corpus puede moverlo; conviene
/// re-medirlo con `scripts/traffic-recall-audit.mjs --replay` de vez en cuando.
///
/// El near-miss "AWS" que motivó el gate en julio maxea dense 0.8503 y nunca lo
/// frenó este floor: lo frena el trust gate de términos, que va aparte.
fn recall_floor() -> Option<f32> {
    match std::env::var("ULTRON_RECALL_FLOOR") {
        Ok(v) if v.eq_ignore_ascii_case("off") || v.trim() == "0" => None,
        Ok(v) => Some(v.trim().parse::<f32>().unwrap_or(DEFAULT_RECALL_FLOOR)),
        Err(_) => Some(DEFAULT_RECALL_FLOOR),
    }
}

/// (floor) ¿Alguna entrada del pack trae señal de confianza real? Sin ella el
/// recall debe abstenerse en vez de inyectar relleno (memory-bench, categoría
/// abstain). dense = E5 cosine crudo; sparse fuerte = rank FTS <= STRONG_SPARSE_RANK.
pub fn pack_has_confident_signal(entries: &[RecallEntry], floor: f32) -> bool {
    entries.iter().any(|e| {
        e.dense_score.is_some_and(|s| s >= floor)
            || e.sparse_rank.is_some_and(|r| r <= STRONG_SPARSE_RANK)
    })
}

/// Sync compact recall pack — reused by the CLI sidecar (`ultron-memory recall`).
/// `cross_project` relaxes ONLY the project filter (whole-brain recall); Secret
/// items are still excluded. Every call gets the full `PER_CALL_TOKEN_CAP`;
/// there is no cumulative per-session budget.
pub fn recall_pack(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    rerank: bool,
) -> Result<RecallPack, String> {
    // Manual recall path (UI inspection) keeps full hybrid quality (dense on).
    let t = build_trace(query, limit, project_id, cross_project, true, rerank)?;
    Ok(pack_from_trace(t))
}

/// Pack compacto de una traza (lo comparten `recall_pack` y su variante de
/// diagnóstico).
pub(super) fn pack_from_trace(t: RecallTrace) -> RecallPack {
    RecallPack {
        dense_hits: t.dense_ids.len(),
        sparse_hits: t.sparse_ids.len(),
        total_tokens: t.total_tokens,
        abstained: t.warnings.iter().any(|w| w.starts_with("recall abstained")),
        entries: t.injected,
    }
}

// Tests del floor y los knobs — extraidos a fichero hermano (limite 800 lineas,
// cat7.3); mismo patron #[path] que rules.rs/rules_tests.rs.
#[cfg(test)]
#[path = "engine_tests.rs"]
mod floor_tests;
