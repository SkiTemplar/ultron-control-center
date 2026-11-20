// memory/doctor_eval_gate.rs — check `evals` de `doctor`: calidad del recall
// (oráculo etiquetado) y gate de seguridad (leaks del smoke). Submódulo de
// `doctor.rs`; usa sus constructores de `DoctorCheck`. La decisión es pura
// (`evals_verdict`) y se prueba sin brain.db ni recall.

use super::DoctorCheck;
use crate::memory::evals;

/// Recall quality + security gate. (2026-08-10, decisión del usuario: "el oráculo")
/// El VEREDICTO lo decide el ORÁCULO ETIQUETADO (golden_labels.json, queries
/// curadas a mano) medido por el mismo camino que el hook; el smoke sintético
/// queda SOLO como gate de leaks y de caída del pipeline.
///
/// Línea base del golden sparse (FTS5 solo) medida el 2026-09-28 y de nuevo el
/// 2026-10-23: 0,131 sobre 27 queries agregadas (una query entera vale
/// ≈0,037). Suelo de error en 0,10 (≈1 query por debajo) y aviso en 0,12. Las
/// bandas del recall denso (0,42/0,30) se retiraron con la ruta densa el
/// 2026-11-14.
const SPARSE_GOLDEN_FLOOR: f32 = 0.10;
const SPARSE_GOLDEN_WARN: f32 = 0.12;

/// Línea base del smoke sparse medida el 2026-10-23: 11 de 12 queries (0,917).
/// Perder una más (10/12 = 0,833) ya cae por debajo del suelo.
const SPARSE_SMOKE_FLOOR: f32 = 0.90;

/// Medición que consume [`evals_verdict`]: pura, sin I/O, para probar las
/// bandas sin brain.db ni recall.
#[derive(Debug, Clone, Copy)]
struct EvalsSample<'a> {
    golden_recall: f32,
    golden_degraded: bool,
    golden_note: &'a str,
    smoke_recall: f32,
    secret_leaks: usize,
    stale_leaks: usize,
}

fn evals_verdict(s: &EvalsSample<'_>) -> DoctorCheck {
    let data = serde_json::json!({
        "recall_at_8_golden": s.golden_recall,
        "oracle": "labeled",
        "golden_degraded": s.golden_degraded,
        "golden_note": s.golden_note,
        "recall_at_8_smoke": s.smoke_recall,
        "secret_leak": s.secret_leaks,
        "stale_leak": s.stale_leaks,
        "golden_floor_sparse": SPARSE_GOLDEN_FLOOR,
        "smoke_floor_sparse": SPARSE_SMOKE_FLOOR,
    });
    if s.secret_leaks > 0 || s.stale_leaks > 0 {
        return DoctorCheck::error(
            "evals",
            format!("LEAK · secret={} stale={}", s.secret_leaks, s.stale_leaks),
            data,
        );
    }
    if s.golden_degraded {
        // (2026-08-10) la CAUSA viaja en el detail: "set ausente" frente a
        // cualquier otro fallo deja de ser indistinguible (audit 08-09 punto 3).
        return DoctorCheck::warn(
            "evals",
            format!(
                "golden no disponible · {} · smoke={:.3}",
                s.golden_note, s.smoke_recall
            ),
            data,
        );
    }
    let detail = format!(
        "oráculo recall@8={:.3} (suelo {SPARSE_GOLDEN_FLOOR:.2}) · smoke={:.3} (suelo {SPARSE_SMOKE_FLOOR:.2}) · leaks=0",
        s.golden_recall, s.smoke_recall
    );
    if s.smoke_recall < SPARSE_SMOKE_FLOOR {
        return DoctorCheck::error("evals", format!("caída del smoke · {detail}"), data);
    }
    if s.golden_recall < SPARSE_GOLDEN_FLOOR {
        return DoctorCheck::error(
            "evals",
            format!("golden bajo la línea base · {detail}"),
            data,
        );
    }
    if s.golden_recall < SPARSE_GOLDEN_WARN {
        return DoctorCheck::warn("evals", format!("golden cerca del suelo · {detail}"), data);
    }
    DoctorCheck::ok("evals", detail, data)
}

pub(super) fn check_evals() -> DoctorCheck {
    let smoke = evals::run(None, 8);
    // (2026-08-10) El veredicto lo da el ORÁCULO ETIQUETADO (el medidor
    // honesto), no el set generado stale.
    let Some(labels_path) = evals::golden_labels_path() else {
        return evals_verdict(&EvalsSample {
            golden_recall: 0.0,
            golden_degraded: true,
            golden_note: "no HOME dir; cannot locate golden_labels.json",
            smoke_recall: smoke.recall_at_k,
            secret_leaks: smoke.secret_leak_count,
            stale_leaks: smoke.stale_leak_count,
        });
    };
    let golden = evals::run_labeled_golden(&labels_path.to_string_lossy(), 8);
    evals_verdict(&EvalsSample {
        golden_recall: golden.aggregate.recall_at_k as f32,
        golden_degraded: golden.degraded,
        golden_note: &golden.note,
        smoke_recall: smoke.recall_at_k,
        secret_leaks: smoke.secret_leak_count,
        stale_leaks: smoke.stale_leak_count,
    })
}

#[cfg(test)]
mod evals_verdict_tests {
    use super::*;
    use crate::diagnostics_native::Severity;

    /// Muestra limpia (sin leaks, golden disponible) con los recalls dados;
    /// cada test cambia solo lo que prueba.
    fn sample(golden: f32, smoke: f32) -> EvalsSample<'static> {
        EvalsSample {
            golden_recall: golden,
            golden_degraded: false,
            golden_note: "",
            smoke_recall: smoke,
            secret_leaks: 0,
            stale_leaks: 0,
        }
    }

    #[test]
    fn baseline_is_ok_and_names_both_meters() {
        // (2026-10-23) Medición real: golden 0.131, smoke 0.917.
        let c = evals_verdict(&sample(0.131, 0.917));
        assert_eq!(c.severity, Severity::Ok, "detail={}", c.detail);
        assert!(c.detail.contains("oráculo"), "detail={}", c.detail);
        assert!(c.detail.contains("smoke"), "detail={}", c.detail);
    }

    #[test]
    fn real_regressions_still_fail() {
        // Leaks: error siempre (gate de seguridad del smoke).
        for (secret, stale) in [(1, 0), (0, 1)] {
            let c = evals_verdict(&EvalsSample {
                secret_leaks: secret,
                stale_leaks: stale,
                ..sample(0.131, 0.917)
            });
            assert_eq!(c.severity, Severity::Error, "detail={}", c.detail);
            assert!(c.detail.contains("LEAK"), "detail={}", c.detail);
        }
        // Caída del smoke: 10/12 queries.
        let c = evals_verdict(&sample(0.131, 10.0 / 12.0));
        assert_eq!(c.severity, Severity::Error, "detail={}", c.detail);
        assert!(c.detail.contains("smoke"), "detail={}", c.detail);
        // Golden bajo el suelo.
        let c = evals_verdict(&sample(0.09, 0.917));
        assert_eq!(c.severity, Severity::Error, "detail={}", c.detail);
        assert!(c.detail.contains("línea base"), "detail={}", c.detail);
        // Entre el suelo y el aviso: warn, no error ni ok.
        let c = evals_verdict(&sample(0.11, 0.917));
        assert_eq!(c.severity, Severity::Warn, "detail={}", c.detail);
        // Bordes exactos: "<", no "<=".
        let c = evals_verdict(&sample(SPARSE_GOLDEN_WARN, SPARSE_SMOKE_FLOOR));
        assert_eq!(c.severity, Severity::Ok, "detail={}", c.detail);
    }

    #[test]
    fn verdict_degraded_carries_cause_in_detail() {
        // (2026-08-10, audit 08-09 punto 3) oráculo no disponible -> warn
        // declarado con la causa, NO un 0.0 tratado como colapso ni un ok.
        let c = evals_verdict(&EvalsSample {
            golden_degraded: true,
            golden_note: "set ausente",
            ..sample(0.0, 1.0)
        });
        assert_eq!(c.severity, Severity::Warn, "detail={}", c.detail);
        assert!(
            c.detail.contains("golden no disponible"),
            "detail={}",
            c.detail
        );
        // Y el data JSON expone la nota para consumidores maquina (UI Health).
        let note = c
            .data
            .as_ref()
            .and_then(|d| d.get("golden_note"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert!(note.contains("set ausente"), "data.golden_note={note}");
    }
}
