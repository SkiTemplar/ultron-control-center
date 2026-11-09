// ULTRON Control Center — `ultron-memory doctor` (Control Plane · OLA M)
//
// Read-only health command. Operates the system without guessing: each check is
// a pure `fn() -> DoctorCheck` that only READS (brain.db, Qdrant REST, disk, fs)
// and never mutates. Reuses the canonical `Severity` (Ok < Warn < Error) and the
// `{ checks, max_severity }` report shape from `diagnostics_native.rs` instead of
// redefining them (SPEC-CONTROL-PLANE §2, reuse-over-rebuild).
//
// `max_severity = checks.map(severity).max()`; the process exit code mirrors it
// (0=ok, 1=warn, 2=error) so CI/smoke gates can branch on `ultron-memory doctor`.

use serde::Serialize;

use crate::diagnostics_native::Severity;

use super::sqlite_store;

// Checks de operación (inbox sin juzgar, gc semanal): fichero aparte para no
// pasar este de las 800 líneas; submódulo para reutilizar los constructores.
#[path = "doctor_ops.rs"]
mod ops;

// Checks del índice denso (qdrant, reconcile) y del recall (evals): ficheros
// aparte por el mismo motivo.
#[path = "doctor_dense.rs"]
mod dense;
#[path = "doctor_eval_gate.rs"]
mod eval_gate;
// Check `versions` (stale y binario compilado con el árbol sucio).
#[path = "doctor_versions.rs"]
mod versions;

/// One diagnostic check outcome. `data` carries machine-readable specifics
/// (counts, dims, paths) for the UI Health card / `--json` consumers.
#[derive(Debug, Clone, Serialize)]
pub struct DoctorCheck {
    pub name: String,
    pub severity: Severity,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl DoctorCheck {
    fn ok(name: &str, detail: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            name: name.into(),
            severity: Severity::Ok,
            detail: detail.into(),
            data: Some(data),
        }
    }
    fn warn(name: &str, detail: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            name: name.into(),
            severity: Severity::Warn,
            detail: detail.into(),
            data: Some(data),
        }
    }
    fn error(name: &str, detail: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            name: name.into(),
            severity: Severity::Error,
            detail: detail.into(),
            data: Some(data),
        }
    }
}

/// The aggregate doctor report. `max_severity` is the max over all checks.
#[derive(Debug, Clone, Serialize)]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
    pub max_severity: Severity,
    pub generated_at: String,
    /// Stable shape marker for hook/UI consumers.
    pub schema: &'static str,
}

impl DoctorReport {
    /// Process exit code reflecting `max_severity` (A12): 0=ok, 1=warn, 2=error.
    #[must_use]
    pub fn exit_code(&self) -> i32 {
        match self.max_severity {
            Severity::Ok => 0,
            Severity::Warn => 1,
            Severity::Error => 2,
        }
    }
}

/// Run every read-only check and assemble the report. Never mutates state, never
/// panics (each check internally degrades to Warn/Error on failure).
#[must_use]
pub fn run_doctor() -> DoctorReport {
    let mut checks = vec![check_sqlite(), check_fts()];
    if crate::qdrant::dense_enabled() {
        checks.extend(dense::check_qdrant_collections());
        checks.push(dense::check_reconcile());
    } else {
        checks.push(dense::dense_off_check());
    }
    checks.push(ops::check_inbox());
    checks.push(ops::check_gc());
    checks.push(eval_gate::check_evals());
    checks.push(check_sidecars());
    checks.push(versions::check_running_binary());
    checks.push(check_disk());
    checks.push(check_deprecation_deadlines());

    let max_severity = checks
        .iter()
        .map(|c| c.severity)
        .max()
        .unwrap_or(Severity::Ok);

    DoctorReport {
        checks,
        max_severity,
        generated_at: chrono::Utc::now().to_rfc3339(),
        schema: "doctor.v1",
    }
}

// ---------------------------------------------------------------------------
// Individual checks (read-only)
// ---------------------------------------------------------------------------

/// True when a rusqlite error is a transient lock/contention (SQLITE_BUSY /
/// SQLITE_LOCKED), not corruption. Such errors must NOT be reported as Error: the
/// doctor exit code gates CI, and another process briefly holding brain.db is a
/// retry-later condition, not a broken database.
fn is_sqlite_busy(err: &rusqlite::Error) -> bool {
    use rusqlite::ffi::ErrorCode;
    if let rusqlite::Error::SqliteFailure(e, msg) = err {
        if matches!(e.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) {
            return true;
        }
        if let Some(m) = msg {
            let ml = m.to_ascii_lowercase();
            if ml.contains("locked") || ml.contains("busy") {
                return true;
            }
        }
    }
    // Defensive: any other variant whose Display mentions a lock.
    let s = err.to_string().to_ascii_lowercase();
    s.contains("database is locked") || s.contains("database is busy")
}

/// `brain.db` opens, `integrity_check=ok`, `user_version` is in the expected range,
/// and the active/candidate counts are readable.
fn check_sqlite() -> DoctorCheck {
    let conn = match sqlite_store::open_conn() {
        Ok(c) => c,
        Err(e) => {
            return DoctorCheck::error(
                "sqlite",
                format!("brain.db no abre: {e}"),
                serde_json::json!({ "open": false }),
            );
        }
    };
    // `PRAGMA integrity_check` takes a read-lock that contends with any writer
    // (sidecar/hook) touching brain.db. busy_timeout lets a transient lock clear
    // instead of failing instantly; if it still fails as BUSY/LOCKED we degrade to
    // Warn (contention) rather than Error (corruption) — the latter made the gate
    // flaky under concurrency (exit 2 indistinguishable from real corruption).
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));

    let integrity: String = match conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)) {
        Ok(s) => s,
        Err(e) if is_sqlite_busy(&e) => {
            return DoctorCheck::warn(
                "sqlite",
                "brain.db ocupada por otro proceso (lock transitorio); reintenta",
                serde_json::json!({ "locked": true }),
            );
        }
        Err(e) => format!("error: {e}"),
    };
    let user_version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(-1);
    let active: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_items WHERE status='active'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    let data = serde_json::json!({
        "integrity": integrity,
        "user_version": user_version,
        "active": active,
    });
    if integrity != "ok" {
        return DoctorCheck::error("sqlite", format!("integrity_check={integrity}"), data);
    }
    // v6 = backfill de valid_from (2026-10-26), la última migración; versiones menores son
    // DBs aún no migradas (la migración corre en el próximo open_conn del writer).
    if !(2..=sqlite_store::LATEST_USER_VERSION).contains(&user_version) {
        return DoctorCheck::warn(
            "sqlite",
            format!(
                "user_version inesperado: {user_version} (esperado 2..={})",
                sqlite_store::LATEST_USER_VERSION
            ),
            data,
        );
    }
    DoctorCheck::ok(
        "sqlite",
        format!("ok · user_version={user_version} · {active} active"),
        data,
    )
}

/// El indice FTS5 (`memory_items_fts`, contenido externo) sigue a `memory_items`.
/// Desincronizado, MATCH falla con "missing row N from content table" y el
/// recall sparse devuelve basura aunque `integrity_check` de SQLite diga ok
/// (2026-09-22: 10.205 filas en el indice frente a 4.390 items; el recall no
/// encontraba ni el titulo exacto de un item recien aprobado). Error cuando la
/// integridad FTS falla; Warn cuando solo difieren los recuentos. Reparacion:
/// `ultron-memory fts-rebuild`.
fn check_fts() -> DoctorCheck {
    let conn = match sqlite_store::open_conn() {
        Ok(c) => c,
        Err(e) => {
            return DoctorCheck::warn(
                "fts",
                format!("no comprobado: brain.db no abre: {e}"),
                serde_json::json!({ "checked": false }),
            );
        }
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
    let st = match sqlite_store::fts_integrity(&conn) {
        Ok(s) => s,
        Err(e) => {
            return DoctorCheck::warn(
                "fts",
                format!("no comprobado: {e}"),
                serde_json::json!({ "checked": false }),
            );
        }
    };
    let data = serde_json::json!({
        "fts_rows": st.fts_rows,
        "item_rows": st.item_rows,
        "integrity_ok": st.integrity_ok,
        "error": st.error,
        "repair": "ultron-memory fts-rebuild",
    });
    if !st.integrity_ok {
        return DoctorCheck::error(
            "fts",
            format!(
                "indice FTS5 desincronizado ({} filas frente a {} items): el recall sparse devuelve basura; ejecuta `ultron-memory fts-rebuild`",
                st.fts_rows, st.item_rows
            ),
            data,
        );
    }
    if st.fts_rows != st.item_rows {
        return DoctorCheck::warn(
            "fts",
            format!(
                "recuentos distintos ({} filas frente a {} items); `ultron-memory fts-rebuild`",
                st.fts_rows, st.item_rows
            ),
            data,
        );
    }
    DoctorCheck::ok("fts", format!("in_sync · {} filas", st.fts_rows), data)
}

/// The `ultron-memory` sidecar must exist under `~/.ultron/bin/` and be non-empty.
fn check_sidecars() -> DoctorCheck {
    let bin = ultron_home().map(|h| h.join("bin"));
    let Some(bin) = bin else {
        return DoctorCheck::warn(
            "sidecars",
            "no HOME para localizar bin/",
            serde_json::json!({}),
        );
    };
    let want = ["ultron-memory.exe"];
    let mut missing = Vec::new();
    for name in want {
        let p = bin.join(name);
        let ok = std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false);
        if !ok {
            missing.push(name);
        }
    }
    let data = serde_json::json!({ "bin": bin.to_string_lossy(), "missing": missing });
    if missing.is_empty() {
        DoctorCheck::ok("sidecars", "ultron-memory presente", data)
    } else {
        DoctorCheck::error("sidecars", format!("ausente(s): {missing:?}"), data)
    }
}

/// Free space on the volume holding `~/.ultron`. Warn < 5 GB, Error < 1 GB.
fn check_disk() -> DoctorCheck {
    use sysinfo::Disks;
    let home = ultron_home();
    let disks = Disks::new_with_refreshed_list();
    // Pick the mount with the longest prefix match of the home path; fall back
    // to the disk with the least free space (most relevant signal).
    let home_str = home
        .as_ref()
        .map(|h| h.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mut best: Option<(usize, u64)> = None;
    for d in disks.list() {
        let mp = d.mount_point().to_string_lossy().to_lowercase();
        let score = if home_str.starts_with(&mp) {
            mp.len()
        } else {
            0
        };
        let free = d.available_space();
        match best {
            Some((s, _)) if s >= score => {}
            _ => best = Some((score, free)),
        }
    }
    let free_gb = best.map(|(_, f)| f as f64 / 1_073_741_824.0).unwrap_or(0.0);
    let data = serde_json::json!({ "free_gb": (free_gb * 100.0).round() / 100.0 });
    if free_gb < 1.0 {
        DoctorCheck::error("disk", format!("libre {free_gb:.1} GB (<1)"), data)
    } else if free_gb < 5.0 {
        DoctorCheck::warn("disk", format!("libre {free_gb:.1} GB (<5)"), data)
    } else {
        DoctorCheck::ok("disk", format!("libre {free_gb:.1} GB"), data)
    }
}

/// Días que un deadline puede llevar vencido sin que sea un problema: la cadencia
/// del GC semanal (`INTERVAL_MS` de `hooks/scripts/memory-gc.js`) más 3 de margen,
/// para no avisar si el GC cae en la primera sesión tras un fin de semana parado.
const DEADLINE_GRACE_DAYS: i64 = 10;

/// `(vencidos, vencidos antes de `late_before`)` entre las entradas abiertas.
///
/// La comparación es textual: los deadlines se escriben con `millis_to_iso_utc`
/// (`YYYY-MM-DDTHH:MM:SSZ`, verificado 2026-10-23: 3.143 de 3.143 filas), el mismo
/// formato de los dos cortes, así que el orden es el cronológico. Las entradas
/// cerradas (`deleted`/`restored`/`archived`) no cuentan aunque su deadline haya
/// pasado.
fn count_overdue_deadlines(
    conn: &rusqlite::Connection,
    now: &str,
    late_before: &str,
) -> rusqlite::Result<(i64, i64)> {
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN deadline < ?2 THEN 1 ELSE 0 END), 0)
         FROM deprecation_entries
         WHERE deadline IS NOT NULL AND deadline < ?1
           AND state NOT IN ('deleted','restored','archived')",
        [now, late_before],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

/// PURA: veredicto de los deadlines. Un vencido dentro de la cadencia es el estado
/// normal entre dos pasadas del GC (son copias sustituidas que archiva él) y da Ok:
/// el aviso con `overdue > 0` salía casi siempre y tapaba los reales. Solo avisa lo
/// que el GC tendría que haber archivado ya.
fn deadlines_verdict(overdue: i64, late: i64) -> DoctorCheck {
    let data = serde_json::json!({
        "overdue": overdue,
        "late": late,
        "grace_days": DEADLINE_GRACE_DAYS,
        "repair": "ultron-memory deprecations apply",
    });
    if late > 0 {
        return DoctorCheck::warn(
            "deprecation_deadlines",
            format!(
                "{late} deadline(s) vencido(s) hace más de {DEADLINE_GRACE_DAYS} días: el GC \
                 semanal no los ha archivado, revisa el check gc"
            ),
            data,
        );
    }
    if overdue > 0 {
        return DoctorCheck::ok(
            "deprecation_deadlines",
            format!("{overdue} deadline(s) vencido(s) a la espera del GC semanal"),
            data,
        );
    }
    DoctorCheck::ok("deprecation_deadlines", "sin deadlines vencidos", data)
}

/// Deprecation registry deadlines (handoff from SPEC-MAINTENANCE-CLI A12).
fn check_deprecation_deadlines() -> DoctorCheck {
    let conn = match sqlite_store::open_conn() {
        Ok(c) => c,
        Err(_) => {
            return DoctorCheck::ok(
                "deprecation_deadlines",
                "registry no disponible (informativo)",
                serde_json::json!({}),
            )
        }
    };
    const ISO: &str = "%Y-%m-%dT%H:%M:%SZ";
    let now = chrono::Utc::now();
    let late_before = now - chrono::Duration::days(DEADLINE_GRACE_DAYS);
    match count_overdue_deadlines(
        &conn,
        &now.format(ISO).to_string(),
        &late_before.format(ISO).to_string(),
    ) {
        Ok((overdue, late)) => deadlines_verdict(overdue, late),
        Err(e) => DoctorCheck::warn(
            "deprecation_deadlines",
            format!("no comprobado: {e}"),
            serde_json::json!({ "checked": false }),
        ),
    }
}

fn ultron_home() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Auditoría 2026-11-01: 19 copias sustituidas a la espera del GC semanal daban
    // un warn permanente que tapaba los reales.
    #[test]
    fn deadlines_vencidos_a_la_espera_del_gc_no_avisan() {
        let check = deadlines_verdict(19, 0);
        assert_eq!(check.severity, Severity::Ok);
        assert!(check.detail.contains("19"), "{}", check.detail);
        let data = check.data.unwrap();
        assert_eq!(data["overdue"], 19);
        assert_eq!(data["repair"], "ultron-memory deprecations apply");

        assert_eq!(deadlines_verdict(0, 0).severity, Severity::Ok);
    }

    // Caso negativo: lo que pasa de la cadencia sí es un GC que no está corriendo.
    #[test]
    fn deadlines_que_pasan_de_la_cadencia_avisan() {
        let check = deadlines_verdict(19, 1);
        assert_eq!(check.severity, Severity::Warn);
        assert!(check.detail.contains("gc"), "{}", check.detail);
    }

    #[test]
    fn el_recuento_separa_los_tardios_y_excluye_las_entradas_cerradas() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE deprecation_entries (deadline TEXT, state TEXT);
             INSERT INTO deprecation_entries VALUES
               ('2026-10-01T00:00:00Z', 'deprecated'),
               ('2026-10-20T00:00:00Z', 'deprecated'),
               ('2026-10-30T00:00:00Z', 'deprecated'),
               ('2026-12-01T00:00:00Z', 'deprecated'),
               (NULL, 'deprecated'),
               ('2026-01-01T00:00:00Z', 'archived'),
               ('2026-01-01T00:00:00Z', 'deleted'),
               ('2026-01-01T00:00:00Z', 'restored');",
        )
        .unwrap();
        let counts =
            count_overdue_deadlines(&conn, "2026-11-01T00:00:00Z", "2026-10-22T00:00:00Z").unwrap();
        assert_eq!(counts, (3, 2));
    }

    #[test]
    fn exit_code_reflects_max_severity() {
        let mk = |s: Severity| DoctorReport {
            checks: vec![],
            max_severity: s,
            generated_at: String::new(),
            schema: "doctor.v1",
        };
        assert_eq!(mk(Severity::Ok).exit_code(), 0);
        assert_eq!(mk(Severity::Warn).exit_code(), 1);
        assert_eq!(mk(Severity::Error).exit_code(), 2);
    }

    #[test]
    fn check_constructors_set_severity() {
        assert_eq!(
            DoctorCheck::ok("x", "d", serde_json::json!({})).severity,
            Severity::Ok
        );
        assert_eq!(
            DoctorCheck::warn("x", "d", serde_json::json!({})).severity,
            Severity::Warn
        );
        assert_eq!(
            DoctorCheck::error("x", "d", serde_json::json!({})).severity,
            Severity::Error
        );
    }

    #[test]
    fn busy_and_locked_are_contention_not_corruption() {
        // SQLITE_BUSY (5) y SQLITE_LOCKED (6) -> contencion (true).
        let busy = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(5),
            Some("database is locked".to_string()),
        );
        let locked = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(6), None);
        assert!(is_sqlite_busy(&busy), "SQLITE_BUSY debe ser contencion");
        assert!(is_sqlite_busy(&locked), "SQLITE_LOCKED debe ser contencion");
    }

    #[test]
    fn corruption_is_not_classified_as_busy() {
        // Caso negativo: corrupcion real (SQLITE_CORRUPT=11) NO es contencion.
        let corrupt = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(11),
            Some("database disk image is malformed".to_string()),
        );
        assert!(
            !is_sqlite_busy(&corrupt),
            "la corrupcion no debe degradarse a Warn"
        );
        // Un error no-Sqlite tampoco.
        assert!(!is_sqlite_busy(&rusqlite::Error::QueryReturnedNoRows));
    }
}
