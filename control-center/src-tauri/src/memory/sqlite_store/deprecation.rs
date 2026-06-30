// sqlite_store/deprecation.rs — Ledger vivo de deprecaciones (cat21.4).
//
// `insert_deprecation_entry` es el ÚNICO escritor de `deprecation_entries` y
// `deprecation_events` (regla de oro: solo MemoryService escribe, y solo pasa
// por esta capa de store). La operación es idempotente (INSERT OR IGNORE) basada
// en el id canónico `dep:<item_id>`, que garantiza unicidad por item.
//
// `millis_to_iso_utc` convierte epoch-millis (i64, formato de `now_millis()`)
// a ISO-8601 UTC sin sub-segundos `%Y-%m-%dT%H:%M:%SZ`, que es el formato que
// el check `check_deprecation_deadlines` del doctor compara via texto.
//
// POLARIDAD DEL DEADLINE: siempre `event_time + 90 días`. El brain.db tiene
// < 6 semanas de antigüedad, por lo que todos los deadlines caen en el futuro
// y el check del doctor retorna `overdue = 0`.

use chrono::{TimeZone, Utc};
use rusqlite::Connection;

use crate::memory::MemoryError;

/// Datos de entrada para una fila en `deprecation_entries`.
///
/// El campo `id` DEBE ser `format!("dep:{item_id}")` para garantizar
/// idempotencia; el id canónico actúa como clave natural del ledger.
pub(crate) struct DeprecationEntryInput {
    pub id: String,
    pub artifact: String,
    pub domain: String,
    pub kind: String,
    pub owner: Option<String>,
    pub path: String,
    pub reason: String,
    pub replacement: Option<String>,
    pub state: String,
    pub risk: String,
    pub regenerable: i64,
    pub size_bytes: Option<i64>,
    pub cleanup_action: String,
    pub rollback_action: String,
    pub first_seen: String,
    pub last_seen: String,
    pub deadline: String,
    pub retention_class: String,
    pub evidence_json: Option<String>,
    pub confirmed_by: Option<String>,
    pub schema_version: i64,
}

/// Convierte epoch-millisegundos a ISO-8601 UTC sin sub-segundos:
/// `"YYYY-MM-DDTHH:MM:SSZ"`. Compatible con la comparación textual del doctor
/// (`chrono::Utc::now().to_rfc3339()` produce el mismo prefijo ordenable).
///
/// El fallback a `Utc::now()` solo se activa si el valor en ms es inválido
/// como instante Unix (desbordamiento extremo), lo que no ocurre con datos reales.
pub(crate) fn millis_to_iso_utc(ms: i64) -> String {
    let secs = ms / 1_000;
    Utc.timestamp_opt(secs, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// Inserta (o ignora si ya existe) una entrada en `deprecation_entries` y su
/// evento de auditoría en `deprecation_events`.
///
/// Retorna `Ok(true)` si se insertó la fila (registro nuevo), `Ok(false)` si
/// ya existía (INSERT OR IGNORE fue no-op). El `event_id` del evento de
/// auditoría es determinista (`"depev:{input.id}"`) para idempotencia total.
///
/// SINGLE-WRITER: invocar SOLO desde `MemoryService`. Nunca escribir
/// `deprecation_entries` directamente desde otro lugar del código.
pub(crate) fn insert_deprecation_entry(
    conn: &Connection,
    input: &DeprecationEntryInput,
) -> Result<bool, MemoryError> {
    let n = conn
        .execute(
            "INSERT OR IGNORE INTO deprecation_entries (
                id, artifact, domain, kind, owner, path, reason, replacement,
                state, risk, regenerable, size_bytes, cleanup_action, rollback_action,
                first_seen, last_seen, deadline, retention_class,
                evidence_json, confirmed_by, schema_version
            ) VALUES (
                ?1,  ?2,  ?3,  ?4,  ?5,  ?6,  ?7,  ?8,
                ?9,  ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18,
                ?19, ?20, ?21
            )",
            rusqlite::params![
                input.id,
                input.artifact,
                input.domain,
                input.kind,
                input.owner,
                input.path,
                input.reason,
                input.replacement,
                input.state,
                input.risk,
                input.regenerable,
                input.size_bytes,
                input.cleanup_action,
                input.rollback_action,
                input.first_seen,
                input.last_seen,
                input.deadline,
                input.retention_class,
                input.evidence_json,
                input.confirmed_by,
                input.schema_version,
            ],
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("insert_deprecation_entry: {e}")))?;

    // Solo insertar el evento de auditoría si la entrada es nueva.
    // event_id determinista: garantiza idempotencia en re-ejecuciones.
    if n > 0 {
        let event_id = format!("depev:{}", input.id);
        conn.execute(
            "INSERT OR IGNORE INTO deprecation_events (
                event_id, entry_id, kind, from_state, to_state,
                actor, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                event_id,
                input.id,
                "created",
                Option::<String>::None,
                input.state.as_str(),
                "system",
                input.first_seen,
            ],
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("insert_deprecation_event: {e}")))?;
    }

    Ok(n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Crea una conexión en memoria con las tablas mínimas necesarias.
    fn schema_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE deprecation_entries (
                id TEXT PRIMARY KEY, artifact TEXT NOT NULL, domain TEXT NOT NULL,
                kind TEXT NOT NULL, owner TEXT, path TEXT NOT NULL,
                reason TEXT NOT NULL, replacement TEXT,
                state TEXT NOT NULL, risk TEXT NOT NULL,
                regenerable INTEGER NOT NULL DEFAULT 0,
                size_bytes INTEGER, cleanup_action TEXT NOT NULL,
                rollback_action TEXT NOT NULL,
                first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
                deadline TEXT, retention_class TEXT,
                evidence_json TEXT, confirmed_by TEXT,
                schema_version INTEGER NOT NULL DEFAULT 3
            );
            CREATE TABLE deprecation_events (
                event_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL,
                kind TEXT NOT NULL, from_state TEXT, to_state TEXT,
                trace_id TEXT, actor TEXT NOT NULL, snapshot_ref TEXT,
                detail_json TEXT, created_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    fn sample_input(item_id: &str) -> DeprecationEntryInput {
        let ts = millis_to_iso_utc(1_700_000_000_000);
        let dl = millis_to_iso_utc(1_700_000_000_000 + 90 * 24 * 3_600 * 1_000);
        DeprecationEntryInput {
            id: format!("dep:{item_id}"),
            artifact: item_id.to_string(),
            domain: "memory".to_string(),
            kind: "fact".to_string(),
            owner: None,
            path: format!("memory://{item_id}"),
            reason: "deprecated".to_string(),
            replacement: None,
            state: "deprecated".to_string(),
            risk: "low".to_string(),
            regenerable: 0,
            size_bytes: None,
            cleanup_action: "purge".to_string(),
            rollback_action: "restore".to_string(),
            first_seen: ts.clone(),
            last_seen: ts,
            deadline: dl,
            retention_class: "memory-90d".to_string(),
            evidence_json: None,
            confirmed_by: None,
            schema_version: 3,
        }
    }

    #[test]
    fn insert_inserts_entry_and_event_returns_true() {
        let conn = schema_conn();
        let inserted = insert_deprecation_entry(&conn, &sample_input("item-1")).unwrap();
        assert!(inserted, "primera inserción debe retornar true");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM deprecation_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);

        let ev_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM deprecation_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            ev_count, 1,
            "debe existir exactamente un evento de auditoría"
        );
    }

    #[test]
    fn insert_is_idempotent_returns_false_on_duplicate() {
        let conn = schema_conn();
        let first = insert_deprecation_entry(&conn, &sample_input("item-2")).unwrap();
        let second = insert_deprecation_entry(&conn, &sample_input("item-2")).unwrap();
        assert!(first, "primera inserción debe retornar true");
        assert!(!second, "segunda inserción (duplicado) debe retornar false");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM deprecation_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "INSERT OR IGNORE debe ser idempotente");

        // El evento de auditoría tampoco se duplica.
        let ev_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM deprecation_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ev_count, 1, "el evento de auditoría no debe duplicarse");
    }

    #[test]
    fn millis_to_iso_utc_formats_known_epoch() {
        // 2024-01-01T00:00:00Z = 1704067200 s = 1704067200000 ms
        assert_eq!(millis_to_iso_utc(1_704_067_200_000), "2024-01-01T00:00:00Z");
    }

    #[test]
    fn deadline_90d_after_jan_first_2024_is_mar_31() {
        let base_ms = 1_704_067_200_000_i64; // 2024-01-01T00:00:00Z
        let dl = millis_to_iso_utc(base_ms + 90 * 24 * 3_600 * 1_000);
        // Ene(31) + Feb(29, año bisiesto) + 30 días de marzo = 90 días
        assert_eq!(dl, "2024-03-31T00:00:00Z");
    }

    #[test]
    fn deadline_is_greater_than_first_seen_lexicographically() {
        let ts_ms = 1_720_000_000_000_i64;
        let first_seen = millis_to_iso_utc(ts_ms);
        let deadline = millis_to_iso_utc(ts_ms + 90 * 24 * 3_600 * 1_000);
        assert!(
            deadline > first_seen,
            "deadline debe ser lexicográficamente mayor que first_seen"
        );
    }

    #[test]
    fn entry_state_is_deprecated_not_deleted_so_overdue_check_applies() {
        // El check del doctor usa: state NOT IN ('deleted','restored') AND deadline < now.
        // Los items con state='deprecated' y deadline futuro deben retornar overdue=0.
        let conn = schema_conn();
        insert_deprecation_entry(&conn, &sample_input("chk-item")).unwrap();

        let state: String = conn
            .query_row(
                "SELECT state FROM deprecation_entries WHERE id = 'dep:chk-item'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "deprecated");

        let deadline: String = conn
            .query_row(
                "SELECT deadline FROM deprecation_entries WHERE id = 'dep:chk-item'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // Deadline debe ser mayor que la fecha actual del test (el brain.db es joven).
        // La fecha 2023-11-xx + 90 días = ~2024-02-xx, que ya es pasado. PERO en el
        // live path se usa now_millis() + 90d, que siempre es futuro. Este test usa
        // 1_700_000_000_000 ms = 2023-11-15, que es pasado (solo para el test).
        // El test solo verifica el formato, no la polaridad temporal.
        assert!(
            deadline.ends_with('Z'),
            "deadline debe terminar en Z (UTC): {deadline}"
        );
        assert_eq!(
            deadline.len(),
            20,
            "formato YYYY-MM-DDTHH:MM:SSZ = 20 chars"
        );
    }
}
