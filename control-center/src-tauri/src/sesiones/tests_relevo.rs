// sesiones/tests_relevo.rs — Tests del relevo: detección del aviso, hora de
// vuelta, traspaso, escalado y carreras sobre el estado por sesión.

use chrono::{Local, TimeZone};
use serde_json::json;

use super::aviso::{detect_usage_limit_at, estimate_return};
use super::prompt::{
    compose_escalation, compose_relay_context, pending_request, relay_history, RelayMessage,
    HANDOFF_INTRO,
};
use super::*;
use crate::sesiones::types::{PlanUsage, UsageSource, UsageWindow};

fn synthetic(text: &str) -> serde_json::Value {
    json!({"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":text}]}})
}

fn noon_oct_28() -> chrono::DateTime<Local> {
    Local
        .with_ymd_and_hms(2026, 10, 28, 12, 0, 0)
        .single()
        .expect("hora local")
}

fn local_at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> String {
    Local
        .with_ymd_and_hms(y, mo, d, h, mi, 0)
        .single()
        .expect("hora local")
        .to_rfc3339()
}

fn usage(five: Option<(f64, &str)>, seven: Option<(f64, &str)>) -> PlanUsage {
    let w = |x: Option<(f64, &str)>| {
        x.map(|(percent, at)| UsageWindow {
            percent,
            resets_at: Some(at.to_string()),
        })
    };
    PlanUsage {
        five_hour: w(five),
        seven_day: w(seven),
        subscription_type: None,
        stale: false,
        source: UsageSource::Local,
        fetched_at_ms: 0,
        last_error: None,
    }
}

fn task(id: &str, sid: &str, engine: &str, prompt: &str, status: &str) -> EngineTask {
    EngineTask {
        id: id.into(),
        engine: engine.into(),
        kind: "relay".into(),
        mode: "local".into(),
        cwd: ".".into(),
        prompt: prompt.into(),
        status: status.into(),
        started_at: String::new(),
        finished_at: None,
        events: Vec::new(),
        summary: None,
        cloud_task_id: None,
        session_id: Some(sid.into()),
        thread_id: None,
        context_chars: 0,
        model: None,
        brought_at: None,
        anchor_message_uuid: None,
        usage: None,
        group: None,
    }
}

// --- Detección del aviso -------------------------------------------------

#[test]
fn detecta_limites_de_sesion_y_semanal_con_hora() {
    let session = detect_usage_limit(&synthetic(
        "You've hit your session limit · resets 1:20am (Europe/Madrid)",
    ))
    .expect("sesión");
    assert_eq!(session.reset_time, "1:20am");
    assert_eq!(session.kind, LimitKind::Session);
    let weekly = detect_usage_limit(&synthetic(
        "You've hit your weekly limit · resets 10:45pm (Europe/Madrid)",
    ))
    .expect("semanal");
    assert_eq!(weekly.reset_time, "10:45pm");
    assert_eq!(weekly.kind, LimitKind::Weekly);
}

#[test]
fn rechaza_otros_mensajes_sinteticos() {
    for text in [
        "API Error: Connection lost mid-response...",
        "Request timed out",
        "API Error: Connection dropped (ECONNRESET)",
        "No response requested.",
        "Failed to authenticate: OAuth token revoked...",
        "API Error: 429 rate limit reached, retrying",
    ] {
        assert!(detect_usage_limit(&synthetic(text)).is_none(), "{text}");
    }
    let mut normal = synthetic("You've hit your session limit · resets 1:20am");
    normal["message"]["model"] = json!("claude-opus");
    assert!(detect_usage_limit(&normal).is_none());
}

#[test]
fn detecta_variantes_de_redaccion_del_aviso() {
    let now = noon_oct_28();
    let tipografico = detect_usage_limit_at(
        &synthetic("You\u{2019}ve hit your session limit · resets 1:20am"),
        now,
    );
    assert_eq!(tipografico.map(|l| l.reset_time).as_deref(), Some("1:20am"));
    let reached = detect_usage_limit_at(&synthetic("5-hour limit reached ∙ resets 3pm"), now)
        .expect("limit reached");
    assert_eq!(reached.return_at, Some(local_at(2026, 10, 28, 15, 0)));
    let opus = detect_usage_limit_at(
        &synthetic("Opus weekly limit reached · resets Oct 30, 9am"),
        now,
    )
    .expect("opus semanal");
    assert_eq!(opus.kind, LimitKind::Weekly);
}

#[test]
fn un_aviso_sin_hora_dispara_el_relevo_con_vuelta_desconocida() {
    let sin_hora =
        detect_usage_limit(&synthetic("You've hit your usage limit.")).expect("aviso sin hora");
    assert_eq!(sin_hora.return_at, None);
    assert_eq!(sin_hora.reset_time, "");
    let epoch = detect_usage_limit(&synthetic("Claude AI usage limit reached|1793000000"))
        .expect("formato antiguo");
    let esperado = Local
        .timestamp_opt(1_793_000_000, 0)
        .single()
        .expect("instante")
        .to_rfc3339();
    assert_eq!(epoch.return_at, Some(esperado));
}

#[test]
fn segunda_senal_solo_con_la_muestra_al_100() {
    let llena = usage(Some((100.0, "2026-10-28T15:00:00Z")), None);
    let media = usage(Some((60.0, "2026-10-28T15:00:00Z")), None);
    let raro = synthetic("Usage limit exceeded for this plan");
    assert!(detect_usage_limit(&raro).is_none(), "redacción desconocida");
    let l = detect_by_usage(&raro, Some(&llena)).expect("segunda señal");
    assert_eq!(l.return_at.as_deref(), Some("2026-10-28T15:00:00Z"));
    assert!(detect_by_usage(&raro, Some(&media)).is_none());
    assert!(detect_by_usage(&raro, None).is_none());
    let mut normal = raro.clone();
    normal["message"]["model"] = json!("claude-opus");
    assert!(detect_by_usage(&normal, Some(&llena)).is_none());
}

// --- Hora de vuelta -------------------------------------------------------

#[test]
fn hora_en_punto_y_fecha_del_aviso() {
    let now = noon_oct_28();
    let tres = estimate_return("3pm", now).map(|d| d.to_rfc3339());
    assert_eq!(tres, Some(local_at(2026, 10, 28, 15, 0)));
    let pasada = estimate_return("9am", now).map(|d| d.to_rfc3339());
    assert_eq!(
        pasada,
        Some(local_at(2026, 10, 29, 9, 0)),
        "ya pasó: mañana"
    );
    let fecha = estimate_return("oct 30, 9am", now).map(|d| d.to_rfc3339());
    assert_eq!(fecha, Some(local_at(2026, 10, 30, 9, 0)));
    let con_at = estimate_return("oct 30 at 9:15 am", now).map(|d| d.to_rfc3339());
    assert_eq!(con_at, Some(local_at(2026, 10, 30, 9, 15)));
    let enero = estimate_return("jan 2, 9am", now).map(|d| d.to_rfc3339());
    assert_eq!(enero, Some(local_at(2027, 1, 2, 9, 0)), "año siguiente");
    assert!(estimate_return("pronto", now).is_none());
    assert!(estimate_return("13pm", now).is_none());
}

#[test]
fn el_aviso_semanal_con_fecha_da_dia_y_hora() {
    let l = detect_usage_limit_at(
        &synthetic("You've hit your weekly limit · resets Oct 30, 9am (Europe/Madrid)"),
        noon_oct_28(),
    )
    .expect("semanal");
    assert_eq!(l.kind, LimitKind::Weekly);
    assert_eq!(l.reset_time, "oct 30, 9am");
    assert_eq!(l.return_at, Some(local_at(2026, 10, 30, 9, 0)));
}

#[test]
fn el_limite_semanal_vuelve_con_la_ventana_semanal_y_no_con_la_de_5h() {
    let u = usage(
        Some((40.0, "2026-10-28T14:00:00Z")),
        Some((100.0, "2026-10-30T08:00:00Z")),
    );
    let semanal = UsageLimit {
        kind: LimitKind::Weekly,
        reset_time: String::new(),
        return_at: None,
    };
    assert_eq!(
        pick_return(&semanal, Some(&u)).as_deref(),
        Some("2026-10-30T08:00:00Z")
    );
    let sesion = UsageLimit {
        kind: LimitKind::Session,
        ..semanal.clone()
    };
    assert_eq!(
        pick_return(&sesion, Some(&u)).as_deref(),
        Some("2026-10-28T14:00:00Z")
    );
    let aviso = UsageLimit {
        return_at: Some("aviso".into()),
        ..semanal
    };
    assert_eq!(pick_return(&aviso, None).as_deref(), Some("aviso"));
}

#[test]
fn no_vuelve_a_claude_si_la_muestra_sigue_al_100() {
    insert_for_test("rel-aplazar", "codex", "traspaso");
    let llena = usage(None, Some((100.0, "2026-10-30T08:00:00Z")));
    assert!(postpone_if_exhausted("rel-aplazar", Some(&llena)));
    let s = get("rel-aplazar").expect("estado");
    assert_eq!(s.return_at.as_deref(), Some("2026-10-30T08:00:00Z"));
    let media = usage(Some((80.0, "2026-10-28T15:00:00Z")), None);
    assert!(!postpone_if_exhausted("rel-aplazar", Some(&media)));
    assert!(!postpone_if_exhausted("rel-aplazar", None));
}

// --- Traspaso y escalado ---------------------------------------------------

#[test]
fn traspaso_incluye_fallo_doce_mensajes_y_git_sin_herramientas() {
    let mut messages = Vec::new();
    for i in 0..14 {
        messages.push(RelayMessage {
            role: if i % 2 == 0 { "Usuario" } else { "Claude" },
            text: format!("mensaje-{i}"),
        });
    }
    let prompt = compose_handoff("haz lo pendiente", &messages, " M src/lib.rs");
    assert!(prompt.starts_with(HANDOFF_INTRO));
    assert!(prompt.contains("haz lo pendiente") && prompt.contains("M src/lib.rs"));
    assert!(!prompt
        .lines()
        .any(|l| matches!(l, "mensaje-0" | "mensaje-1")));
    assert_eq!(
        prompt.matches("### Usuario\n").count() + prompt.matches("### Claude\n").count(),
        12
    );
    assert!(!prompt.contains("tool_use") && !prompt.contains("tool_result"));
}

#[test]
fn el_traspaso_y_el_escalado_redactan_secretos() {
    let secreto = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let messages = [RelayMessage {
        role: "Usuario",
        text: format!("usa esta key: {secreto}"),
    }];
    let handoff = compose_handoff("sigue", &messages, "");
    assert!(!handoff.contains(secreto), "{handoff}");
    assert!(handoff.contains("[REDACTED:"));
    let escalado = compose_escalation("traspaso", "codex", "", Some(secreto), "fallo");
    assert!(!escalado.contains(secreto));
    let contexto = compose_relay_context("traspaso", secreto);
    assert!(!contexto.contains(secreto));
}

#[test]
fn el_escalado_lleva_la_ultima_peticion_pendiente() {
    let handoff = format!("{HANDOFF_INTRO} resto del traspaso");
    let inicial = task("t-ini", "s", "codex", &handoff, "done");
    let seguimiento = task("t-seg", "s", "codex", "ahora migra los tests", "error");
    assert_eq!(
        pending_request(&inicial),
        None,
        "el traspaso no es petición"
    );
    assert_eq!(
        pending_request(&seguimiento).as_deref(),
        Some("ahora migra los tests")
    );
    insert_for_test("rel-pendiente", "codex", &handoff);
    let state = get("rel-pendiente").expect("estado");
    let text = escalation_prompt(&state, "codex", "cuota agotada", Some(&seguimiento));
    assert!(text.contains("Ultima peticion pendiente del usuario"));
    assert!(text.contains("ahora migra los tests"));
    assert!(text.contains("cuota agotada"));
    let sin = escalation_prompt(&state, "codex", "cuota agotada", Some(&inicial));
    assert!(!sin.contains("Ultima peticion pendiente"));
}

#[test]
fn el_historial_del_relevo_esta_acotado() {
    let mut tasks = Vec::new();
    for i in 0..10 {
        let mut t = task(
            &format!("h{i}"),
            "s",
            "codex",
            &format!("peticion-{i}"),
            "done",
        );
        t.summary = Some("x".repeat(10_000));
        tasks.push(t);
    }
    let h = relay_history(&tasks, Some("h9"));
    assert!(!h.contains("peticion-0") && !h.contains("peticion-2"));
    assert!(h.contains("peticion-3") && h.contains("peticion-8"));
    assert!(!h.contains("peticion-9"), "la tarea excluida no entra");
    assert!(h.chars().count() < 6 * 3_200, "{}", h.chars().count());
}

#[test]
fn gemini_recibe_el_traspaso_en_cada_turno_de_seguimiento() {
    assert_eq!(relay_context("rel-sin-relevo"), None);
    insert_for_test("rel-gemini", "gemini", "TRASPASO-ORIGINAL");
    let ctx = relay_context("rel-gemini").expect("contexto");
    assert!(ctx.starts_with("TRASPASO-ORIGINAL"));
}

// --- Estado y carreras -----------------------------------------------------

#[test]
fn dos_fallos_del_mismo_motor_solo_escalan_una_vez() {
    insert_for_test("rel-doble", "codex", "t");
    let primero = claim("rel-doble", "codex", "gemini").expect("primer escalado");
    assert_eq!(primero.active_engine, "gemini");
    assert!(claim("rel-doble", "codex", "gemini").is_none());
    assert_eq!(get("rel-doble").map(|s| s.generation), Some(1));
}

#[test]
fn tras_empezar_la_vuelta_no_se_escala_ni_se_lanza() {
    insert_for_test("rel-vuelta", "codex", "t");
    let gen = get("rel-vuelta").expect("estado").generation;
    begin_return("rel-vuelta").expect("empieza la vuelta");
    assert!(claim("rel-vuelta", "codex", "gemini").is_none());
    assert!(!is_current("rel-vuelta", gen), "lo lanzado se cancela");
    assert!(
        begin_return("rel-vuelta").is_err(),
        "una sola vuelta a la vez"
    );
    abort_return("rel-vuelta");
    assert!(claim("rel-vuelta", "codex", "gemini").is_some());
}

#[test]
fn una_tarea_ya_registrada_no_cambia_el_motor_activo() {
    insert_for_test("rel-track", "codex", "t");
    let vieja = task("rt-1", "rel-track", "codex", "x", "running");
    track_task(&vieja);
    claim("rel-track", "codex", "gemini").expect("escalado");
    let mut fin = vieja.clone();
    fin.status = "error".into();
    track_task(&fin);
    assert_eq!(
        get("rel-track").map(|s| s.active_engine).as_deref(),
        Some("gemini")
    );
    mark_error("rel-track", "codex", "fallo tardío".into());
    assert_eq!(get("rel-track").and_then(|s| s.error), None);
    let nueva = task("rt-2", "rel-track", "gemini", "y", "running");
    track_task(&nueva);
    assert_eq!(
        get("rel-track").map(|s| s.task_ids),
        Some(vec!["rt-1".to_string(), "rt-2".to_string()])
    );
}

// --- Cadena y máquina de estados ------------------------------------------

#[test]
fn cadena_api_codex_gemini_y_sin_key_salta_a_codex() {
    assert_eq!(first_engine(true), "opencode");
    assert_eq!(first_engine(false), "codex");
    assert_eq!(next_engine("opencode"), Some("codex"));
    assert_eq!(next_engine("codex"), Some("gemini"));
    assert_eq!(next_engine("gemini"), None);
    assert_eq!(relay_model("opencode").as_deref(), Some(API_MODEL));
    assert_eq!(relay_model("codex"), None);
}

#[test]
fn maquina_escala_y_solo_vuelve_sin_tarea_en_curso() {
    assert_eq!(transition(None, RelayEvent::Limit), RelayAction::StartApi);
    assert_eq!(
        transition(Some("opencode"), RelayEvent::Failed),
        RelayAction::StartCodex
    );
    assert_eq!(
        transition(Some("codex"), RelayEvent::Failed),
        RelayAction::StartGemini
    );
    assert_eq!(
        transition(Some("gemini"), RelayEvent::Failed),
        RelayAction::ShowError
    );
    assert_eq!(
        transition(Some("codex"), RelayEvent::Reset { running: true }),
        RelayAction::Wait
    );
    assert_eq!(
        transition(Some("codex"), RelayEvent::Reset { running: false }),
        RelayAction::ReturnToClaude
    );
}
