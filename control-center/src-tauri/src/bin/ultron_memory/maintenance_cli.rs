//! Subcomandos de mantenimiento de la memoria: borrado gobernado (`forget`),
//! archivado, deprecación por tipo o por id, envejecimiento (`stale`), gc,
//! sweep por confianza, dedupe, reconstrucción de FTS5, `secret-backfill` y
//! cierre de deadlines (`deprecations apply`). Todos escriben a través de
//! `MemoryService` (escritor único) y casi todos aceptan `--dry-run`.
//!
//! Separado de `main.rs` para que el despachador no pase de las 800 líneas;
//! `run()` enruta aquí los nombres de [`maintenance_command`]. Desde el
//! 2026-10-23 (calidad-rust-4) cada subcomando es una función propia; el
//! comportamiento no cambia.

use control_center_lib as ul;
use serde_json::{json, Value};
use ul::memory::{Actor, MemoryService, MemoryType};

use crate::cli_args::{flag_value, has_flag};
use crate::{resolve_id_prefix, to_json};

/// Ejecuta un subcomando de mantenimiento. `args` es el argv completo (como en
/// `run()`), `project` el valor de `--project` si lo hay.
pub(crate) fn maintenance_command(
    cmd: &str,
    args: &[String],
    project: Option<&str>,
) -> Result<Value, String> {
    match cmd {
        "forget" => forget(args),
        "archive" => archive(args),
        "deprecate" => deprecate(args, project),
        "stale" => stale(args),
        "fts-rebuild" => to_json(MemoryService::fts_rebuild().map_err(|e| e.to_string())?),
        "secret-backfill" => secret_backfill(args),
        "pii-backfill" => pii_backfill(args),
        "scrub-secrets" => scrub_secrets(args),
        "gc" => gc(args),
        "sweep" => sweep(args),
        "dedupe" => dedupe(args),
        "deprecations" => deprecations(args),
        other => Err(format!("unknown maintenance command '{other}'")),
    }
}

/// `--type <T>` obligatorio, ya parseado.
fn required_type(args: &[String], missing: &str) -> Result<MemoryType, String> {
    let kind_s = flag_value(args, "--type").ok_or_else(|| missing.to_string())?;
    MemoryType::parse(&kind_s).ok_or_else(|| format!("invalid memory type '{kind_s}'"))
}

/// Governed, selective hard-delete by item id.
///
/// Event-sourced: removes the row from brain.db (SQLite SoT) + its Qdrant
/// point (dense index), then appends a `MemoryEvent` (Updated, reason
/// "forgotten") with a `before` snapshot — the only surviving audit record.
/// Reuses the exact `MemoryService::forget` path wired to the Tauri
/// `memory_forget` command (see commands/memory/inbox.rs).
///
/// Accepts a full UUID or an unambiguous id PREFIX (≥ 4 characters,
/// compared literally: no LIKE wildcards, case-sensitive). When a prefix
/// is supplied the sidecar resolves it against brain.db and rejects the
/// call when it is too short, absent or ambiguous (matches > 1 item) —
/// so a partial id can never delete the wrong item.
///
/// Flags:
///   --id <id|prefix>   required — the item to forget
///   --dry-run          print what WOULD be forgotten without mutating
///   --reason <R>       optional free-text reason (logged in the audit event)
///
/// Usage:
///   ultron-memory forget --id 7cd41c41 --dry-run
///   ultron-memory forget --id 7cd41c41 --reason "PII purge audit-2026-06-25"
///   ultron-memory forget --id 84afaee2-3b1a-4c2f-8e0d-000000000000 --reason "PII"
fn forget(args: &[String]) -> Result<Value, String> {
    let id_prefix =
        flag_value(args, "--id").ok_or_else(|| "forget requires --id <id|prefix>".to_string())?;
    let reason = flag_value(args, "--reason");
    // Resolve prefix → full id via the canonical store.
    let resolved_id = resolve_id_prefix(&id_prefix)?;
    if has_flag(args, "--dry-run") {
        return forget_preview(&resolved_id);
    }
    MemoryService::forget(&resolved_id, Actor::System, reason).map_err(|e| e.to_string())?;
    Ok(json!({
        "forgotten": resolved_id,
        "ok": true,
    }))
}

/// Dry-run de `forget`: el item que se borraría.
fn forget_preview(resolved_id: &str) -> Result<Value, String> {
    let item = MemoryService::get(resolved_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("item '{resolved_id}' not found"))?;
    Ok(json!({
        "dry_run": true,
        "would_forget": {
            "id": item.id,
            "type": item.kind.as_str(),
            "status": item.status.as_str(),
            "sensitivity": item.sensitivity.as_str(),
            "summary": item.summary,
        }
    }))
}

/// F1.7 (Q8b): archivar a tabla aparte (memory_items_archive) los ACTIVE de
/// --type creados hace más de --older-than-days (default 14). --dry-run solo
/// cuenta. Fuera del retriever, FTS5, Qdrant y reconcile.
fn archive(args: &[String]) -> Result<Value, String> {
    let kind = required_type(args, "archive requires --type <T>")?;
    let days: u64 = match flag_value(args, "--older-than-days") {
        Some(v) => v
            .parse::<u64>()
            .map_err(|e| format!("--older-than-days: {e}"))?,
        None => 14,
    };
    let dry = has_flag(args, "--dry-run");
    let reason = flag_value(args, "--reason");
    let res = MemoryService::archive_by_type(kind, days, dry, Actor::System, reason)
        .map_err(|e| e.to_string())?;
    to_json(res)
}

/// Bulk-deprecate every ACTIVE item of a type (purge bloat, e.g.
/// codebase_fact). --dry-run only counts. Reuses set_status per id so
/// FTS5 + Qdrant stay in sync; appends a Deprecated event per item.
///   ultron-memory deprecate --type codebase_fact [--dry-run] [--project X] [--reason R]
///   ultron-memory deprecate --id <id|prefix> [--reason R]   (curacion de eras, 2026-07-02)
fn deprecate(args: &[String], project: Option<&str>) -> Result<Value, String> {
    if let Some(id_prefix) = flag_value(args, "--id") {
        return deprecate_one(args, &id_prefix);
    }
    let kind = required_type(
        args,
        "deprecate requires --type <T> (bulk) o --id <id> (item)",
    )?;
    let dry = has_flag(args, "--dry-run");
    let reason = flag_value(args, "--reason");
    let res = MemoryService::deprecate_by_type(kind, dry, project, reason, Actor::System)
        .map_err(|e| e.to_string())?;
    to_json(res)
}

/// Modo por-id: deprecacion RECOVERABLE de un item concreto (hechos de una era
/// superseded: la afirmacion fue real, ya no es verdad vigente). forget es
/// borrado duro (PII); esto conserva el item fuera de recall.
fn deprecate_one(args: &[String], id_prefix: &str) -> Result<Value, String> {
    let resolved_id = resolve_id_prefix(id_prefix)?;
    // --dry-run se ignoraba en el modo por-id y el item se deprecaba
    // de verdad (2026-09-23): ahora solo informa de lo que haria.
    if has_flag(args, "--dry-run") {
        return Ok(json!({
            "would_deprecate": resolved_id,
            "dry_run": true,
            "ok": true,
        }));
    }
    let reason = flag_value(args, "--reason");
    let item =
        MemoryService::deprecate(&resolved_id, Actor::System, reason).map_err(|e| e.to_string())?;
    Ok(json!({
        "deprecated": resolved_id,
        "status": item.status.as_str(),
        "ok": true,
    }))
}

/// Sweep ACTIVE items not MODIFIED in --older-than-days (default 180) and
/// transition them to Status::Stale (no longer recall-eligible). --dry-run
/// only counts. Reuses set_status per id so FTS5 + Qdrant + the event log
/// stay in sync; pinned and user-validated items are protected. Reversible.
///   ultron-memory stale [--older-than-days N] [--dry-run] [--reason R]
fn stale(args: &[String]) -> Result<Value, String> {
    let days: i64 = flag_value(args, "--older-than-days")
        .and_then(|s| s.parse().ok())
        .unwrap_or(180);
    let dry = has_flag(args, "--dry-run");
    let reason = flag_value(args, "--reason");
    let res = MemoryService::mark_stale_aged(days, dry, Actor::System, reason)
        .map_err(|e| e.to_string())?;
    to_json(res)
}

// `fts-rebuild` (en el despachador): reconstruye el indice FTS5 de
// memory_items (2026-09-22). El indice de contenido externo se habia
// desincronizado (10.205 filas frente a 4.390 items), MATCH fallaba con
// "missing row" y el recall sparse devolvia basura. `doctor` lo detecta en el
// check `fts`; esto lo repara y devuelve el estado antes/despues.

/// Baja a `internal` los items activos Secret cuyo unico marcador de
/// redaccion es [REDACTED_PHONE]: hasta el 2026-09-22 el detector de PII
/// tomaba las fechas ISO por telefonos y el pack del recall excluia esas
/// memorias para siempre (35 de 69 Secret activos). Tambien devuelve la
/// fecha a los titulos generados por hooks ("Resumen SessionEnd <fecha>")
/// a partir de created_at. --dry-run solo cuenta.
///   ultron-memory secret-backfill [--dry-run]
fn secret_backfill(args: &[String]) -> Result<Value, String> {
    let dry = has_flag(args, "--dry-run");
    to_json(MemoryService::secret_backfill(dry, Actor::System).map_err(|e| e.to_string())?)
}

/// (2026-10-23) Items ACTIVE anteriores al guard de PII del write-path:
/// redacta credenciales y PII en todos sus campos, los marca Secret y
/// deja evento. --dry-run solo los lista.
///   ultron-memory pii-backfill [--dry-run]
fn pii_backfill(args: &[String]) -> Result<Value, String> {
    let dry = has_flag(args, "--dry-run");
    to_json(MemoryService::pii_backfill(dry, Actor::System).map_err(|e| e.to_string())?)
}

/// (2026-11-02) Barre credenciales ya persistidas con el detector ACTUAL en
/// memory_items (por el camino normal: FTS5 en sync, item a Secret, evento),
/// memory_candidates, memory_events, el archivo y el resto de columnas de
/// texto capturado; reescribe solo lo que cambia y compacta (checkpoint
/// TRUNCATE + VACUUM) para que el valor no quede en disco. Si la compactación
/// o algún item fallan, sale con error. Respeta ULTRON_BRAIN_DB. La salida
/// solo trae recuentos por tabla y columna. --dry-run solo cuenta.
///   ultron-memory scrub-secrets [--dry-run]
fn scrub_secrets(args: &[String]) -> Result<Value, String> {
    let dry = has_flag(args, "--dry-run");
    let res = MemoryService::scrub_secrets(dry, Actor::System).map_err(|e| e.to_string())?;
    if !res.failed.is_empty() {
        let ids: Vec<&str> = res.failed.iter().map(|(id, _)| id.as_str()).collect();
        return Err(format!(
            "scrub-secrets: {} items sin reescribir ({}); repite con la base libre",
            ids.len(),
            ids.join(", ")
        ));
    }
    to_json(res)
}

/// Mantenimiento a 90 dias de brain.db (F1.8, 2026-09-11). Tres reglas,
/// todas con la misma ventana --days:
///   1. ACTIVE sin recall (last_accessed_at) ni cambios -> Stale.
///   2. memory_events de items deprecated/rejected -> borrados.
///   3. memory_events sin item: memory_id NULL (telemetria de recall) o
///      apuntando a un id que ya no existe (archivado/forget) -> borrados.
///
/// Ademas barre credenciales con el detector actual (como `scrub-secrets`, con
/// secure_delete y sin compactar; resultado en secrets_scrub).
/// Los eventos de items active/stale quedan intactos. Compacta con VACUUM
/// solo si el ahorro estimado supera 10 MB. --dry-run no escribe nada.
/// La salida trae el total y el desglose en events_deleted_by_rule.
///   ultron-memory gc [--days 90] [--dry-run]
fn gc(args: &[String]) -> Result<Value, String> {
    let days: i64 = flag_value(args, "--days")
        .and_then(|s| s.parse().ok())
        .unwrap_or(ul::memory::service::DEFAULT_GC_DAYS);
    let dry = has_flag(args, "--dry-run");
    to_json(MemoryService::gc(days, dry, Actor::System).map_err(|e| e.to_string())?)
}

/// Sweep por confianza (audit 2026-08-09): deprecar ACTIVE con confidence
/// < --below (default 0.55, el umbral de ruido de banda C) EXCLUYENDO
/// golden positives (el oráculo no se canibaliza), pinned y user-validated.
/// Reversible (deprecate, no forget). --dry-run solo cuenta.
///   ultron-memory sweep [--below 0.55] [--dry-run] [--reason R]
fn sweep(args: &[String]) -> Result<Value, String> {
    let below: f32 = flag_value(args, "--below")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.55);
    let dry = has_flag(args, "--dry-run");
    let reason = flag_value(args, "--reason");
    let protected = ul::memory::evals::golden_protected_ids();
    let res = MemoryService::sweep_low_confidence(below, &protected, dry, Actor::System, reason)
        .map_err(|e| e.to_string())?;
    to_json(res)
}

/// Copias exactas de ACTIVE (2026-09-03: 206 sobrantes por drains --auto
/// solapados). Reversible: Deprecated, no forget. `--dry-run` solo cuenta.
fn dedupe(args: &[String]) -> Result<Value, String> {
    let dry = has_flag(args, "--dry-run");
    let reason = flag_value(args, "--reason");
    to_json(
        MemoryService::deprecate_exact_duplicates(dry, Actor::System, reason)
            .map_err(|e| e.to_string())?,
    )
}

/// Cierra las entradas VENCIDAS y no cerradas de `deprecation_entries`
/// (kanban: "ultron-memory doctor: 478 deprecation_deadlines vencidos";
/// decisión 2026-09-14: archivar, no purgar). Si el item sigue
/// `deprecated` en `memory_items` lo archiva por el mismo camino que
/// `archive` (Qdrant + memory_items_archive + evento); si ya no existe
/// en ningún lado la entrada pasa a `state='deleted'` sin tocar
/// memoria. `--dry-run` solo cuenta. Se ejecuta también dentro de `gc`.
///   ultron-memory deprecations apply [--dry-run]
fn deprecations(args: &[String]) -> Result<Value, String> {
    match args.get(2).map(String::as_str).unwrap_or("") {
        "apply" => {
            let dry = has_flag(args, "--dry-run");
            to_json(
                MemoryService::apply_deprecation_deadlines(dry, Actor::System)
                    .map_err(|e| e.to_string())?,
            )
        }
        other => Err(format!("unknown deprecations subcommand '{other}'")),
    }
}
