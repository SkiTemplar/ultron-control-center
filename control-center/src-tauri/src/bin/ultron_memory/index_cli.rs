//! Subcomandos de índices, catálogo y curación del sidecar (`reindex`,
//! `catalog`, `reindex-skills-lazy`, `skill-query`, `skill-judge`,
//! `reconcile`, `backfill-projects`, `curate`, `reassign-project`).
//!
//! Separados de `run()` en main.rs (calidad-rust-4, 2026-10-23). Cada función
//! es el brazo de antes, sin cambios de comportamiento.

use control_center_lib as ul;
use serde_json::{json, Value};

use crate::cli_args::{flag_value, has_flag};
use crate::to_json;

/// `reindex`: reconstruye el índice denso entero.
pub(crate) fn reindex() -> Result<Value, String> {
    let (indexed, errors) = ul::memory::qdrant_index::reindex_all().map_err(|e| e.to_string())?;
    Ok(json!({ "indexed": indexed, "errors": errors }))
}

/// (Re)index the agent/skill catalog (`ultron_catalog`) used by the
/// orchestrator's `delegate_agents` semantic routing. Idempotent.
///   ultron-memory catalog            # agents + enabled skills (default)
///   ultron-memory catalog --agents   # agents only
///   ultron-memory catalog --skills   # enabled skills only
/// `.disabled` skills are never indexed (they must not be routed to).
pub(crate) fn catalog(args: &[String]) -> Result<Value, String> {
    let only_agents = has_flag(args, "--agents");
    let only_skills = has_flag(args, "--skills");

    let indexed_agents = if only_skills {
        None
    } else {
        Some(ul::memory::catalog::index_agents()?)
    };
    // Skills are additive: surface a skill failure as a field instead of
    // discarding agent counts that were already committed.
    let (indexed_skills, skill_error) = if only_agents {
        (None, None)
    } else {
        match ul::memory::catalog::index_skills() {
            Ok(c) => (Some(c), None),
            Err(e) => (None, Some(e)),
        }
    };

    let (a_ok, a_err) = indexed_agents.unwrap_or((0, 0));
    let (s_ok, s_err) = indexed_skills.unwrap_or((0, 0));
    Ok(json!({
        "indexed_agents": a_ok,
        "indexed_skills": s_ok,
        "errors": a_err + s_err,
        "skill_error": skill_error,
        "collection": ul::memory::catalog::CATALOG_COLLECTION,
    }))
}

/// (Re)index ALL skills (enabled + disabled) into `ultron_skills_lazy`.
/// Used to measure acc@3 of E5 routing over the full lazy-dispatch corpus
/// before wiring the hot path. Never touches `ultron_catalog`.
pub(crate) fn reindex_skills_lazy() -> Result<Value, String> {
    let (ok, err) = ul::memory::catalog::index_skills_lazy()?;
    to_json(json!({
        "indexed": ok,
        "errors": err,
        "collection": ul::memory::catalog::SKILLS_LAZY_COLLECTION,
    }))
}

/// Prompt de `skill-query`: los posicionales tras el subcomando, saltando los
/// flags con valor (`--top N`, `--project P`) y los booleanos (`--*`).
fn skill_query_prompt(args: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut i = 2usize;
    while i < args.len() {
        match args[i].as_str() {
            "--project" | "--top" => {
                i += 2; // skip flag + its value
            }
            s if s.starts_with("--") => {
                i += 1; // skip unknown boolean flag
            }
            _ => {
                parts.push(args[i].clone());
                i += 1;
            }
        }
    }
    parts.join(" ")
}

/// Semantic skill search over the full lazy corpus (enabled + disabled).
///   ultron-memory skill-query <prompt> [--top N]   (default N=5)
/// Returns a JSON array of hits ordered by E5 cosine similarity desc.
pub(crate) fn skill_query(args: &[String]) -> Result<Value, String> {
    let top: u32 = flag_value(args, "--top")
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let prompt = skill_query_prompt(args);
    if prompt.trim().is_empty() {
        return Err("skill-query requires a prompt argument".to_string());
    }
    let hits = ul::memory::catalog::search_skills_lazy(&prompt, top);
    let result: Vec<Value> = hits
        .into_iter()
        .map(|h| {
            json!({
                "name": h.name,
                "score": h.score,
                "kind": h.kind,
                "description": h.description,
            })
        })
        .collect();
    to_json(result)
}

/// Skill routing por LLM sobre el catalogo completo (2026-08-27). El
/// retriever denso de `skill-query` acierta 4/10 en top-1 y sus scores
/// caben todos en 0.79-0.84, asi que no hay umbral que separe un acierto
/// de un candidato al azar; este camino le da el catalogo entero a un
/// modelo pequeno y valida la respuesta contra el.
///   ultron-memory skill-judge <prompt>
pub(crate) fn skill_judge(args: &[String]) -> Result<Value, String> {
    let prompt = args[2..].join(" ");
    if prompt.trim().is_empty() {
        return Err("skill-judge requires a prompt argument".to_string());
    }
    let catalogo = ul::orchestrator::skill_llm::catalogo_desde_disco();
    let elegidas = ul::orchestrator::skill_llm::elegir_skills(&prompt, &catalogo);
    // `elegir_skills` calla cualquier fallo por diseno (es hot path del
    // hook). Este subcomando existe para MEDIR, asi que expone por que
    // vino vacio: sin clave y "el modelo dijo ninguna" son diagnosticos
    // opuestos y sin esto se confunden.
    to_json(json!({
        "skills": elegidas,
        "catalog_size": catalogo.len(),
        "key_var": ul::orchestrator::skill_llm::key_var(),
        "model": ul::orchestrator::skill_llm::modelo(),
    }))
}

/// `reconcile [--fix [--dry-run]]`.
///
/// Default: read-only SQLite<->Qdrant drift check.
/// `--fix` repairs only the drift (re-embed missing, drop orphans) so
/// an item swallowed by `sync_index` does not stay out of the dense
/// index until a full `reindex`. Mutating, hence opt-in and
/// dry-runnable (08-AUDIT policy).
pub(crate) fn reconcile(args: &[String]) -> Result<Value, String> {
    if has_flag(args, "--fix") {
        let dry_run = has_flag(args, "--dry-run");
        to_json(ul::memory::qdrant_index::reconcile_fix(dry_run).map_err(|e| e.to_string())?)
    } else {
        to_json(ul::memory::qdrant_index::reconcile_check().map_err(|e| e.to_string())?)
    }
}

/// Valor numérico de `flag` o `default` si falta o no se parsea.
fn parsed_or<T: std::str::FromStr>(args: &[String], flag: &str, default: T) -> T {
    flag_value(args, flag)
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// (2026-07-13) Backfill de project_id del corpus AMBIENTE (NULL):
/// normalize (variantes -> slug canonico) + provenance (session_id del
/// cockpit) + dense vote (vector almacenado en Qdrant, k-NN etiquetado).
/// Dry-run por defecto; --apply escribe (SQLite + evento + payload).
pub(crate) fn backfill_projects(args: &[String]) -> Result<Value, String> {
    use ul::memory::backfill as bf;
    let opts = bf::BackfillOpts {
        apply: has_flag(args, "--apply"),
        min_score: parsed_or(args, "--min-score", bf::DEFAULT_MIN_SCORE),
        min_share: parsed_or(args, "--min-share", bf::DEFAULT_MIN_SHARE),
        knn: parsed_or(args, "--knn", bf::DEFAULT_KNN),
        llm: has_flag(args, "--llm"),
        llm_min_conf: parsed_or(args, "--llm-min-conf", bf::DEFAULT_LLM_MIN_CONF),
    };
    bf::run(&opts)
}

/// Curación de UN item (bisturí): project_id y/o título, con evento y
/// reindex denso si el texto cambia. Dry-run salvo --apply.
///   ultron-memory curate --id <prefix> [--project <slug>] [--title "..."] [--apply]
pub(crate) fn curate(args: &[String]) -> Result<Value, String> {
    let id =
        flag_value(args, "--id").ok_or_else(|| "curate requiere --id <prefijo>".to_string())?;
    let proj = flag_value(args, "--project");
    let title = flag_value(args, "--title");
    ul::memory::curate::curate_item(
        &id,
        proj.as_deref(),
        title.as_deref(),
        has_flag(args, "--apply"),
    )
}

/// Curación puntual: mueve TODOS los items de un project_id a otro slug
/// canónico (ids legado que el normalize no puede plegar). Dry-run salvo --apply.
pub(crate) fn reassign_project(args: &[String]) -> Result<Value, String> {
    let from = flag_value(args, "--from")
        .ok_or_else(|| "reassign-project requiere --from <project_id>".to_string())?;
    let to = flag_value(args, "--to")
        .ok_or_else(|| "reassign-project requiere --to <slug-canonico>".to_string())?;
    ul::memory::backfill::reassign_project(&from, &to, has_flag(args, "--apply"))
}
