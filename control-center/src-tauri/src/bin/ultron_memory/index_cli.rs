//! Subcomandos de enrutado de skills y curación del sidecar (`skill-judge`,
//! `backfill-projects`, `curate`, `reassign-project`).
//!
//! Separados de `run()` en main.rs (calidad-rust-4, 2026-10-23). Los
//! subcomandos del índice denso (`reindex`, `reconcile`, `catalog`,
//! `reindex-skills-lazy`, `skill-query`) se retiraron el 2026-11-14 con la
//! ruta densa.

use control_center_lib as ul;
use serde_json::{json, Value};

use crate::cli_args::{flag_value, has_flag};
use crate::to_json;

/// Skill routing por LLM sobre el catalogo completo (2026-08-27): le da el
/// catalogo entero a un modelo pequeno y valida la respuesta contra el.
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

/// Valor numérico de `flag` o `default` si falta o no se parsea.
fn parsed_or<T: std::str::FromStr>(args: &[String], flag: &str, default: T) -> T {
    flag_value(args, flag)
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// (2026-07-13) Backfill de project_id del corpus AMBIENTE (NULL):
/// normalize (variantes -> slug canonico) + provenance (session_id del
/// cockpit) + clasificador LLM opcional (`--llm`).
/// Dry-run por defecto; --apply escribe (SQLite + evento).
pub(crate) fn backfill_projects(args: &[String]) -> Result<Value, String> {
    use ul::memory::backfill as bf;
    let opts = bf::BackfillOpts {
        apply: has_flag(args, "--apply"),
        llm: has_flag(args, "--llm"),
        llm_min_conf: parsed_or(args, "--llm-min-conf", bf::DEFAULT_LLM_MIN_CONF),
    };
    bf::run(&opts)
}

/// Curación de UN item (bisturí): project_id y/o título, con evento.
/// Dry-run salvo --apply.
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
