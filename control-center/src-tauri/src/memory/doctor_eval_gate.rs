// memory/doctor_eval_gate.rs — check `evals` de `doctor`: calidad del recall
// (oráculo etiquetado) y gate de seguridad (leaks del smoke). Submódulo de
// `doctor.rs`; usa sus constructores de `DoctorCheck`. La decisión es pura
// (`evals_verdict`) y se prueba sin brain.db ni recall.

use super::DoctorCheck;
use crate::memory::evals;

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
///
/// Con el denso apagado a propósito (`ULTRON_DENSE=0`, desde el 2026-09-28) las
/// bandas densas no aplican: el golden sparse vale 0,131 por diseño y daba un
/// `error` permanente que tapaba los reales. En ese modo manda la línea base
/// sparse ([`SPARSE_GOLDEN_FLOOR`], [`SPARSE_SMOKE_FLOOR`]).
const DENSE_GOLDEN_WARN: f32 = 0.42;
const DENSE_GOLDEN_ERROR: f32 = 0.30;

/// Línea base del golden sparse (FTS5 solo, sin rerank) medida el 2026-09-28 y
/// de nuevo el 2026-10-23: 0,131 sobre 27 queries agregadas (una query entera
/// vale ≈0,037). Suelo de error en 0,10 (≈1 query por debajo) y aviso en 0,12.
const SPARSE_GOLDEN_FLOOR: f32 = 0.10;
const SPARSE_GOLDEN_WARN: f32 = 0.12;

/// Línea base del smoke sparse medida el 2026-10-23: 11 de 12 queries (0,917).
/// Perder una más (10/12 = 0,833) ya cae por debajo del suelo.
const SPARSE_SMOKE_FLOOR: f32 = 0.90;

/// Medición que consume [`evals_verdict`]: pura, sin I/O, para probar las
/// bandas sin brain.db ni recall.
#[derive(Debug, Clone, Copy)]
struct EvalsSample<'a> {
    /// `crate::qdrant::dense_enabled()` en el momento de medir.
    dense: bool,
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
        "oracle": "labeled_no_rerank",
        "dense": s.dense,
        "golden_degraded": s.golden_degraded,
        "golden_note": s.golden_note,
        "recall_at_8_smoke": s.smoke_recall,
        "secret_leak": s.secret_leaks,
        "stale_leak": s.stale_leaks,
    });
    if s.secret_leaks > 0 || s.stale_leaks > 0 {
        return DoctorCheck::error(
            "evals",
            format!("LEAK · secret={} stale={}", s.secret_leaks, s.stale_leaks),
            data,
        );
    }
    if s.golden_degraded {
        // (2026-08-10) la CAUSA viaja en el detail: "infra_down: Qdrant..." vs
        // "set ausente" dejan de ser indistinguibles (audit 08-09 punto 3).
        return DoctorCheck::warn(
            "evals",
            format!(
                "golden no disponible · {} · smoke={:.3}",
                s.golden_note, s.smoke_recall
            ),
            data,
        );
    }
    if !s.dense {
        return sparse_verdict(s, data);
    }
    let detail = format!(
        "oráculo recall@8={:.3} (hot path, sin rerank) · smoke={:.3} · leaks=0",
        s.golden_recall, s.smoke_recall
    );
    if s.golden_recall < DENSE_GOLDEN_ERROR {
        DoctorCheck::error("evals", detail, data)
    } else if s.golden_recall < DENSE_GOLDEN_WARN {
        DoctorCheck::warn("evals", detail, data)
    } else {
        DoctorCheck::ok("evals", detail, data)
    }
}

/// Veredicto con el denso apagado a propósito: el golden por debajo del umbral
/// denso es lo esperado y no cuenta; sí cuentan la caída del smoke y la del
/// golden por debajo de la línea base sparse.
fn sparse_verdict(s: &EvalsSample<'_>, mut data: serde_json::Value) -> DoctorCheck {
    data["golden_floor_sparse"] = serde_json::json!(SPARSE_GOLDEN_FLOOR);
    data["smoke_floor_sparse"] = serde_json::json!(SPARSE_SMOKE_FLOOR);
    let detail = format!(
        "denso apagado a propósito (ULTRON_DENSE=0) · oráculo sparse recall@8={:.3} (suelo {SPARSE_GOLDEN_FLOOR:.2}) · smoke={:.3} (suelo {SPARSE_SMOKE_FLOOR:.2}) · leaks=0",
        s.golden_recall, s.smoke_recall
    );
    if s.smoke_recall < SPARSE_SMOKE_FLOOR {
        return DoctorCheck::error("evals", format!("caída del smoke · {detail}"), data);
    }
    if s.golden_recall < SPARSE_GOLDEN_FLOOR {
        return DoctorCheck::error(
            "evals",
            format!("golden sparse bajo la línea base · {detail}"),
            data,
        );
    }
    if s.golden_recall < SPARSE_GOLDEN_WARN {
        return DoctorCheck::warn(
            "evals",
            format!("golden sparse cerca del suelo · {detail}"),
            data,
        );
    }
    DoctorCheck::ok("evals", detail, data)
}

pub(super) fn check_evals() -> DoctorCheck {
    let smoke = evals::run(None, 8);
    let dense = crate::qdrant::dense_enabled();
    // (2026-08-10) El veredicto lo da el ORÁCULO ETIQUETADO (29 queries, el
    // medidor honesto), no el set generado stale. rerank=false: el doctor es
    // fontanería (¿el pipeline recupera?), no el medidor de calidad — con
    // cross-encoder tardaba ~62s y reventaba los timeouts del harness.
    // Knobs EXPLÍCITOS (dense=true, rerank=false): sin depender del env. Con
    // `ULTRON_DENSE=0` el embedder devuelve el vector cero y la medición es
    // sparse de hecho; `dense` elige las bandas que le corresponden.
    let Some(labels_path) = evals::golden_labels_path() else {
        return evals_verdict(&EvalsSample {
            dense,
            golden_recall: 0.0,
            golden_degraded: true,
            golden_note: "no HOME dir; cannot locate golden_labels.json",
            smoke_recall: smoke.recall_at_k,
            secret_leaks: smoke.secret_leak_count,
            stale_leaks: smoke.stale_leak_count,
        });
    };
    let golden = evals::run_labeled_golden_with(&labels_path.to_string_lossy(), 8, true, false);
    evals_verdict(&EvalsSample {
        dense,
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

    /// Muestra limpia (sin leaks, golden disponible) con el modo y los recalls
    /// dados; cada test cambia solo lo que prueba.
    fn sample(dense: bool, golden: f32, smoke: f32) -> EvalsSample<'static> {
        EvalsSample {
            dense,
            golden_recall: golden,
            golden_degraded: false,
            golden_note: "",
            smoke_recall: smoke,
            secret_leaks: 0,
            stale_leaks: 0,
        }
    }

    // (unificar medidores, 2026-07-02) — el veredicto de 'evals' se decide por
    // el GOLDEN (el honesto), no por el smoke sintetico (que dio el "1.000"
    // que alimento el era-claim '9.73 techo honesto').
    #[test]
    fn verdict_bands_on_golden_not_smoke() {
        // (2026-08-10) Bandas calibradas al oráculo etiquetado por el HOT PATH
        // (baseline sano medido: 0.498): ok >=0.42 · warn <0.42 · error <0.30.
        // oráculo sano -> ok, y el detail NOMBRA ambos medidores.
        let c = evals_verdict(&sample(true, 0.498, 1.0));
        assert_eq!(c.severity, Severity::Ok, "detail={}", c.detail);
        assert!(c.detail.contains("oráculo"), "detail={}", c.detail);
        assert!(c.detail.contains("smoke"), "detail={}", c.detail);

        // regresion real -> warn/error aunque el smoke de 1.0.
        let c = evals_verdict(&sample(true, 0.40, 1.0));
        assert_eq!(c.severity, Severity::Warn, "detail={}", c.detail);
        let c = evals_verdict(&sample(true, 0.25, 1.0));
        assert_eq!(c.severity, Severity::Error, "detail={}", c.detail);

        // borde exacto: 0.42 ya es ok (bandas son "<", no "<=").
        let c = evals_verdict(&sample(true, 0.42, 1.0));
        assert_eq!(c.severity, Severity::Ok, "detail={}", c.detail);

        // leaks mandan SIEMPRE (gate de seguridad del smoke).
        let c = evals_verdict(&EvalsSample {
            secret_leaks: 1,
            ..sample(true, 0.498, 1.0)
        });
        assert_eq!(c.severity, Severity::Error);
        assert!(c.detail.contains("LEAK"));

        // oráculo no disponible (Qdrant caido / set ausente) -> warn declarado,
        // NO un 0.0 tratado como colapso ni un ok fingido.
        let c = evals_verdict(&EvalsSample {
            golden_degraded: true,
            golden_note: "set ausente",
            ..sample(true, 0.0, 1.0)
        });
        assert_eq!(c.severity, Severity::Warn, "detail={}", c.detail);
        assert!(
            c.detail.contains("golden no disponible"),
            "detail={}",
            c.detail
        );
    }

    #[test]
    fn dense_off_golden_below_dense_band_is_not_error() {
        // (2026-10-23) Medición real con ULTRON_DENSE=0: golden 0.131, smoke
        // 0.917. Con denso esa cifra es error; con denso apagado es la línea
        // base sparse y el detail lo declara.
        let c = evals_verdict(&sample(false, 0.131, 0.917));
        assert_eq!(c.severity, Severity::Ok, "detail={}", c.detail);
        assert!(
            c.detail.contains("denso apagado a propósito"),
            "detail={}",
            c.detail
        );
        // Caso negativo: la misma cifra con denso encendido sigue siendo error.
        let c = evals_verdict(&sample(true, 0.131, 0.917));
        assert_eq!(c.severity, Severity::Error, "detail={}", c.detail);
    }

    #[test]
    fn dense_off_still_fails_on_real_regressions() {
        // Leaks: error en cualquier modo.
        for (secret, stale) in [(1, 0), (0, 1)] {
            let c = evals_verdict(&EvalsSample {
                secret_leaks: secret,
                stale_leaks: stale,
                ..sample(false, 0.131, 0.917)
            });
            assert_eq!(c.severity, Severity::Error, "detail={}", c.detail);
            assert!(c.detail.contains("LEAK"), "detail={}", c.detail);
        }
        // Caída del smoke: 10/12 queries.
        let c = evals_verdict(&sample(false, 0.131, 10.0 / 12.0));
        assert_eq!(c.severity, Severity::Error, "detail={}", c.detail);
        assert!(c.detail.contains("smoke"), "detail={}", c.detail);
        // Golden bajo el suelo sparse.
        let c = evals_verdict(&sample(false, 0.09, 0.917));
        assert_eq!(c.severity, Severity::Error, "detail={}", c.detail);
        assert!(c.detail.contains("línea base"), "detail={}", c.detail);
        // Entre el suelo y el aviso: warn, no error ni ok.
        let c = evals_verdict(&sample(false, 0.11, 0.917));
        assert_eq!(c.severity, Severity::Warn, "detail={}", c.detail);
        // Bordes exactos: "<", no "<=".
        let c = evals_verdict(&sample(false, SPARSE_GOLDEN_WARN, SPARSE_SMOKE_FLOOR));
        assert_eq!(c.severity, Severity::Ok, "detail={}", c.detail);
        // Golden no disponible con denso apagado: warn, igual que con denso.
        let c = evals_verdict(&EvalsSample {
            golden_degraded: true,
            golden_note: "set ausente",
            ..sample(false, 0.0, 0.917)
        });
        assert_eq!(c.severity, Severity::Warn, "detail={}", c.detail);
    }

    #[test]
    fn verdict_degraded_carries_infra_cause_in_detail() {
        // (2026-08-10, audit 08-09 punto 3) infra caida NO puede ser
        // indistinguible de "set ausente": la causa viaja en el detail.
        let c = evals_verdict(&EvalsSample {
            golden_degraded: true,
            golden_note:
                "infra_down: Qdrant no responde /healthz — golden omitido (no es regresión de calidad)",
            ..sample(true, 0.0, 1.0)
        });
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
