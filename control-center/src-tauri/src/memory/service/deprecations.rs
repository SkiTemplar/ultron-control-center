//! `MemoryService::apply_deprecation_deadlines` — cierre de las entradas
//! vencidas de `deprecation_entries` (kanban: "ultron-memory doctor: 478
//! deprecation_deadlines vencidos"; decisión 2026-09-14: archivar, no purgar).
//!
//! Reutiliza `archive_one` (el mismo camino Qdrant-antes-que-SQL que
//! `archive_by_type`, F1.7) por-id en vez de duplicar la lógica de mover
//! filas/FTS5/Qdrant. Nunca borra un `MemoryItem`; `dry_run` no escribe nada
//! (ni memoria ni ledger).
//!
//! Alcance de los tests (mandamiento 13): la rama `ArchiveNow` decide
//! correctamente (cubierto por `decide_outcome`, puro), pero el archivado real
//! pasa por `qdrant_index::remove_item` — una llamada HTTP real a Qdrant, sin
//! seam de test — igual que `archive_by_type`/`gc`, que tampoco la cubren.
//! Las demás ramas (`AlreadyArchived`, `MissingDeleted`, `NotDeprecated`,
//! `dry_run`, idempotencia) no tocan Qdrant y están cubiertas end-to-end
//! contra una BD en memoria.

use super::super::model::{now_millis, Actor, Status};
use super::super::sqlite_store as store;
use super::super::MemoryError;
use super::{ApplyDeprecationDeadlinesResult, MemoryService};

/// Qué hacer con una entrada vencida, dado el estado real de su item. Pura
/// (sin I/O) a propósito: las cuatro ramas se prueban sin BD ni red.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DeprecationOutcome {
    /// El item sigue `deprecated` en `memory_items`: archivarlo ahora.
    ArchiveNow,
    /// El item no está en `memory_items` pero ya estaba en el archivo
    /// (una corrida anterior, o `archive_by_type` lo archivó por otra vía).
    AlreadyArchived,
    /// El item no está ni en `memory_items` ni en el archivo: no hay nada que
    /// archivar.
    MissingDeleted,
    /// El item existe pero ya no está `deprecated` (p.ej. se restauró a
    /// `active` tras el deadline). Cerrar el ledger aquí sería más agresivo
    /// que lo que pidió el usuario.
    NotDeprecated(Status),
}

fn decide_outcome(item_status: Option<Status>, already_archived: bool) -> DeprecationOutcome {
    match item_status {
        Some(Status::Deprecated) => DeprecationOutcome::ArchiveNow,
        Some(other) => DeprecationOutcome::NotDeprecated(other),
        None if already_archived => DeprecationOutcome::AlreadyArchived,
        None => DeprecationOutcome::MissingDeleted,
    }
}

impl MemoryService {
    /// Recorre las entradas de `deprecation_entries` cuyo `deadline` ya pasó y
    /// que no están cerradas, y las cierra según [`decide_outcome`]. Un fallo
    /// por item (Qdrant/SQL) se recoge en `failed` y no aborta el lote.
    pub fn apply_deprecation_deadlines(
        dry_run: bool,
        actor: Actor,
    ) -> Result<ApplyDeprecationDeadlinesResult, MemoryError> {
        let conn = store::open_conn()?;
        let now = now_millis();
        Self::apply_deprecation_deadlines_with_conn(&conn, now, dry_run, actor)
    }

    /// Núcleo testable: recibe la conexión y el instante `now` en vez de
    /// abrirlos por su cuenta (como hace la mayoría de `sqlite_store`), para
    /// poder correrlo contra una BD temporal en memoria.
    fn apply_deprecation_deadlines_with_conn(
        conn: &rusqlite::Connection,
        now: i64,
        dry_run: bool,
        actor: Actor,
    ) -> Result<ApplyDeprecationDeadlinesResult, MemoryError> {
        let now_iso = store::millis_to_iso_utc(now);
        let overdue = store::select_overdue_deprecation_entries(conn, &now_iso)?;

        let mut res = ApplyDeprecationDeadlinesResult {
            examined: overdue.len(),
            archived: 0,
            missing_closed: 0,
            skipped: 0,
            dry_run,
            skipped_reasons: Vec::new(),
            failed: Vec::new(),
        };

        let reason = "apply_deprecation_deadlines: deadline vencido (kanban 478)".to_string();

        for entry in overdue {
            let item = store::get_item(conn, &entry.artifact)?;
            let already_archived = if item.is_none() {
                store::archive_contains(conn, &entry.artifact)?
            } else {
                false
            };
            let outcome = decide_outcome(item.as_ref().map(|it| it.status), already_archived);

            match outcome {
                DeprecationOutcome::ArchiveNow => {
                    if dry_run {
                        res.archived += 1;
                        continue;
                    }
                    // `decide_outcome` solo devuelve `ArchiveNow` cuando `item`
                    // es `Some`.
                    let it = item.expect("ArchiveNow implica item presente");
                    match Self::archive_one(conn, &it, now, &reason, actor) {
                        Ok(()) => {
                            let _ = store::update_deprecation_entry_state(
                                conn, &entry.id, "archived", &now_iso,
                            );
                            res.archived += 1;
                        }
                        Err(e) => res.failed.push((entry.artifact.clone(), e.to_string())),
                    }
                }
                DeprecationOutcome::AlreadyArchived => {
                    if !dry_run {
                        let _ = store::update_deprecation_entry_state(
                            conn, &entry.id, "archived", &now_iso,
                        );
                    }
                    res.archived += 1;
                }
                DeprecationOutcome::MissingDeleted => {
                    if !dry_run {
                        let _ = store::update_deprecation_entry_state(
                            conn, &entry.id, "deleted", &now_iso,
                        );
                    }
                    res.missing_closed += 1;
                }
                DeprecationOutcome::NotDeprecated(status) => {
                    res.skipped += 1;
                    res.skipped_reasons.push((
                        entry.id.clone(),
                        format!(
                            "item {} sigue en status '{}', no 'deprecated'",
                            entry.artifact,
                            status.as_str()
                        ),
                    ));
                }
            }
        }

        Ok(res)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::model::{MemoryItem, MemoryType, Scope, Source};
    use crate::memory::sqlite_store::{
        apply_schema, archive_item, get_item, insert_deprecation_entry, insert_item,
        select_overdue_deprecation_entries, DeprecationEntryInput,
    };
    use rusqlite::Connection;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory");
        apply_schema(&conn).expect("schema");
        conn
    }

    const PAST_DEADLINE_MS: i64 = 1_700_000_000_000; // 2023-11-14, siempre pasado
    const NOW_MS: i64 = 1_800_000_000_000; // "ahora" fijo del test (2027-01-15)

    fn overdue_entry(id_suffix: &str, artifact: &str) -> DeprecationEntryInput {
        let ts = store::millis_to_iso_utc(PAST_DEADLINE_MS);
        DeprecationEntryInput {
            id: format!("dep:{id_suffix}"),
            artifact: artifact.to_string(),
            domain: "memory".to_string(),
            kind: "codebase_fact".to_string(),
            owner: None,
            path: format!("memory://{artifact}"),
            reason: "deprecated".to_string(),
            replacement: None,
            state: "deprecated".to_string(),
            risk: "low".to_string(),
            regenerable: 0,
            size_bytes: None,
            cleanup_action: "purge".to_string(),
            rollback_action: "restore".to_string(),
            first_seen: ts.clone(),
            last_seen: ts.clone(),
            deadline: ts, // ya vencido: es igual al first_seen, muy anterior a NOW_MS
            retention_class: "memory-90d".to_string(),
            evidence_json: None,
            confirmed_by: None,
            schema_version: 3,
        }
    }

    fn future_entry(id_suffix: &str, artifact: &str) -> DeprecationEntryInput {
        let mut e = overdue_entry(id_suffix, artifact);
        e.deadline = store::millis_to_iso_utc(NOW_MS + 90 * 24 * 3_600 * 1_000);
        e
    }

    fn deprecated_item(id: &str) -> MemoryItem {
        let mut item = MemoryItem::new(
            MemoryType::CodebaseFact,
            Scope::Project,
            Source::CodeObserved,
            Status::Deprecated,
        );
        item.id = id.to_string();
        item
    }

    // -- decide_outcome (puro, sin I/O) --------------------------------------

    #[test]
    fn decide_outcome_archives_present_deprecated_item() {
        assert_eq!(
            decide_outcome(Some(Status::Deprecated), false),
            DeprecationOutcome::ArchiveNow
        );
    }

    #[test]
    fn decide_outcome_skips_present_item_not_deprecated() {
        assert_eq!(
            decide_outcome(Some(Status::Active), false),
            DeprecationOutcome::NotDeprecated(Status::Active)
        );
    }

    #[test]
    fn decide_outcome_marks_deleted_when_item_missing_everywhere() {
        assert_eq!(
            decide_outcome(None, false),
            DeprecationOutcome::MissingDeleted
        );
    }

    #[test]
    fn decide_outcome_marks_archived_when_already_in_archive() {
        assert_eq!(
            decide_outcome(None, true),
            DeprecationOutcome::AlreadyArchived
        );
    }

    // -- apply_deprecation_deadlines_with_conn (BD en memoria, sin red) -----

    #[test]
    fn overdue_entry_with_missing_item_closes_as_deleted_without_error() {
        let conn = mem_conn();
        insert_deprecation_entry(&conn, &overdue_entry("missing-1", "item-missing-1")).unwrap();

        let res = MemoryService::apply_deprecation_deadlines_with_conn(
            &conn,
            NOW_MS,
            false,
            Actor::System,
        )
        .unwrap();

        assert_eq!(res.examined, 1);
        assert_eq!(res.missing_closed, 1);
        assert_eq!(res.archived, 0);
        assert!(res.failed.is_empty());

        let state: String = conn
            .query_row(
                "SELECT state FROM deprecation_entries WHERE id = 'dep:missing-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "deleted");
    }

    #[test]
    fn overdue_entry_already_in_archive_closes_as_archived_without_touching_memory() {
        let conn = mem_conn();
        let item = deprecated_item("item-arch-1");
        insert_item(&conn, &item).unwrap();
        archive_item(
            &conn,
            &item.id,
            PAST_DEADLINE_MS,
            "pre-archivado en otra corrida",
        )
        .unwrap();
        insert_deprecation_entry(&conn, &overdue_entry("arch-1", "item-arch-1")).unwrap();

        let res = MemoryService::apply_deprecation_deadlines_with_conn(
            &conn,
            NOW_MS,
            false,
            Actor::System,
        )
        .unwrap();

        assert_eq!(res.archived, 1);
        assert_eq!(res.missing_closed, 0);
        let state: String = conn
            .query_row(
                "SELECT state FROM deprecation_entries WHERE id = 'dep:arch-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "archived");
    }

    #[test]
    fn overdue_entry_with_item_no_longer_deprecated_is_skipped_intact() {
        let conn = mem_conn();
        let mut item = deprecated_item("item-active-again");
        item.status = Status::Active;
        insert_item(&conn, &item).unwrap();
        insert_deprecation_entry(&conn, &overdue_entry("skip-1", "item-active-again")).unwrap();

        let res = MemoryService::apply_deprecation_deadlines_with_conn(
            &conn,
            NOW_MS,
            false,
            Actor::System,
        )
        .unwrap();

        assert_eq!(res.skipped, 1);
        assert_eq!(res.skipped_reasons.len(), 1);
        assert_eq!(res.archived, 0);
        assert_eq!(res.missing_closed, 0);
        // La entrada NO se toca: sigue 'deprecated' (el estado original del ledger).
        let state: String = conn
            .query_row(
                "SELECT state FROM deprecation_entries WHERE id = 'dep:skip-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "deprecated");
        // El item tampoco se toca: sigue activo.
        let still_active = get_item(&conn, "item-active-again").unwrap().unwrap();
        assert_eq!(still_active.status, Status::Active);
    }

    #[test]
    fn entry_with_future_deadline_is_left_intact() {
        let conn = mem_conn();
        insert_deprecation_entry(&conn, &future_entry("future-1", "item-future-1")).unwrap();

        let res = MemoryService::apply_deprecation_deadlines_with_conn(
            &conn,
            NOW_MS,
            false,
            Actor::System,
        )
        .unwrap();

        assert_eq!(res.examined, 0, "un deadline futuro no debe examinarse");
        let state: String = conn
            .query_row(
                "SELECT state FROM deprecation_entries WHERE id = 'dep:future-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "deprecated", "intacta: nunca se tocó");
    }

    #[test]
    fn dry_run_counts_without_writing_anything() {
        let conn = mem_conn();
        insert_deprecation_entry(&conn, &overdue_entry("dry-missing", "item-dry-missing")).unwrap();
        let item = deprecated_item("item-dry-present");
        insert_item(&conn, &item).unwrap();
        insert_deprecation_entry(&conn, &overdue_entry("dry-present", "item-dry-present")).unwrap();

        let res = MemoryService::apply_deprecation_deadlines_with_conn(
            &conn,
            NOW_MS,
            true,
            Actor::System,
        )
        .unwrap();

        // Caso negativo: cuenta lo que haría (1 archivado, 1 deleted) pero...
        assert!(res.dry_run);
        assert_eq!(res.missing_closed, 1);
        assert_eq!(res.archived, 1);

        // ...cero escrituras reales: ambas entradas siguen 'deprecated' y el
        // item sigue en memory_items (no se movió al archivo).
        let states: Vec<String> = ["dep:dry-missing", "dep:dry-present"]
            .iter()
            .map(|id| {
                conn.query_row(
                    "SELECT state FROM deprecation_entries WHERE id = ?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap()
            })
            .collect();
        assert_eq!(
            states,
            vec!["deprecated".to_string(), "deprecated".to_string()]
        );
        assert!(get_item(&conn, "item-dry-present").unwrap().is_some());
    }

    #[test]
    fn running_twice_is_idempotent() {
        let conn = mem_conn();
        insert_deprecation_entry(&conn, &overdue_entry("idem-1", "item-idem-missing")).unwrap();

        let first = MemoryService::apply_deprecation_deadlines_with_conn(
            &conn,
            NOW_MS,
            false,
            Actor::System,
        )
        .unwrap();
        assert_eq!(first.examined, 1);
        assert_eq!(first.missing_closed, 1);

        // Segunda pasada: la entrada ya está 'deleted', select_overdue la excluye.
        let second = MemoryService::apply_deprecation_deadlines_with_conn(
            &conn,
            NOW_MS,
            false,
            Actor::System,
        )
        .unwrap();
        assert_eq!(second.examined, 0);
        assert_eq!(second.missing_closed, 0);
        assert_eq!(second.archived, 0);

        // La query de solo-lectura también confirma que ya no aparece.
        let now_iso = store::millis_to_iso_utc(NOW_MS);
        let overdue = select_overdue_deprecation_entries(&conn, &now_iso).unwrap();
        assert!(overdue.is_empty());
    }
}
