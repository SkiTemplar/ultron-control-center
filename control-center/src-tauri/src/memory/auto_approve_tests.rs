// memory/auto_approve_tests.rs — tests de `auto_approve.rs` (separados para
// mantener el módulo por debajo de 800 líneas).

use super::super::model::{MemoryType, Scope};
use super::*;

fn clean_candidate() -> MemoryCandidate {
    // `MemoryCandidate::new` defaults risk_level="low" and no contradictions.
    MemoryCandidate::new(MemoryType::Fact, Scope::Project)
}

#[test]
fn candidate_with_duplicate_is_not_clean() {
    // 1.2: un duplicado NO debe auto-aprobarse ni colarse por approve-clean
    // (asi se acumularon las 211 copias activas que sesgaban el recall).
    let mut c = clean_candidate();
    assert!(candidate_is_clean(&c), "baseline limpio");
    c.duplicate_candidates
        .push("existing-active-id".to_string());
    assert!(
        !candidate_is_clean(&c),
        "un candidato con duplicado_candidates NO es clean"
    );
}

#[test]
fn unjudged_candidate_is_not_clean() {
    // 1.7 fail-closed: si el juez de contradicción no pudo emitir verdicto
    // (timeout / conn falló), el candidato lleva "unjudged" y NO debe
    // auto-aprobarse — espera ojo humano en el inbox (antes fail-OPEN: una
    // Fact que contradice un ACTIVE se colaba a active sin verificar).
    let mut c = clean_candidate();
    assert!(candidate_is_clean(&c), "baseline limpio");
    c.proposed_tags.push("unjudged".to_string());
    assert!(
        !candidate_is_clean(&c),
        "un candidato sin verdicto de contradicción NO es clean"
    );
}

#[test]
fn dedup_unverified_candidate_is_not_clean() {
    // 1.7 fail-closed: si la búsqueda de duplicados falló (Err de FTS5/SQLite),
    // el candidato lleva "dedup-unverified" y NO debe auto-aprobarse — así un
    // fallo transitorio no puede regresar el bug 1.2 (las 211 copias).
    let mut c = clean_candidate();
    c.proposed_tags.push("dedup-unverified".to_string());
    assert!(!candidate_is_clean(&c));
    // Case-insensitive: un marcador en mayúsculas también bloquea.
    let mut c2 = clean_candidate();
    c2.proposed_tags.push("UNJUDGED".to_string());
    assert!(!candidate_is_clean(&c2));
}

// --- drain --auto (2026-07-13): política full-auto ----------------------

// --- gate de origen (2026-09-07) --------------------------------------

fn session_capture(origin: Option<&str>) -> MemoryCandidate {
    let mut c = clean_candidate();
    c.confidence = 0.9;
    c.capture_source = Some("stop_capture".to_string());
    if let Some(o) = origin {
        c.proposed_tags.push(format!("origin:{o}"));
    }
    c
}

#[test]
fn origin_user_still_auto_approves() {
    assert_eq!(
        auto_disposition(&session_capture(Some("user"))),
        AutoDisposition::Approve
    );
}

#[test]
fn origin_assistant_auto_approves_only_in_band_a() {
    // 2026-09-22: una captura del asistente con confidence alta SÍ entra
    // sola (el toggle auto_approve por fin dispara sobre la captura real)…
    let high = session_capture(Some("assistant"));
    assert_eq!(auto_disposition(&high), AutoDisposition::Approve);
    assert!(candidate_is_clean(&high));
    assert_eq!(classify_band(&high, 0.65), AutoBand::Approve);
    // …pero en banda B se queda pending: clean no basta sin confianza.
    let mut mid = session_capture(Some("assistant"));
    mid.confidence = 0.60;
    assert!(candidate_is_clean(&mid));
    assert_eq!(classify_band(&mid, 0.65), AutoBand::Pending);
}

#[test]
fn origin_unknown_or_missing_keeps_pending() {
    assert_eq!(
        auto_disposition(&session_capture(Some("unknown"))),
        AutoDisposition::KeepNonUserOrigin
    );
    // Captura de sesión sin etiqueta (extractor que no la emitió): la duda
    // no promociona.
    assert_eq!(
        auto_disposition(&session_capture(None)),
        AutoDisposition::KeepNonUserOrigin
    );
}

#[test]
fn unknown_origin_is_not_clean_so_creation_time_auto_approve_skips_it() {
    // El write-path aprueba en la creación a través de candidate_is_clean +
    // classify_band: la duda de origen sigue fail-closed ahí también.
    assert!(!candidate_is_clean(&session_capture(Some("unknown"))));
    assert!(!candidate_is_clean(&session_capture(None)));
    assert!(candidate_is_clean(&session_capture(Some("user"))));
    assert!(candidate_is_clean(&session_capture(Some("assistant"))));
}

#[test]
fn structural_channels_without_origin_are_untouched() {
    // posttooluse_symbol y similares no hablan por el asistente: política
    // de siempre (banda A aprueba).
    let mut c = clean_candidate();
    c.confidence = 0.9;
    c.capture_source = Some("posttooluse_symbol".to_string());
    assert_eq!(auto_disposition(&c), AutoDisposition::Approve);
}

#[test]
fn origin_gate_comes_after_secret_and_duplicate() {
    let mut c = session_capture(Some("assistant"));
    c.risk_level = SECRET_RISK_MARKER.to_string();
    assert_eq!(
        auto_disposition(&c),
        AutoDisposition::Reject(RejectKind::Secret)
    );
    let mut d = session_capture(Some("assistant"));
    d.duplicate_candidates.push("existing-id".to_string());
    assert_eq!(
        auto_disposition(&d),
        AutoDisposition::Reject(RejectKind::Duplicate)
    );
}

// --- caducidad de origen no humano (2026-10-18) ------------------------

/// Captura `origin:unknown` creada hace `days` días respecto a `now`.
fn non_user_capture_aged(days: i64, now: i64) -> MemoryCandidate {
    let mut c = session_capture(Some("unknown"));
    c.created_at = now - days * MILLIS_PER_DAY;
    c
}

const FIXED_NOW_MS: i64 = 1_800_000_000_000;

#[test]
fn non_user_origin_older_than_ttl_is_rejected_as_expired() {
    let c = non_user_capture_aged(8, FIXED_NOW_MS);
    assert_eq!(
        auto_disposition_at(&c, FIXED_NOW_MS),
        AutoDisposition::Reject(RejectKind::ExpiredNonUserOrigin)
    );
    // Frontera inclusiva: justo NON_USER_ORIGIN_TTL_DAYS ya caduca.
    let edge = non_user_capture_aged(NON_USER_ORIGIN_TTL_DAYS, FIXED_NOW_MS);
    assert!(non_user_origin_expired(&edge, FIXED_NOW_MS));
}

#[test]
fn non_user_origin_younger_than_ttl_stays_pending() {
    // Caso negativo: con 6 días sigue esperando validación humana.
    let c = non_user_capture_aged(6, FIXED_NOW_MS);
    assert_eq!(
        auto_disposition_at(&c, FIXED_NOW_MS),
        AutoDisposition::KeepNonUserOrigin
    );
}

#[test]
fn expiry_only_affects_non_user_origin() {
    // Un candidato viejo con otra disposición no cambia por la edad.
    let mut approved = session_capture(Some("user"));
    approved.created_at = FIXED_NOW_MS - 30 * MILLIS_PER_DAY;
    assert_eq!(
        auto_disposition_at(&approved, FIXED_NOW_MS),
        AutoDisposition::Approve
    );
    let mut unverified = session_capture(Some("assistant"));
    unverified.proposed_tags.push("unjudged".to_string());
    unverified.created_at = FIXED_NOW_MS - 30 * MILLIS_PER_DAY;
    assert_eq!(
        auto_disposition_at(&unverified, FIXED_NOW_MS),
        AutoDisposition::KeepUnverified
    );
}

#[test]
fn auto_disposition_test_probe_never_approves() {
    // Un probe del harness con confidence alta (banda A) se rechaza SIEMPRE
    // por la vía auto — es material de test, no memoria.
    let mut c = clean_candidate();
    c.confidence = 0.9;
    c.proposed_project_id = Some("__kirkardo_test__".to_string());
    assert_eq!(
        auto_disposition(&c),
        AutoDisposition::Reject(RejectKind::Noise)
    );
    let mut c2 = clean_candidate();
    c2.confidence = 0.9;
    c2.proposed_tags
        .push("project:__kirkardo_test__".to_string());
    assert_eq!(
        auto_disposition(&c2),
        AutoDisposition::Reject(RejectKind::Noise)
    );
}

#[test]
fn auto_disposition_secret_rejects_even_if_unverified() {
    // Secret manda sobre todo: aunque además esté unjudged, PII nunca a
    // active — y tampoco se queda eternamente pending en modo auto.
    let mut c = clean_candidate();
    c.risk_level = SECRET_RISK_MARKER.to_string();
    c.proposed_tags.push("unjudged".to_string());
    assert_eq!(
        auto_disposition(&c),
        AutoDisposition::Reject(RejectKind::Secret)
    );
}

#[test]
fn auto_disposition_duplicate_rejects_even_if_unjudged() {
    // El hallazgo de duplicado ya existe: la verificación que falta solo
    // podría añadir MÁS motivos para no aprobar. Se rechaza, no se espera.
    let mut c = clean_candidate();
    c.duplicate_candidates.push("existing-id".to_string());
    c.proposed_tags.push("unjudged".to_string());
    assert_eq!(
        auto_disposition(&c),
        AutoDisposition::Reject(RejectKind::Duplicate)
    );
}

#[test]
fn auto_disposition_contradiction_rejects_keeping_active() {
    let mut c = clean_candidate();
    c.confidence = 0.9;
    c.contradiction_candidates.push("active-id".to_string());
    assert_eq!(
        auto_disposition(&c),
        AutoDisposition::Reject(RejectKind::Contradiction)
    );
}

#[test]
fn auto_disposition_unverified_clean_keeps_pending() {
    // Fail-closed intacto en modo auto: sin verdicto (y sin hallazgos ya
    // conocidos) NO se aprueba — queda pending hasta que el juez corra.
    let mut c = clean_candidate();
    c.confidence = 0.9;
    c.proposed_tags.push("unjudged".to_string());
    assert_eq!(auto_disposition(&c), AutoDisposition::KeepUnverified);
}

#[test]
fn auto_disposition_band_b_approves_in_full_auto() {
    // Diferencia clave vs las 3 bandas: la banda B (media confianza) se
    // aprueba — el objetivo del modo es inbox 0 sin adjudicación humana.
    let mut c = clean_candidate();
    c.confidence = 0.60; // >= REJECT_THRESHOLD, < threshold típico (0.72)
    assert_eq!(auto_disposition(&c), AutoDisposition::Approve);
}

#[test]
fn auto_disposition_noise_still_rejects() {
    let mut c = clean_candidate();
    c.confidence = REJECT_THRESHOLD - 0.01;
    assert_eq!(
        auto_disposition(&c),
        AutoDisposition::Reject(RejectKind::Noise)
    );
}

#[test]
fn default_settings_are_off() {
    assert!(!MemorySettings::default().auto_approve);
}

#[test]
fn clean_candidate_is_eligible() {
    assert!(candidate_is_clean(&clean_candidate()));
}

#[test]
fn secret_candidate_is_never_eligible() {
    let mut c = clean_candidate();
    c.risk_level = SECRET_RISK_MARKER.to_string();
    assert!(
        !candidate_is_clean(&c),
        "a secret-marked candidate must always require human review"
    );
    // Case-insensitive: an upper/mixed-case marker must still be blocked.
    c.risk_level = "Secret".to_string();
    assert!(!candidate_is_clean(&c));
}

#[test]
fn contradicting_candidate_is_never_eligible() {
    let mut c = clean_candidate();
    c.contradiction_candidates = vec!["item-123".to_string()];
    assert!(
        !candidate_is_clean(&c),
        "a contradicting candidate must always require human review"
    );
}

#[test]
fn default_threshold_is_band_a_floor() {
    assert_eq!(
        MemorySettings::default().auto_approve_threshold,
        DEFAULT_AUTO_APPROVE_THRESHOLD
    );
}

#[test]
fn high_confidence_fact_lands_in_band_a() {
    let mut c = clean_candidate();
    c.confidence = 0.95;
    assert_eq!(
        classify_band(&c, DEFAULT_AUTO_APPROVE_THRESHOLD),
        AutoBand::Approve
    );
}

#[test]
fn mid_confidence_lands_in_band_b() {
    let mut c = clean_candidate();
    c.confidence = 0.70;
    assert_eq!(
        classify_band(&c, DEFAULT_AUTO_APPROVE_THRESHOLD),
        AutoBand::Pending
    );
}

#[test]
fn low_confidence_lands_in_band_c() {
    let mut c = clean_candidate();
    c.confidence = 0.40;
    assert_eq!(
        classify_band(&c, DEFAULT_AUTO_APPROVE_THRESHOLD),
        AutoBand::Reject
    );
}

#[test]
fn high_confidence_decision_lands_in_band_a() {
    // Feedback del usuario 2026-07-02: las decisiones entran solas por confianza
    // (antes forzaban Pending a cualquier confianza = fricción permanente).
    let mut c = MemoryCandidate::new(MemoryType::Decision, Scope::Project);
    c.confidence = 0.99;
    assert_eq!(
        classify_band(&c, DEFAULT_AUTO_APPROVE_THRESHOLD),
        AutoBand::Approve
    );
}

#[test]
fn mid_confidence_decision_still_pending() {
    // Caso negativo: la confianza sigue mandando — una decisión de confianza
    // media NO se auto-aprueba (banda B, la reviso en sesión).
    let mut c = MemoryCandidate::new(MemoryType::Architecture, Scope::Project);
    c.confidence = 0.65;
    assert_eq!(
        classify_band(&c, DEFAULT_AUTO_APPROVE_THRESHOLD),
        AutoBand::Pending
    );
}

#[test]
fn infinite_threshold_keeps_everything_out_of_band_a() {
    // FAIL-SAFE: a settings read error yields f32::INFINITY, so even a 0.99
    // fact cannot clear BAND A — it degrades to pending, never auto-approve.
    let mut c = clean_candidate();
    c.confidence = 0.99;
    assert_eq!(classify_band(&c, f32::INFINITY), AutoBand::Pending);
}

// --- L9 (auditoría 2026-10-26): el umbral de banda A se valida ---

#[test]
fn threshold_valido_solo_entre_el_suelo_de_ruido_y_uno() {
    assert!(threshold_is_valid(REJECT_THRESHOLD));
    assert!(threshold_is_valid(DEFAULT_AUTO_APPROVE_THRESHOLD));
    assert!(threshold_is_valid(1.0));
    for malo in [0.0, -1.0, 0.54, 1.01, f32::NAN, f32::INFINITY] {
        assert!(!threshold_is_valid(malo), "{malo} pasó");
    }
}

#[test]
fn un_threshold_fuera_de_rango_cierra_la_banda_a() {
    let leido =
        |t: &str| threshold_from_settings_json(&format!(r#"{{"auto_approve_threshold": {t}}}"#));
    assert!((leido("0.8") - 0.8).abs() < 1e-6);
    // Caso negativo: con 0.0 o un negativo, antes todo candidato limpio
    // entraba en la banda A.
    assert_eq!(leido("0.0"), f32::INFINITY);
    assert_eq!(leido("-3"), f32::INFINITY);
    assert_eq!(threshold_from_settings_json("no json"), f32::INFINITY);
}

#[test]
fn write_settings_rechaza_un_threshold_fuera_de_rango() {
    let malo = MemorySettings {
        auto_approve_threshold: 0.1,
        ..MemorySettings::default()
    };
    // Falla antes de tocar disco: no depende de HOME.
    assert!(write_settings(malo).unwrap_err().contains("fuera de rango"));
}
