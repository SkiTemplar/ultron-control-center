// memory/evals.rs — recall quality harness / golden queries (MEMORY KERNEL)
//
// A reproducible, FAIL-SAFE way to measure recall@k against a fixed set of
// "golden" queries with expected substrings. The harness drives the unified
// hybrid recall pipeline (`recall_pack`) and reports, per query, whether ANY
// recovered summary contains ANY of the expected substrings (case-insensitive).
//
// Design notes:
//   - PURE arithmetic (`EvalReport::from_results`, `score_query`) is isolated
//     from the I/O side (`run`) so the math stays UNIT-TESTABLE without Qdrant,
//     E5, the network, or API keys.
//   - Degradation is total: if `recall_pack` errors (Qdrant/E5 offline, brain.db
//     locked, ...), that query simply scores `hits=0, matched=false`. No panic,
//     no propagation — a degraded eval is better than a crashed one.
//   - `default_goldens()` embeds realistic queries for THIS system (memory /
//     qdrant / recall / decisions / embeddings / orchestrator / sparse) so the
//     harness ships with a baseline even on a fresh checkout.

use crate::commands::memory::recall_unified::recall_pack;

/// A single golden query: a search string plus the substrings that SHOULD show
/// up in at least one recovered summary. `expect_any_of` is OR-matched and
/// case-insensitive, so generic, plausible terms are enough to be robust to
/// summary wording drift.
#[derive(Debug, Clone)]
pub struct GoldenQuery {
    /// The query string fed to recall.
    pub query: String,
    /// Substrings; a hit on ANY one (case-insensitive) marks the query matched.
    pub expect_any_of: Vec<String>,
    /// Coarse bucket: "single-term" | "multi-term" | "decision" | "cross-topic".
    pub category: String,
}

impl GoldenQuery {
    /// Convenience constructor that owns its strings.
    fn new(query: &str, expect_any_of: &[&str], category: &str) -> Self {
        Self {
            query: query.to_string(),
            expect_any_of: expect_any_of.iter().map(|s| s.to_string()).collect(),
            category: category.to_string(),
        }
    }
}

/// The outcome of evaluating one golden query.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EvalResult {
    /// The query that was run.
    pub query: String,
    /// The category of the originating golden query.
    pub category: String,
    /// How many entries recall returned (0 on degradation/empty).
    pub hits: usize,
    /// Whether ANY recovered summary contained ANY expected substring.
    pub matched: bool,
}

/// Aggregate report over a full golden-query run.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EvalReport {
    /// Number of golden queries evaluated.
    pub total: usize,
    /// Number of queries that matched at least one expected substring.
    pub matched: usize,
    /// `matched / total` in `[0.0, 1.0]`; `0.0` when `total == 0`.
    pub recall_at_k: f32,
    /// Per-query breakdown, preserving input order.
    pub per_query: Vec<EvalResult>,
    /// SECURITY GATE: count of returned items that are `Secret` (must be 0 —
    /// recall must never surface secrets). Non-zero = governance regression.
    pub secret_leak_count: usize,
    /// SECURITY GATE: count of returned items whose status is not `Active`
    /// (deprecated/rejected/stale leaking into recall). Must be 0.
    pub stale_leak_count: usize,
    /// Offending ids (secret or non-active) for diagnosis. Empty on a clean run.
    pub leaked_ids: Vec<String>,
}

impl EvalReport {
    /// Build the aggregate report from per-query results. PURE: no I/O, no
    /// recall — this is the unit-testable arithmetic core. Division-by-zero is
    /// guarded (empty input yields `recall_at_k = 0.0`).
    #[must_use]
    pub fn from_results(per_query: Vec<EvalResult>) -> Self {
        let total = per_query.len();
        let matched = per_query.iter().filter(|r| r.matched).count();
        let recall_at_k = if total == 0 {
            0.0
        } else {
            matched as f32 / total as f32
        };
        Self {
            total,
            matched,
            recall_at_k,
            per_query,
            secret_leak_count: 0,
            stale_leak_count: 0,
            leaked_ids: Vec::new(),
        }
    }
}

/// Pure leak classifier for the security gate: given `(id, sensitivity, status)`
/// of the items recall returned, count `Secret` items (secret leak) and
/// non-`Active` items (stale/governance leak), collecting the offending ids.
/// Recall MUST never surface either; a non-zero count is a regression. PURE.
fn classify_leaks(
    rows: &[(String, super::model::Sensitivity, super::model::Status)],
) -> (usize, usize, Vec<String>) {
    use super::model::{Sensitivity, Status};
    let mut secret = 0usize;
    let mut stale = 0usize;
    let mut leaked: Vec<String> = Vec::new();
    for (id, sens, status) in rows {
        let is_secret = *sens == Sensitivity::Secret;
        let is_stale = *status != Status::Active;
        if is_secret {
            secret += 1;
        }
        if is_stale {
            stale += 1;
        }
        if is_secret || is_stale {
            leaked.push(id.clone());
        }
    }
    leaked.sort();
    leaked.dedup();
    (secret, stale, leaked)
}

/// Case-insensitive OR-match: does ANY summary contain ANY expected substring?
/// PURE helper, isolated from recall so the matching logic is unit-testable.
#[must_use]
fn summaries_match(summaries: &[String], expect_any_of: &[String]) -> bool {
    if expect_any_of.is_empty() {
        return false;
    }
    let needles: Vec<String> = expect_any_of.iter().map(|s| s.to_lowercase()).collect();
    summaries.iter().any(|s| {
        let hay = s.to_lowercase();
        needles.iter().any(|n| hay.contains(n.as_str()))
    })
}

/// The embedded baseline golden set: realistic queries for the ULTRON memory
/// subsystem, categorized. `expect_any_of` uses generic, plausible substrings
/// so the set is resilient to summary wording.
#[must_use]
pub fn default_goldens() -> Vec<GoldenQuery> {
    vec![
        GoldenQuery::new("qdrant", &["qdrant", "vector", "embedding"], "single-term"),
        GoldenQuery::new("memoria", &["memoria", "memory", "kernel"], "single-term"),
        GoldenQuery::new(
            "embeddings E5 dense",
            &["embedding", "e5", "dense", "vector"],
            "multi-term",
        ),
        GoldenQuery::new(
            "recall hibrido RRF",
            &["recall", "rrf", "hybrid", "hibrido", "fusion"],
            "multi-term",
        ),
        GoldenQuery::new(
            "busqueda sparse FTS5",
            &["sparse", "fts5", "bm25", "busqueda"],
            "multi-term",
        ),
        GoldenQuery::new(
            "decision sobre el modelo de embeddings",
            &["decision", "bge-m3", "embedding", "modelo"],
            "decision",
        ),
        GoldenQuery::new(
            "decision arquitectura orquestador",
            &["decision", "orquestador", "orchestrator", "arquitectura"],
            "decision",
        ),
        GoldenQuery::new(
            "orquestador Ultron auto-routing",
            &["orquestador", "orchestrator", "ultron", "routing"],
            "single-term",
        ),
        GoldenQuery::new(
            "hooks de sesion SessionStart",
            &["hook", "session", "sessionstart"],
            "multi-term",
        ),
        GoldenQuery::new(
            "candidato de memoria pendiente de validacion",
            &["candidate", "candidato", "pending", "pendiente", "inbox"],
            "multi-term",
        ),
        GoldenQuery::new(
            "qdrant embeddings recall decision",
            &["qdrant", "embedding", "recall", "decision"],
            "cross-topic",
        ),
        GoldenQuery::new(
            "memoria sparse orquestador",
            &["memoria", "sparse", "orquestador", "memory"],
            "cross-topic",
        ),
    ]
}

/// Evaluate ONE golden query against the live recall pipeline. FAIL-SAFE: a
/// `recall_pack` error degrades to `hits=0, matched=false` (no panic). This is
/// the I/O boundary; everything it consumes (`summaries_match`) is pure.
fn score_query(
    golden: &GoldenQuery,
    project_id: Option<&str>,
    k: usize,
) -> (EvalResult, Vec<String>) {
    // Each golden query is an INDEPENDENT recall. There is no longer a
    // cumulative per-session token budget to reset — every recall receives the
    // full per-call cap, so later queries in the same process are never starved.
    // rerank=false: este es el smoke del doctor (fontaneria, no calidad) — con
    // el cross-encoder el doctor pasa de ~10s a minutos y revienta timeouts.
    let (hits, matched, ids) = match recall_pack(&golden.query, k, project_id, false, false) {
        Ok(pack) => {
            let summaries: Vec<String> = pack
                .entries
                .iter()
                .filter_map(|e| e.summary.clone())
                .collect();
            let matched = summaries_match(&summaries, &golden.expect_any_of);
            let ids: Vec<String> = pack
                .entries
                .iter()
                .map(|e| e.canonical_id.clone())
                .collect();
            (pack.entries.len(), matched, ids)
        }
        Err(e) => {
            // Degrade quietly; a failing source must not abort the eval run.
            eprintln!("[evals] recall_pack failed for '{}': {e}", golden.query);
            (0, false, Vec::new())
        }
    };
    (
        EvalResult {
            query: golden.query.clone(),
            category: golden.category.clone(),
            hits,
            matched,
        },
        ids,
    )
}

/// Run the full embedded golden set against the live recall pipeline and return
/// the aggregate report. `project_id = None` runs unfiltered (global) recall;
/// `k` is the recall depth per query. FAIL-SAFE end-to-end: individual query
/// failures degrade to non-matches rather than aborting the run.
#[must_use]
pub fn run(project_id: Option<&str>, k: usize) -> EvalReport {
    let goldens = default_goldens();
    let mut per_query: Vec<EvalResult> = Vec::with_capacity(goldens.len());
    let mut returned_ids: Vec<String> = Vec::new();
    for g in &goldens {
        let (result, ids) = score_query(g, project_id, k);
        returned_ids.extend(ids);
        per_query.push(result);
    }
    let mut report = EvalReport::from_results(per_query);

    // SECURITY GATE: look up every returned item in the SoT and assert recall
    // never surfaced a Secret or non-Active item. Read-only; degrades to "no
    // leaks measured" if brain.db is unavailable (recall would also have failed).
    returned_ids.sort();
    returned_ids.dedup();
    if let Ok(conn) = super::sqlite_store::open_conn() {
        let rows: Vec<(String, super::model::Sensitivity, super::model::Status)> = returned_ids
            .iter()
            .filter_map(|id| match super::sqlite_store::get_item(&conn, id) {
                Ok(Some(item)) => Some((item.id, item.sensitivity, item.status)),
                _ => None,
            })
            .collect();
        let (secret, stale, leaked) = classify_leaks(&rows);
        report.secret_leak_count = secret;
        report.stale_leak_count = stale;
        report.leaked_ids = leaked;
    }
    report
}

// ===========================================================================
// Golden-set metrics path (precision@k / recall@k / MRR / nDCG / context-waste)
//
// This is the I/O boundary that drives the PURE `eval_metrics` module against
// the REAL generated golden set (cockpit/memory-rework/evals/golden_set.json,
// ~942 positives each carrying `expect_ids`). It is ADDITIVE and FAIL-SAFE:
//   - it does NOT touch `run()` / `recall_at_k` / the security gate semantics
//     of the default `eval` subcommand;
//   - a missing golden_set.json, an unreadable file, or a dead Qdrant/E5
//     degrades to a well-formed `degraded = true` report (never a panic).
// ===========================================================================

/// Resolve the canonical path to the generated golden set. The file lives at
/// `~/.ultron/cockpit/memory-rework/evals/golden_set.json` (same `~/.ultron`
/// root used by `brain.db`). Returns `None` only if the HOME dir is unknown —
/// the caller treats that exactly like a missing file (degraded, no panic).
fn golden_set_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| {
        h.join(".ultron")
            .join("cockpit")
            .join("memory-rework")
            .join("evals")
            .join("golden_set.json")
    })
}

/// El set etiquetado a mano vive en el MISMO directorio que el generado.
fn golden_labels_path() -> Option<std::path::PathBuf> {
    golden_set_path().map(|p| p.with_file_name("golden_labels.json"))
}

/// (2026-08-10) Unión de `expect_ids` de AMBOS golden sets (generado +
/// etiquetado): items PROTEGIDOS frente a sweeps de higiene — deprecar un
/// golden positive rompe el oráculo (audit 08-09: parte del gap 0.662→0.823
/// eran positives huérfanos del dedupe). Walk genérico por clave: sobrevive a
/// las diferencias de schema entre ambos ficheros. Fail-safe: fichero ausente
/// o ilegible aporta el conjunto vacío (el sweep protege lo que puede ver).
pub fn golden_protected_ids() -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    for path in [golden_set_path(), golden_labels_path()]
        .into_iter()
        .flatten()
    {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        collect_expect_ids(&v, &mut out);
    }
    out
}

/// Recorre el JSON acumulando todo string dentro de arrays bajo `expect_ids`.
fn collect_expect_ids(v: &serde_json::Value, out: &mut std::collections::HashSet<String>) {
    match v {
        serde_json::Value::Object(m) => {
            for (k, val) in m {
                if k == "expect_ids" {
                    if let Some(arr) = val.as_array() {
                        for id in arr {
                            if let Some(s) = id.as_str() {
                                out.insert(s.to_string());
                            }
                        }
                    }
                }
                collect_expect_ids(val, out);
            }
        }
        serde_json::Value::Array(a) => {
            for x in a {
                collect_expect_ids(x, out);
            }
        }
        _ => {}
    }
}

/// (2026-08-10, patrón b1ea0e5) Informe READ-ONLY de víctimas de higiene en los
/// golden sets: `expect_ids` que ya NO están ACTIVE en brain.db. Para cada
/// víctima intenta resolver su gemelo activo por `content_hash` — directo del
/// item si la fila sigue existiendo (deprecated/stale), o recuperado del
/// `before_json` del ledger de events si el dedupe la borró (forget). NO muta
/// ni brain.db ni los JSON: emite el plan; el remap lo aplica una sesión con
/// el informe delante (remap mecánico, no relabel de opinión).
pub fn golden_remap_report() -> serde_json::Value {
    use super::model::{MemoryItem, Status};
    use super::sqlite_store as store;

    let ids = golden_protected_ids();
    let conn = match store::open_conn() {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "error": format!("brain.db no disponible: {e}") }),
    };

    let mut active = 0usize;
    let mut victims: Vec<serde_json::Value> = Vec::new();
    let mut sorted: Vec<&String> = ids.iter().collect();
    sorted.sort();

    for id in sorted {
        let (state, source_item): (String, Option<MemoryItem>) = match store::get_item(&conn, id) {
            Ok(Some(item)) if matches!(item.status, Status::Active) => {
                active += 1;
                continue;
            }
            Ok(Some(item)) => (item.status.as_str().to_string(), Some(item)),
            Ok(None) => {
                // Fila borrada (forget del dedupe): recupera el item del ledger.
                let recovered = store::list_events_for(&conn, id, 10).ok().and_then(|evs| {
                    evs.into_iter().find_map(|ev| {
                        ev.before_json
                            .as_deref()
                            .and_then(|b| serde_json::from_str::<MemoryItem>(b).ok())
                    })
                });
                ("missing".to_string(), recovered)
            }
            Err(e) => (format!("error: {e}"), None),
        };

        // Gemelo: ACTIVE con el mismo content_hash en la misma frontera
        // scope/proyecto (la del hash-dedupe, CONTRACTS §4).
        let twin = source_item.as_ref().and_then(|it| {
            it.content_hash.as_deref().and_then(|h| {
                store::find_active_by_content_hash(&conn, h, it.scope, it.project_id.as_deref())
                    .ok()
                    .flatten()
                    .map(|t| t.id)
            })
        });

        let action = if twin.is_some() { "remap" } else { "remove" };
        victims.push(serde_json::json!({
            "expect_id": id,
            "state": state,
            "twin_active": twin,
            "action": action,
        }));
    }

    serde_json::json!({
        "total_expect_ids": ids.len(),
        "active": active,
        "victims_count": victims.len(),
        "victims": victims,
        "note": "READ-ONLY (patrón b1ea0e5): remap = sustituir expect_id por twin_active; \
                 remove = retirar el id y recalcular n_relevant",
    })
}

// ---------------------------------------------------------------------------
// Submodulos (cat7.3: evals.rs superaba las 800 lineas -> troceado 2026-07-02)
// ---------------------------------------------------------------------------

mod golden;
mod labeled;
pub use golden::*;
pub use labeled::*;

#[cfg(test)]
mod tests;
