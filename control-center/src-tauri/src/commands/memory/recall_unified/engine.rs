// recall_unified/engine.rs — assemble_pack, build_trace, recall_pack.
//
// `assemble_pack`: pure governance filter over a pre-ranked candidate list.
// `build_trace`: full recall pipeline (FTS5/bm25 + RRF scoring + quality
//    re-ranker + governance gates), returns the Retrieval Inspector trace. Each
//    call gets the full per-call token cap — no cumulative per-session budget.
// `recall_pack`: thin wrapper over `build_trace` that returns the compact pack.
//
// La ruta densa (k-NN E5 sobre un índice vectorial y cross-encoder) se retiró
// el 2026-11-14; llevaba apagada desde el 2026-09-28 y el comportamiento del
// recall es el que tenía entonces el camino solo-FTS5.

use crate::memory::sqlite_store as store;
use crate::memory::{MemoryType, Scope};

use super::pack::assemble_pack;
use super::types_model::{RecallPack, RecallTrace, PER_CALL_TOKEN_CAP};
use super::usage::RecallUse;

/// Core recall + full trace (Retrieval Inspector). Synchronous; both the
/// compact `recall` and the verbose trace (sidecar `trace`) derive from this so there is
/// ONE retrieval path. Global-scope items bypass the project filter (they apply
/// everywhere). Emits a `Retrieved` audit event and touches the injected items
/// (only real recalls; diagnostic ones go through `super::usage`).
///
/// CROSS-PROJECT: when `cross_project` is true the project-equality gate in
/// `assemble_pack` is relaxed, so the recall searches the WHOLE brain across
/// projects. Security is untouched: Secret items are still excluded downstream.
///
/// PER-CALL TOKEN CAP: every recall receives the full `PER_CALL_TOKEN_CAP` —
/// there is NO cumulative per-session budget, so the memory is never silenced
/// mid-session (the old accumulator starved every query after the first few).
pub fn build_trace(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
) -> Result<RecallTrace, String> {
    build_trace_typed(query, limit, project_id, cross_project, None)
}

/// [`build_trace`] restringido a UN tipo de memoria (`only_type`): el FTS
/// busca solo entre items de ese tipo, y el resto del pipeline (puntuación
/// RRF, multiplicador de calidad, relevance floor, trust gate,
/// `assemble_pack`) es idéntico. F1.3 (2026-09-03): la pasada de lecciones
/// cross-project busca solo entre `lesson`.
pub fn build_trace_typed(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    only_type: Option<MemoryType>,
) -> Result<RecallTrace, String> {
    build_trace_with(
        query,
        limit,
        project_id,
        cross_project,
        only_type,
        RecallUse::Live,
    )
}

/// Pipeline común de [`build_trace_typed`] y de los recalls de diagnóstico
/// (`super::usage`). `usage` decide si el recall deja telemetría de uso en
/// `brain.db` (evento Retrieved + `touch_injected`): solo los recalls reales.
pub(super) fn build_trace_with(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    only_type: Option<MemoryType>,
    usage: RecallUse,
) -> Result<RecallTrace, String> {
    // (1)-(2) sparse + puntuación RRF (ver `stages`).
    let mut candidates = stages::retrieve_and_score(query, only_type)?;
    // Single connection reuse: the same `conn` feeds the quality re-ranker and
    // assemble_pack, avoiding a second open_conn.
    let conn = store::open_conn().map_err(|e| format!("open brain.db: {e}"))?;
    stages::apply_quality_factors(&conn, &mut candidates.fused, project_id, cross_project);

    // (3)+(4) load items + apply governance + the per-call token cap via the
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
    gates.abstain_on_unknown_terms(query);
    stages::context_warnings(&mut gates.warnings, project_id, cross_project);
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

/// (cat1 ranking, 2026-07-02) Knobs de retrieval por env para el A/B honesto:
/// `ULTRON_FANOUT_K` (candidatos FTS por recall antes de multiplicar por el
/// ensanche, default 30) y `ULTRON_RRF_K` (damping de la puntuación RRF,
/// default 60). Fail-safe: ausente o basura -> default compilado.
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
/// Con cross_project (cerebro entero pedido explicitamente) sigue visible.
/// Pure -> unit-tested.
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

/// Sync compact recall pack — reused by the CLI sidecar (`ultron-memory recall`).
/// `cross_project` relaxes ONLY the project filter (whole-brain recall); Secret
/// items are still excluded. Every call gets the full `PER_CALL_TOKEN_CAP`;
/// there is no cumulative per-session budget.
pub fn recall_pack(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
) -> Result<RecallPack, String> {
    let t = build_trace(query, limit, project_id, cross_project)?;
    Ok(pack_from_trace(t))
}

/// Pack compacto de una traza (lo comparten `recall_pack` y su variante de
/// diagnóstico).
pub(super) fn pack_from_trace(t: RecallTrace) -> RecallPack {
    RecallPack {
        sparse_hits: t.sparse_ids.len(),
        total_tokens: t.total_tokens,
        abstained: t.warnings.iter().any(|w| w.starts_with("recall abstained")),
        entries: t.injected,
    }
}

// Tests de los knobs — extraidos a fichero hermano (limite 800 lineas, cat7.3);
// mismo patron #[path] que rules.rs/rules_tests.rs.
#[cfg(test)]
#[path = "engine_tests.rs"]
mod knob_tests;
