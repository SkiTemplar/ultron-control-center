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
    let mut checks = vec![check_sqlite()];
    checks.extend(check_qdrant_collections());
    checks.push(check_reconcile());
    checks.push(check_evals());
    checks.push(check_sidecars());
    checks.push(check_running_binary());
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

/// `brain.db` opens, `integrity_check=ok`, `user_version` is the expected 2 or 3,
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
    // v5 = retirada del codegraph interno (2026-07-02); versiones menores son
    // DBs aún no migradas (la migración corre en el próximo open_conn del writer).
    if !(2..=5).contains(&user_version) {
        return DoctorCheck::warn(
            "sqlite",
            format!("user_version inesperado: {user_version} (esperado 2..=5)"),
            data,
        );
    }
    DoctorCheck::ok(
        "sqlite",
        format!("ok · user_version={user_version} · {active} active"),
        data,
    )
}

/// Per-collection Qdrant probe (SPEC-CONTROL-PLANE §2, A2). One check per live
/// canonical collection: ultron_memory/ultron_catalog (1024d E5), ultron_skills
/// (768d mpnet) and ultron_mcp_mirror (1024d).
fn check_qdrant_collections() -> Vec<DoctorCheck> {
    #[cfg(feature = "qdrant")]
    {
        qdrant_probe::run()
    }
    #[cfg(not(feature = "qdrant"))]
    {
        vec![DoctorCheck::warn(
            "qdrant",
            "compilado sin feature qdrant; sondeo de colecciones omitido",
            serde_json::json!({ "feature": false }),
        )]
    }
}

/// SQLite<->Qdrant drift via the canonical `reconcile_check` (the same call the
/// `reconcile` subcommand uses). Green when `in_sync` and counts match.
fn check_reconcile() -> DoctorCheck {
    match super::qdrant_index::reconcile_check() {
        Ok(r) => {
            let data = serde_json::json!({
                "in_sync": r.in_sync,
                "sqlite_active": r.count_sqlite_active,
                "qdrant_points": r.count_qdrant_points,
                "missing": r.missing_count,
                "orphan": r.orphan_count,
            });
            if r.in_sync {
                DoctorCheck::ok(
                    "reconcile",
                    format!(
                        "in_sync · {}={}",
                        r.count_sqlite_active, r.count_qdrant_points
                    ),
                    data,
                )
            } else {
                let drift = r.missing_count + r.orphan_count;
                let detail = format!(
                    "drift={drift} (missing={}, orphan={})",
                    r.missing_count, r.orphan_count
                );
                // Small drift = Warn; large = Error (index reconstructable via reindex).
                if drift <= 5 {
                    DoctorCheck::warn("reconcile", detail, data)
                } else {
                    DoctorCheck::error("reconcile", detail, data)
                }
            }
        }
        Err(e) => DoctorCheck::warn(
            "reconcile",
            format!("no disponible: {e}"),
            serde_json::json!({ "available": false }),
        ),
    }
}

/// Recall quality + security gate. (2026-08-10, decisión del usuario: "el oráculo")
/// El VEREDICTO lo decide el ORÁCULO ETIQUETADO (golden_labels.json, 29 queries
/// curadas a mano) medido por el HOT PATH (rerank=false ⇒ fanout corto + sin
/// cross-encoder — lo que paga CADA prompt del hook) — el set generado (26
/// queries, stale desde jul-26) daba ERROR permanente (0.36) mientras el
/// oráculo real estaba en 0.81 por el path de calidad: un gate que llora
/// siempre es un gate roto. El smoke sintético queda SOLO como gate de leaks.
/// Bandas de REGRESIÓN calibradas al baseline hot-path medido 2026-08-10
/// (0.498 sano; el path de calidad da 0.810): warn <0.42 (≈2 queries por
/// debajo del baseline) · error <0.30. El 0.95 aspiracional del GOAL lo vigila
/// Kirkardo cat1, no este check.
fn evals_verdict(
    golden_recall: f32,
    golden_degraded: bool,
    golden_note: &str,
    smoke_recall: f32,
    secret_leaks: usize,
    stale_leaks: usize,
) -> DoctorCheck {
    let data = serde_json::json!({
        "recall_at_8_golden": golden_recall,
        "oracle": "labeled_no_rerank",
        "golden_degraded": golden_degraded,
        "golden_note": golden_note,
        "recall_at_8_smoke": smoke_recall,
        "secret_leak": secret_leaks,
        "stale_leak": stale_leaks,
    });
    if secret_leaks > 0 || stale_leaks > 0 {
        return DoctorCheck::error(
            "evals",
            format!("LEAK · secret={secret_leaks} stale={stale_leaks}"),
            data,
        );
    }
    if golden_degraded {
        // (2026-08-10) la CAUSA viaja en el detail: "infra_down: Qdrant..." vs
        // "set ausente" dejan de ser indistinguibles (audit 08-09 punto 3).
        return DoctorCheck::warn(
            "evals",
            format!("golden no disponible · {golden_note} · smoke={smoke_recall:.3}"),
            data,
        );
    }
    let detail = format!(
        "oráculo recall@8={golden_recall:.3} (hot path, sin rerank) · smoke={smoke_recall:.3} · leaks=0"
    );
    if golden_recall < 0.30 {
        DoctorCheck::error("evals", detail, data)
    } else if golden_recall < 0.42 {
        DoctorCheck::warn("evals", detail, data)
    } else {
        DoctorCheck::ok("evals", detail, data)
    }
}

fn check_evals() -> DoctorCheck {
    let smoke = super::evals::run(None, 8);
    // (2026-08-10) El veredicto lo da el ORÁCULO ETIQUETADO (29 queries, el
    // medidor honesto), no el set generado stale. rerank=false: el doctor es
    // fontanería (¿el pipeline recupera?), no el medidor de calidad — con
    // cross-encoder tardaba ~62s y reventaba los timeouts del harness.
    // Knobs EXPLÍCITOS (dense=true, rerank=false): sin depender del env.
    let Some(labels_path) = super::evals::golden_labels_path() else {
        return evals_verdict(
            0.0,
            true,
            "no HOME dir; cannot locate golden_labels.json",
            smoke.recall_at_k,
            smoke.secret_leak_count,
            smoke.stale_leak_count,
        );
    };
    let golden =
        super::evals::run_labeled_golden_with(&labels_path.to_string_lossy(), 8, true, false);
    evals_verdict(
        golden.aggregate.recall_at_k as f32,
        golden.degraded,
        &golden.note,
        smoke.recall_at_k,
        smoke.secret_leak_count,
        smoke.stale_leak_count,
    )
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

/// Anti stale-binary (k+6): warn when the deployed `bin/ultron-memory.exe` is
/// NEWER than the binary actually running — a recurring "no se aplicó" footgun.
fn check_running_binary() -> DoctorCheck {
    let running = std::env::current_exe().ok();
    let deployed = ultron_home().map(|h| h.join("bin").join("ultron-memory.exe"));
    let (Some(running), Some(deployed)) = (running, deployed) else {
        return DoctorCheck::ok(
            "versions",
            "no determinable (informativo)",
            serde_json::json!({ "determinable": false }),
        );
    };
    let mt = |p: &std::path::Path| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
    };
    let (rm, dm) = (mt(&running), mt(&deployed));
    let data = serde_json::json!({
        "running": running.to_string_lossy(),
        "deployed": deployed.to_string_lossy(),
        "running_mtime": rm,
        "deployed_mtime": dm,
    });
    match (rm, dm) {
        (Some(rm), Some(dm)) if dm > rm + 5 => DoctorCheck::warn(
            "versions",
            "el binario desplegado es mas nuevo que el que corre (posible stale)",
            data,
        ),
        _ => DoctorCheck::ok(
            "versions",
            "binario en uso == desplegado (o no aplica)",
            data,
        ),
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

/// Deprecation registry deadlines (handoff from SPEC-MAINTENANCE-CLI A12): any
/// entry whose ISO `deadline` is in the past is a Warn (overdue cleanup).
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
    let now = chrono::Utc::now().to_rfc3339();
    let overdue: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM deprecation_entries
             WHERE deadline IS NOT NULL AND deadline < ?1
               AND state NOT IN ('deleted','restored')",
            [&now],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let data = serde_json::json!({ "overdue": overdue });
    if overdue > 0 {
        DoctorCheck::warn(
            "deprecation_deadlines",
            format!("{overdue} deadline(s) vencido(s)"),
            data,
        )
    } else {
        DoctorCheck::ok("deprecation_deadlines", "sin deadlines vencidos", data)
    }
}

fn ultron_home() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron"))
}

// ---------------------------------------------------------------------------
// Qdrant per-collection probe (feature-gated; the sidecar builds with `qdrant`)
// ---------------------------------------------------------------------------

#[cfg(feature = "qdrant")]
mod qdrant_probe {
    use super::DoctorCheck;
    use serde_json::Value;

    fn base() -> String {
        std::env::var("QDRANT_URL").unwrap_or_else(|_| "http://127.0.0.1:6333".to_string())
    }

    /// Expected canonical collections: name -> (expected_dim, write_dead).
    ///
    /// ultron_sessions (384d, write-dead 72 pts) RETIRADA 2026-06-20: sus lectores
    /// eran codigo muerto (recall_hybrid deprecado + memory_graph des-registrado) y
    /// los datos ya viven en brain.db. ultron_skills (mpnet 768d) y ultron_mcp_mirror
    /// (E5 1024d) ANADIDAS: el doctor no las cubria (gap real de cat1.4).
    const EXPECTED: &[(&str, u64, bool)] = &[
        ("ultron_memory", 1024, false),
        ("ultron_catalog", 1024, false),
        ("ultron_skills", 768, false),
        ("ultron_mcp_mirror", 1024, false),
    ];

    pub fn run() -> Vec<DoctorCheck> {
        let client = match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            // Fail-fast: con Qdrant caído el probe no puede colgar el doctor
            // 5s por colección (audit 08-09: doctor de 2min con Qdrant down).
            .connect_timeout(std::time::Duration::from_secs(1))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                return vec![DoctorCheck::warn(
                    "qdrant",
                    format!("http client: {e}"),
                    serde_json::json!({}),
                )]
            }
        };
        let base = base();
        // List existing collections first (read-only GET).
        let existing: Vec<String> = match client.get(format!("{base}/collections")).send() {
            Ok(resp) => resp
                .json::<Value>()
                .ok()
                .and_then(|v| {
                    v.get("result")?.get("collections")?.as_array().map(|arr| {
                        arr.iter()
                            .filter_map(|c| c.get("name")?.as_str().map(String::from))
                            .collect()
                    })
                })
                .unwrap_or_default(),
            Err(e) => {
                return vec![DoctorCheck::error(
                    "qdrant",
                    format!("inalcanzable: {e}"),
                    serde_json::json!({ "base": base }),
                )]
            }
        };

        let mut out = Vec::new();
        for &(name, want_dim, write_dead) in EXPECTED {
            if !existing.iter().any(|c| c == name) {
                // Missing canonical collection: ultron_memory missing is Error;
                // the rest (catalog/skills/mcp_mirror) are Warn.
                let sev_error = name == "ultron_memory";
                let detail = format!("coleccion '{name}' ausente");
                out.push(if sev_error {
                    DoctorCheck::error(&format!("qdrant_{name}"), detail, serde_json::json!({}))
                } else {
                    DoctorCheck::warn(&format!("qdrant_{name}"), detail, serde_json::json!({}))
                });
                continue;
            }
            out.push(probe_one(&client, &base, name, want_dim, write_dead));
        }
        out
    }

    fn probe_one(
        client: &reqwest::blocking::Client,
        base: &str,
        name: &str,
        want_dim: u64,
        write_dead: bool,
    ) -> DoctorCheck {
        let v: Value = match client.get(format!("{base}/collections/{name}")).send() {
            Ok(r) => r.json().unwrap_or(Value::Null),
            Err(e) => {
                return DoctorCheck::error(
                    &format!("qdrant_{name}"),
                    format!("GET coleccion: {e}"),
                    serde_json::json!({}),
                )
            }
        };
        let result = v.get("result");
        let status = result
            .and_then(|r| r.get("status"))
            .and_then(|s| s.as_str())
            .unwrap_or("unknown")
            .to_string();
        let points = result
            .and_then(|r| r.get("points_count"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        // dim lives under config.params.vectors.size (single unnamed vector).
        let dim = result
            .and_then(|r| r.get("config"))
            .and_then(|c| c.get("params"))
            .and_then(|p| p.get("vectors"))
            .and_then(|vec| vec.get("size").or_else(|| vec.get("dense")?.get("size")))
            .and_then(serde_json::Value::as_u64);
        let data = serde_json::json!({
            "status": status, "points": points, "dim": dim, "want_dim": want_dim,
            "write_dead": write_dead,
        });
        let cname = format!("qdrant_{name}");
        if let Some(d) = dim {
            if d != want_dim {
                return DoctorCheck::error(&cname, format!("dim {d} != {want_dim} esperado"), data);
            }
        }
        if status != "green" {
            return DoctorCheck::warn(&cname, format!("status={status}"), data);
        }
        let suffix = if write_dead { " (write-dead)" } else { "" };
        DoctorCheck::ok(&cname, format!("{points} pts · {want_dim}d{suffix}"), data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

#[cfg(test)]
mod evals_verdict_tests {
    use super::*;

    // (unificar medidores, 2026-07-02) — el veredicto de 'evals' se decide por
    // el GOLDEN (el honesto), no por el smoke sintetico (que dio el "1.000"
    // que alimento el era-claim '9.73 techo honesto').
    #[test]
    fn verdict_bands_on_golden_not_smoke() {
        // (2026-08-10) Bandas calibradas al oráculo etiquetado por el HOT PATH
        // (baseline sano medido: 0.498): ok >=0.42 · warn <0.42 · error <0.30.
        // oráculo sano -> ok, y el detail NOMBRA ambos medidores.
        let c = evals_verdict(0.498, false, "", 1.0, 0, 0);
        assert_eq!(c.severity, Severity::Ok, "detail={}", c.detail);
        assert!(c.detail.contains("oráculo"), "detail={}", c.detail);
        assert!(c.detail.contains("smoke"), "detail={}", c.detail);

        // regresion real -> warn/error aunque el smoke de 1.0.
        let c = evals_verdict(0.40, false, "", 1.0, 0, 0);
        assert_eq!(c.severity, Severity::Warn, "detail={}", c.detail);
        let c = evals_verdict(0.25, false, "", 1.0, 0, 0);
        assert_eq!(c.severity, Severity::Error, "detail={}", c.detail);

        // borde exacto: 0.42 ya es ok (bandas son "<", no "<=").
        let c = evals_verdict(0.42, false, "", 1.0, 0, 0);
        assert_eq!(c.severity, Severity::Ok, "detail={}", c.detail);

        // leaks mandan SIEMPRE (gate de seguridad del smoke).
        let c = evals_verdict(0.498, false, "", 1.0, 1, 0);
        assert_eq!(c.severity, Severity::Error);
        assert!(c.detail.contains("LEAK"));

        // oráculo no disponible (Qdrant caido / set ausente) -> warn declarado,
        // NO un 0.0 tratado como colapso ni un ok fingido.
        let c = evals_verdict(0.0, true, "set ausente", 1.0, 0, 0);
        assert_eq!(c.severity, Severity::Warn, "detail={}", c.detail);
        assert!(
            c.detail.contains("golden no disponible"),
            "detail={}",
            c.detail
        );
    }

    #[test]
    fn verdict_degraded_carries_infra_cause_in_detail() {
        // (2026-08-10, audit 08-09 punto 3) infra caida NO puede ser
        // indistinguible de "set ausente": la causa viaja en el detail.
        let c = evals_verdict(
            0.0,
            true,
            "infra_down: Qdrant no responde /healthz — golden omitido (no es regresión de calidad)",
            1.0,
            0,
            0,
        );
        assert_eq!(c.severity, Severity::Warn, "infra caida = Warn, no Error");
        assert!(c.detail.contains("infra_down"), "detail={}", c.detail);
        // Y el data JSON expone la nota para consumidores maquina (UI Health).
        let note = c
            .data
            .as_ref()
            .and_then(|d| d.get("golden_note"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert!(note.contains("infra_down"), "data.golden_note={note}");
    }
}
