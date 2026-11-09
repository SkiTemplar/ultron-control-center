// memory/doctor_ops.rs — checks de `doctor` sobre la operación de la memoria
// (submódulo de `doctor.rs`; usa sus constructores de `DoctorCheck`).
//
//   inbox — candidatos pendientes que el juez de contradicción no pudo verificar
//           (`unjudged`). Con auto-approve activo, un candidato así no se aprueba
//           nunca: 677 de 677 pendientes sin juzgar entre el 2026-10-02 y el
//           2026-10-17 sin que nada lo dijera (H11).
//   gc    — el mantenimiento semanal (`hooks/scripts/memory-gc.js`) falló 134
//           veces seguidas en silencio entre el 2026-10-02 y el 2026-10-17 (H26).
//           El hook es async y su stdout se descarta: el estado que deja en
//           `.tmp/memory-gc-last.json` es lo único que puede leer otro proceso.
//
// Ambos son de solo lectura, como el resto de `doctor`. La decisión es pura
// (`inbox_verdict`, `gc_verdict`) y se prueba sin brain.db ni HOME.

use super::DoctorCheck;
use crate::memory::sqlite_store;

/// Días sin un gc correcto a partir de los cuales se avisa: dos veces la
/// cadencia semanal del hook.
const GC_STALE_DAYS: i64 = 14;

/// Fallos consecutivos del gc a partir de los cuales se avisa aunque el último
/// éxito sea reciente.
const GC_MAX_FAILS: u64 = 3;

const DAY_MS: i64 = 86_400_000;

/// Recuento del inbox que consume [`inbox_verdict`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct InboxCounts {
    pub pending: i64,
    pub unjudged: i64,
    /// `created_at` (ms) del candidato sin juzgar más antiguo.
    pub oldest_unjudged_ms: Option<i64>,
}

/// Check `inbox`: lee los recuentos de brain.db y decide con [`inbox_verdict`].
pub(super) fn check_inbox() -> DoctorCheck {
    let conn = match sqlite_store::open_conn() {
        Ok(c) => c,
        Err(e) => {
            return DoctorCheck::warn(
                "inbox",
                format!("no comprobado: brain.db no abre: {e}"),
                serde_json::json!({ "checked": false }),
            );
        }
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
    let counts = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN proposed_tags LIKE '%\"unjudged\"%' THEN 1 ELSE 0 END), 0),
                MIN(CASE WHEN proposed_tags LIKE '%\"unjudged\"%' THEN created_at END)
         FROM memory_candidates WHERE status = 'pending'",
        [],
        |r| {
            Ok(InboxCounts {
                pending: r.get(0)?,
                unjudged: r.get(1)?,
                oldest_unjudged_ms: r.get(2)?,
            })
        },
    );
    match counts {
        Ok(c) => inbox_verdict(
            c,
            chrono::Utc::now().timestamp_millis(),
            crate::memory::auto_approve::auto_approve_enabled(),
            crate::qdrant::dense_enabled(),
        ),
        Err(e) => DoctorCheck::warn(
            "inbox",
            format!("no comprobado: {e}"),
            serde_json::json!({ "checked": false }),
        ),
    }
}

/// PURA: veredicto del inbox. Sin candidatos `unjudged` → Ok. Con ellos y el
/// auto-approve activo → Warn: esos candidatos no se aprobarán solos. Con el
/// auto-approve apagado nada se aprueba solo de todas formas → Ok, pero el
/// detalle lo dice (nunca callado).
pub(super) fn inbox_verdict(
    counts: InboxCounts,
    now_ms: i64,
    auto_approve: bool,
    dense: bool,
) -> DoctorCheck {
    let oldest_days = counts
        .oldest_unjudged_ms
        .map(|ms| ((now_ms - ms).max(0)) / DAY_MS);
    let judge_neighbours = if dense { "dense" } else { "fts5" };
    let data = serde_json::json!({
        "pending": counts.pending,
        "unjudged": counts.unjudged,
        "oldest_unjudged_days": oldest_days,
        "auto_approve": auto_approve,
        "judge_neighbours": judge_neighbours,
        "repair": "ultron-memory inbox drain --auto",
    });
    if counts.unjudged <= 0 {
        return DoctorCheck::ok(
            "inbox",
            format!("{} pendiente(s), ninguno sin juzgar", counts.pending),
            data,
        );
    }
    let antiguedad = oldest_days
        .map(|d| format!("; el más antiguo, de hace {d} día(s)"))
        .unwrap_or_default();
    let causa = if dense {
        "el juez busca vecinos en Qdrant y la infra no respondió: revisa los checks qdrant"
    } else {
        "el juez busca vecinos por FTS5 (ULTRON_DENSE=0); si no bajan, el binario es anterior al juez por FTS5 o el router del juez no responde"
    };
    let resumen = format!(
        "{} de {} candidato(s) pendientes sin juzgar (`unjudged`){antiguedad}; {causa}; re-verificación: `ultron-memory inbox drain --auto`",
        counts.unjudged, counts.pending
    );
    if auto_approve {
        DoctorCheck::warn(
            "inbox",
            format!("auto-approve activo pero no los aprobará: {resumen}"),
            data,
        )
    } else {
        DoctorCheck::ok("inbox", format!("auto-approve apagado; {resumen}"), data)
    }
}

/// Estado que deja el hook `memory-gc.js` en `.tmp/memory-gc-last.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
pub(super) struct GcState {
    /// Último gc con exit 0 (ms). Ausente si nunca terminó bien.
    #[serde(default)]
    pub last_run_ms: Option<i64>,
    /// Fallos seguidos desde el último éxito.
    #[serde(default)]
    pub fail_count: Option<u64>,
    /// Causa del último fallo (código de error, señal o stderr resumido).
    #[serde(default)]
    pub last_error: Option<String>,
}

fn gc_state_path() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("MEMORY_GC_STATE") {
        if !p.trim().is_empty() {
            return Some(std::path::PathBuf::from(p));
        }
    }
    dirs::home_dir().map(|h| h.join(".ultron").join(".tmp").join("memory-gc-last.json"))
}

/// Check `gc`: lee el estado del hook y decide con [`gc_verdict`].
pub(super) fn check_gc() -> DoctorCheck {
    let Some(path) = gc_state_path() else {
        return DoctorCheck::warn(
            "gc",
            "no comprobado: sin HOME",
            serde_json::json!({ "checked": false }),
        );
    };
    let state = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<GcState>(text.trim_start_matches('\u{feff}')) {
            Ok(s) => Some(s),
            Err(e) => {
                return DoctorCheck::warn(
                    "gc",
                    format!("estado ilegible en {}: {e}", path.display()),
                    serde_json::json!({ "checked": false }),
                );
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return DoctorCheck::warn(
                "gc",
                format!("no comprobado: {e}"),
                serde_json::json!({ "checked": false }),
            );
        }
    };
    gc_verdict(state.as_ref(), chrono::Utc::now().timestamp_millis())
}

/// PURA: veredicto del mantenimiento semanal. Warn si el último gc correcto es
/// de hace más de `GC_STALE_DAYS` (o no hubo ninguno y ya falla) o si lleva
/// `GC_MAX_FAILS` fallos seguidos. Sin estado (instalación nueva, el hook aún no
/// corrió) → Ok informativo.
pub(super) fn gc_verdict(state: Option<&GcState>, now_ms: i64) -> DoctorCheck {
    let Some(st) = state else {
        return DoctorCheck::ok(
            "gc",
            "sin ejecuciones registradas todavía (lo lanza el hook memory-gc al cerrar sesión)",
            serde_json::json!({ "runs": 0 }),
        );
    };
    let fails = st.fail_count.unwrap_or(0);
    let days_since_ok = st.last_run_ms.map(|ms| ((now_ms - ms).max(0)) / DAY_MS);
    let data = serde_json::json!({
        "days_since_ok": days_since_ok,
        "fail_count": fails,
        "last_error": st.last_error,
        "log": "logs/memory-gc.jsonl",
    });
    let error = st
        .last_error
        .as_deref()
        .map(|e| format!("; último error: {e}"))
        .unwrap_or_default();
    let stale = match days_since_ok {
        Some(d) => d > GC_STALE_DAYS,
        None => fails > 0,
    };
    if stale || fails >= GC_MAX_FAILS {
        let desde = days_since_ok
            .map(|d| format!("último gc correcto hace {d} día(s)"))
            .unwrap_or_else(|| "ningún gc correcto registrado".to_string());
        return DoctorCheck::warn(
            "gc",
            format!("{desde}, {fails} fallo(s) seguidos{error}; detalle en logs/memory-gc.jsonl"),
            data,
        );
    }
    let detalle = match days_since_ok {
        Some(d) if fails > 0 => {
            format!("último gc correcto hace {d} día(s); {fails} fallo(s) desde entonces{error}")
        }
        Some(d) => format!("último gc correcto hace {d} día(s)"),
        None => "sin ejecuciones registradas todavía".to_string(),
    };
    DoctorCheck::ok("gc", detalle, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics_native::Severity;

    const NOW: i64 = 1_800_000_000_000;

    fn counts(pending: i64, unjudged: i64, oldest_days: Option<i64>) -> InboxCounts {
        InboxCounts {
            pending,
            unjudged,
            oldest_unjudged_ms: oldest_days.map(|d| NOW - d * DAY_MS),
        }
    }

    #[test]
    fn inbox_without_unjudged_is_ok() {
        let c = inbox_verdict(counts(12, 0, None), NOW, true, false);
        assert_eq!(c.severity, Severity::Ok, "detail={}", c.detail);
    }

    #[test]
    fn inbox_unjudged_with_auto_approve_warns_and_says_why() {
        // Caso del hallazgo H11: todo el inbox sin juzgar con auto-approve activo.
        let c = inbox_verdict(counts(677, 677, Some(15)), NOW, true, false);
        assert_eq!(c.severity, Severity::Warn, "detail={}", c.detail);
        assert!(c.detail.contains("677 de 677"), "detail={}", c.detail);
        assert!(c.detail.contains("FTS5"), "detail={}", c.detail);
        assert!(c.detail.contains("drain --auto"), "detail={}", c.detail);
        assert!(c.detail.contains("15 día"), "detail={}", c.detail);
        let data = c.data.expect("data");
        assert_eq!(data["judge_neighbours"], "fts5");
        assert_eq!(data["unjudged"], 677);
    }

    #[test]
    fn inbox_unjudged_with_dense_points_to_qdrant() {
        let c = inbox_verdict(counts(3, 2, Some(0)), NOW, true, true);
        assert_eq!(c.severity, Severity::Warn);
        assert!(c.detail.contains("Qdrant"), "detail={}", c.detail);
    }

    #[test]
    fn inbox_unjudged_without_auto_approve_is_ok_but_not_silent() {
        // Caso negativo del Warn: sin auto-approve nada se aprueba solo, pero el
        // recuento sigue en el detalle.
        let c = inbox_verdict(counts(5, 4, Some(1)), NOW, false, false);
        assert_eq!(c.severity, Severity::Ok, "detail={}", c.detail);
        assert!(c.detail.contains("4 de 5"), "detail={}", c.detail);
    }

    fn state(days_since_ok: Option<i64>, fails: u64, error: Option<&str>) -> GcState {
        GcState {
            last_run_ms: days_since_ok.map(|d| NOW - d * DAY_MS),
            fail_count: Some(fails),
            last_error: error.map(str::to_string),
        }
    }

    #[test]
    fn gc_recent_success_is_ok() {
        let st = state(Some(3), 0, None);
        let c = gc_verdict(Some(&st), NOW);
        assert_eq!(c.severity, Severity::Ok, "detail={}", c.detail);
    }

    #[test]
    fn gc_without_state_is_informative_ok() {
        let c = gc_verdict(None, NOW);
        assert_eq!(c.severity, Severity::Ok);
        assert!(c.detail.contains("sin ejecuciones"), "detail={}", c.detail);
    }

    #[test]
    fn gc_stale_success_warns_with_last_error() {
        // Caso del hallazgo H26: último éxito el 25-09, timeouts desde el 02-10.
        let st = state(Some(22), 2, Some("ETIMEDOUT (SIGTERM) a 110 s"));
        let c = gc_verdict(Some(&st), NOW);
        assert_eq!(c.severity, Severity::Warn, "detail={}", c.detail);
        assert!(c.detail.contains("22 día"), "detail={}", c.detail);
        assert!(c.detail.contains("ETIMEDOUT"), "detail={}", c.detail);
    }

    #[test]
    fn gc_repeated_failures_warn_even_if_last_success_is_recent() {
        let st = state(Some(8), GC_MAX_FAILS, Some("exit 1"));
        assert_eq!(gc_verdict(Some(&st), NOW).severity, Severity::Warn);
        // Caso negativo: un fallo suelto con éxito reciente no avisa.
        let st = state(Some(8), 1, Some("exit 1"));
        let c = gc_verdict(Some(&st), NOW);
        assert_eq!(c.severity, Severity::Ok, "detail={}", c.detail);
        assert!(c.detail.contains("1 fallo"), "detail={}", c.detail);
    }

    #[test]
    fn gc_never_succeeded_and_failing_warns() {
        let st = state(None, 1, Some("ETIMEDOUT"));
        let c = gc_verdict(Some(&st), NOW);
        assert_eq!(c.severity, Severity::Warn, "detail={}", c.detail);
        assert!(
            c.detail.contains("ningún gc correcto"),
            "detail={}",
            c.detail
        );
    }

    #[test]
    fn gc_state_parses_the_hook_format() {
        // Formato que escribe hooks/scripts/memory-gc.js (claves extra ignoradas).
        let json = r#"{"last_run_ms":1790374880081,"last_run_iso":"2026-09-25T22:21:20.081Z","stale_marked":57,"fail_count":2,"last_fail_ms":1792255903111,"last_error":"ETIMEDOUT"}"#;
        let st: GcState = serde_json::from_str(json).expect("parse");
        assert_eq!(st.last_run_ms, Some(1_790_374_880_081));
        assert_eq!(st.fail_count, Some(2));
        assert_eq!(st.last_error.as_deref(), Some("ETIMEDOUT"));
        // El formato antiguo (solo éxito) sigue siendo válido.
        let viejo: GcState = serde_json::from_str(r#"{"last_run_ms":1}"#).expect("parse");
        assert_eq!(viejo.fail_count, None);
    }
}
