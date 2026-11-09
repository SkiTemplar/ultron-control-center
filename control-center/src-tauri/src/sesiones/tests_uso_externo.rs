// Tests de `uso_externo`: saldo de DeepSeek y resumen de delegaciones.

use super::*;

#[test]
fn el_saldo_se_lee_con_su_moneda() {
    let v: Value = serde_json::from_str(
        r#"{"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"4.20","granted_balance":"0.00","topped_up_balance":"4.20"}]}"#,
    )
    .expect("json");
    let b = leer_balance(&v, 7);
    assert_eq!(b.status, "ok");
    assert_eq!(b.available, Some(true));
    assert_eq!(
        b.balances,
        vec![Saldo {
            currency: "USD".into(),
            total: "4.20".into()
        }]
    );
    assert_eq!(b.note, None);
    assert_eq!(b.read_at_ms, Some(7));
}

#[test]
fn sin_saldo_se_avisa() {
    let v: Value = serde_json::from_str(
        r#"{"is_available":false,"balance_infos":[{"currency":"USD","total_balance":"0.00"}]}"#,
    )
    .expect("json");
    let b = leer_balance(&v, 1);
    assert_eq!(b.available, Some(false));
    assert_eq!(b.note.as_deref(), Some("sin saldo"));
}

#[test]
fn una_respuesta_sin_is_available_es_error() {
    let b = leer_balance(&serde_json::json!({"error": "x"}), 1);
    assert_eq!(b.status, "error");
    assert!(b.note.is_some());
}

#[test]
fn un_fallo_caduca_antes_que_un_acierto() {
    let hace_2_min = Instant::now() - Duration::from_secs(120);
    let ok = leer_balance(&serde_json::json!({"is_available": true}), 1);
    assert!(vigente(&ok, hace_2_min));
    let ko = sin_dato("error", "sin red".into());
    assert!(!vigente(&ko, hace_2_min));
}

fn intento(engine: &str, outcome: &str, coste: Option<f64>) -> LedgerEntry {
    serde_json::from_value(serde_json::json!({
        "ts": "2026-10-26T10:00:00Z", "id": "d", "attempt": 1,
        "engine": engine, "outcome": outcome, "costUsd": coste,
    }))
    .expect("entrada")
}

#[test]
fn las_delegaciones_se_resumen_por_motor_sin_contar_los_saltados() {
    let fin: LedgerEntry =
        serde_json::from_value(serde_json::json!({"ts": "t", "id": "d", "final": "merged"}))
            .expect("final");
    let v = resumir(&[
        intento("codex", "engine-fail", None),
        intento("codex", "ok", None),
        intento("claude-p", "ok", Some(0.5)),
        intento("claude-p", "check-fail", Some(0.25)),
        intento("deepseek", "skipped", None),
        fin,
    ]);
    assert_eq!(v.len(), 2, "deepseek solo tiene saltados: {v:?}");
    let claude = &v[0];
    assert_eq!(
        (claude.engine.as_str(), claude.attempts, claude.ok),
        ("claude-p", 2, 1)
    );
    assert_eq!(claude.success_pct, 50.0);
    assert_eq!(claude.cost_usd, Some(0.75));
    let codex = &v[1];
    assert_eq!(codex.cost_usd, None, "sin coste no se inventa un 0");
    assert_eq!(codex.success_pct, 50.0);
}

#[test]
fn anadir_mete_deepseek_y_no_rompe_una_respuesta_que_no_es_objeto() {
    let mut r = serde_json::json!({"engines": []});
    anadir(&mut r, sin_dato("none", "sin DEEPSEEK_API_KEY".into()));
    assert_eq!(r["deepseek"]["status"], "none");
    assert!(r.get("delegations").is_some() || r.get("delegationsError").is_some());
    let mut lista = serde_json::json!([]);
    anadir(&mut lista, sin_dato("none", "x".into()));
    assert_eq!(lista, serde_json::json!([]));
}
