//! Subcomandos de recall, orquestación y evaluación del sidecar
//! (`orchestrate`, `trace`, `recall`, `hubs`, `eval`, `eval-full`).
//!
//! Separados de `run()` en main.rs (calidad-rust-4, 2026-10-23): el despachador
//! era un `match` de 500 líneas. Cada función es el brazo de antes, sin cambios
//! de comportamiento.

use control_center_lib as ul;
use serde_json::Value;

use crate::cli_args::{flag_value, has_flag, positional};
use crate::to_json;

/// `orchestrate <prompt> [--project X] [--sparse]`.
pub(crate) fn orchestrate(args: &[String], project: Option<&str>) -> Result<Value, String> {
    let prompt = positional(args)?;
    // `--sparse` (2026-09-07): respaldo del hook cuando el daemon YA no
    // ha contestado. Ni vuelve a esperarle (con el daemon vivo pero
    // lento, la espera de 30 s de abajo se comia entero el cap de 6 s
    // del hook y el "respaldo" nunca resolvia nada: asi entro sin
    // memoria el primer prompt del 2026-09-07) ni carga E5 (1,5 GB
    // compitiendo por CPU con el daemon que se esta recuperando):
    // FTS5 + reglas, en menos de un segundo.
    if has_flag(args, "--sparse") {
        return to_json(ul::orchestrator::orchestrate(&prompt, project, false));
    }
    // Si el daemon vive, que responda EL: tiene E5 caliente y este
    // proceso no llega a cargar el modelo. Medido el 2026-08-15: un
    // one-shot que carga E5 pica en 1,7 GB, y 3,2 GB si ademas entra el
    // cross-encoder. Sin daemon, se resuelve aqui como siempre.
    if let Some(v) =
        ul::daemon_client::orchestrate(&prompt, project, std::time::Duration::from_secs(30))
    {
        return Ok(v);
    }
    // CLI one-shot fallback for the hot path. dense=TRUE: quality-first
    // (full hybrid recall + semantic match); see serve.rs for rationale.
    to_json(ul::orchestrator::orchestrate(&prompt, project, true))
}

/// `--cross` / `--all-projects`: recall sobre todo el cerebro (Secret sigue fuera).
fn cross_flag(args: &[String]) -> bool {
    has_flag(args, "--cross") || has_flag(args, "--all-projects")
}

/// `trace <query>`: diagnostico completo del retrieval (cat1, 2026-07-02):
/// dense/sparse/fused con ranks + injected/discarded CON RAZON (token cap,
/// governance, rank). Es build_trace serializado, disponible headless para
/// diagnosticar el golden set.
pub(crate) fn trace(args: &[String], project: Option<&str>) -> Result<Value, String> {
    let query = positional(args)?;
    // Diagnostico: sin evento Retrieved ni touch de los inyectados.
    to_json(
        ul::commands::memory::recall_unified::build_trace_diagnostic(
            &query,
            8,
            project,
            cross_flag(args),
            true,
            true, // paridad con el eval: el trace diagnostica el path de calidad
        )?,
    )
}

/// `recall <query> [--cross|--all-projects] [--diagnostic]`.
pub(crate) fn recall(args: &[String], project: Option<&str>) -> Result<Value, String> {
    let query = positional(args)?;
    // CROSS-PROJECT: --cross / --all-projects relaxes the project filter so
    // the recall searches the WHOLE brain (items from any project), not just
    // the current one. Security is untouched: Secret items stay excluded.
    let cross = cross_flag(args);
    // `--diagnostic` (2026-10-23): benchmarks y medidores; el recall no
    // deja evento Retrieved ni toca access_count/last_accessed_at.
    let diagnostic = has_flag(args, "--diagnostic");
    // Igual que orchestrate: el daemon primero. Aqui el ahorro es el
    // mayor de todos, porque el recall manual pide cross-encoder y ese
    // camino cargaba los DOS modelos en este proceso (3,2 GB medidos).
    if let Some(v) = ul::daemon_client::recall(
        &query,
        8,
        project,
        cross,
        true,
        diagnostic,
        std::time::Duration::from_secs(60),
    ) {
        return Ok(v);
    }
    let pack = if diagnostic {
        ul::commands::memory::recall_unified::recall_pack_diagnostic
    } else {
        ul::commands::memory::recall_unified::recall_pack
    };
    // recall manual explicito: calidad con cross-encoder
    to_json(pack(&query, 8, project, cross, true)?)
}

/// `hubs [--prompts 200] [--threshold 0.2] [--min-count 5] [--apply] [--with-penalty]`.
///
/// Hubs del recall (2026-09-23): repite prompts reales de orchestrate.jsonl
/// por el recall en crudo y lista los items que se inyectan en una fracción
/// alta de ellos. --apply escribe cockpit/memory-hubs.json, que el motor
/// usa para bajarles el rrf_score (ULTRON_HUB_PENALTY).
pub(crate) fn hubs(args: &[String]) -> Result<Value, String> {
    let num = |flag: &str, def: f64| {
        flag_value(args, flag)
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(def)
    };
    to_json(ul::commands::memory::recall_unified::hubs::compute_hubs(
        num("--prompts", 200.0) as usize,
        num("--threshold", 0.2) as f32,
        num("--min-count", 5.0) as usize,
        has_flag(args, "--apply"),
        has_flag(args, "--with-penalty"),
    )?)
}

/// `eval [--project X] [--golden [<path>]] [--summary]`.
///
/// cat6.5 (mand.11): los flags desconocidos los rechaza `cli_spec::preflight`
/// (un typo como `--gold` por `--golden` fingiria medir con el eval sintetico).
/// `--golden <path>` (with a path argument) loads an EXTERNAL hand-labeled
/// JSON file (schema: `{ "labeled": [...] }`, cat19 FASE A oracle) and
/// returns a `LabeledGoldenReport` directly — the external oracle takes
/// precedence over the embedded golden metrics when a path is given.
///
/// `--golden` alone (boolean, no path) ADDITIVELY merges the internal
/// ranking-quality metrics (precision@k/recall@k/MRR/nDCG/context-waste)
/// under a `golden_metrics` key, same as before.
///
/// Default (no flag): the substring-based recall@8 report + security gate.
pub(crate) fn eval(args: &[String], project: Option<&str>) -> Result<Value, String> {
    if let Some(golden_path) = flag_value(args, "--golden") {
        return eval_external_golden(args, &golden_path);
    }
    let mut v = to_json(ul::memory::evals::run(project, 8))?;
    if has_flag(args, "--golden") {
        let gm = ul::memory::evals::run_golden_metrics(project, 8, true);
        if let Value::Object(ref mut map) = v {
            map.insert("golden_metrics".to_string(), to_json(gm)?);
        }
    }
    Ok(v)
}

/// cat19 FASE A: oráculo externo en `golden_path`.
fn eval_external_golden(args: &[String], golden_path: &str) -> Result<Value, String> {
    let mut v = to_json(ul::memory::evals::run_labeled_golden(golden_path, 8))?;
    // `--summary` (P2 token-eff): quita el desglose per-query (~300
    // lineas de retrieved_ids) y deja solo el aggregate + conteos —
    // lo que consumen el harness y una lectura humana del gate.
    if has_flag(args, "--summary") {
        if let Value::Object(ref mut map) = v {
            map.remove("per_query");
        }
    }
    Ok(v)
}

/// `eval-full`: ONLY the ranking-quality metrics over the real golden set
/// (precision@k/recall@k/MRR/nDCG/context-waste + security gate). FAIL-SAFE:
/// degrades to an all-zero `degraded` report if the golden set is missing or
/// Qdrant/E5 is offline.
pub(crate) fn eval_full(project: Option<&str>) -> Result<Value, String> {
    to_json(ul::memory::evals::run_golden_metrics(project, 8, true))
}
