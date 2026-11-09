// memory/doctor_dense.rs — checks de `doctor` sobre el índice denso (Qdrant)
// (submódulo de `doctor.rs`; usa sus constructores de `DoctorCheck`).
//
//   qdrant    — con `ULTRON_DENSE=0` un único check Ok que declara el apagado;
//               con el denso encendido, un check por colección canónica.
//   reconcile — deriva SQLite<->Qdrant (solo con el denso encendido).
//
// Fichero aparte para que `doctor.rs` no pase de las 800 líneas.

use super::DoctorCheck;

/// Con `ULTRON_DENSE=0` Qdrant esta apagado a proposito: sondearlo daba un
/// `error` falso en cada `doctor` y tapaba los errores reales (2026-10-03).
pub(super) fn dense_off_check() -> DoctorCheck {
    DoctorCheck::ok(
        "qdrant",
        "apagado a propósito (ULTRON_DENSE=0): recall solo FTS5; sin sondeo ni reconcile",
        serde_json::json!({ "dense": false }),
    )
}

/// Per-collection Qdrant probe (SPEC-CONTROL-PLANE §2, A2). One check per live
/// canonical collection: ultron_memory/ultron_catalog (1024d E5), ultron_skills
/// (768d mpnet) and ultron_mcp_mirror (1024d).
pub(super) fn check_qdrant_collections() -> Vec<DoctorCheck> {
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
pub(super) fn check_reconcile() -> DoctorCheck {
    match crate::memory::qdrant_index::reconcile_check() {
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
    use crate::diagnostics_native::Severity;

    #[test]
    fn dense_off_is_ok_not_error() {
        // Qdrant apagado a proposito no es una averia: Ok, y lo dice.
        let c = dense_off_check();
        assert_eq!(c.severity, Severity::Ok);
        assert!(c.detail.contains("ULTRON_DENSE=0"), "detail={}", c.detail);
    }
}
