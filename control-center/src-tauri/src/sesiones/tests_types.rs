// Tests de los tipos del contrato de estabilidad (§4.5, §7.3): nombres en el
// cable y compatibilidad con el protocolo 1 del puente.

use serde_json::json;

use super::*;

fn plan(v: serde_json::Value) -> Result<AskAnswer, serde_json::Error> {
    serde_json::from_value(v)
}

#[test]
fn plan_del_protocolo_1_se_traduce_a_decision() {
    let a = plan(json!({ "kind": "plan", "approve": true })).expect("v1 aprobado");
    let AskAnswer::Plan(p) = a else {
        panic!("no es un plan")
    };
    assert_eq!(p.decision, PlanDecision::Approve);
    let b = plan(json!({ "kind": "plan", "approve": false, "feedback": "más" })).expect("v1");
    let AskAnswer::Plan(p) = b else {
        panic!("no es un plan")
    };
    assert_eq!(p.decision, PlanDecision::KeepPlanning);
    assert_eq!(p.feedback.as_deref(), Some("más"));
}

#[test]
fn plan_del_protocolo_2_con_modo() {
    let a =
        plan(json!({ "kind": "plan", "decision": "approve", "mode": "acceptEdits" })).expect("v2");
    let AskAnswer::Plan(p) = a else {
        panic!("no es un plan")
    };
    assert_eq!(p.decision, PlanDecision::Approve);
    assert_eq!(p.mode, Some(PermissionMode::AcceptEdits));
}

#[test]
fn plan_sin_decision_ni_approve_se_rechaza() {
    assert!(plan(json!({ "kind": "plan", "feedback": "x" })).is_err());
}

#[test]
fn plan_serializa_tambien_approve_para_el_mod_v1() {
    let a = AskAnswer::Plan(PlanAnswer {
        decision: PlanDecision::KeepPlanning,
        mode: None,
        feedback: None,
    });
    let v = serde_json::to_value(&a).expect("serializa");
    assert_eq!(
        v,
        json!({ "kind": "plan", "decision": "keepPlanning", "approve": false })
    );
}

#[test]
fn pregunta_rechazada_sin_respuestas() {
    let a: AskAnswer =
        serde_json::from_value(json!({ "kind": "question", "rejected": true })).expect("ok");
    assert_eq!(
        a,
        AskAnswer::Question {
            answers: Default::default(),
            rejected: true
        }
    );
    let normal = AskAnswer::Question {
        answers: [("q".to_string(), "a".to_string())].into(),
        rejected: false,
    };
    let v = serde_json::to_value(&normal).expect("serializa");
    assert!(v.get("rejected").is_none(), "rejected:false no viaja");
}

#[test]
fn nombres_en_el_cable() {
    let s = |v: serde_json::Value| v.as_str().unwrap_or_default().to_string();
    assert_eq!(
        s(json!(PermissionMode::BypassPermissions)),
        "bypassPermissions"
    );
    assert_eq!(s(json!(PermissionMode::DontAsk)), "dontAsk");
    assert_eq!(s(json!(PanelId::AddDir)), "addDir");
    assert_eq!(s(json!(QueueState::CliQueued)), "cliQueued");
    assert_eq!(s(json!(RecoverAction::ExitMenu)), "exitMenu");
    assert_eq!(s(json!(ScreenState::default())), "unknown");
    assert_eq!(s(json!(MessageKind::CompactSummary)), "compactSummary");
}

#[test]
fn valor_de_config_sin_etiqueta() {
    let v: Vec<ConfigValue> =
        serde_json::from_value(json!([true, 3, "x", ["a", "b"]])).expect("valores");
    assert_eq!(
        v,
        vec![
            ConfigValue::Bool(true),
            ConfigValue::Number(3.0),
            ConfigValue::Text("x".into()),
            ConfigValue::List(vec!["a".into(), "b".into()]),
        ]
    );
    assert!(serde_json::from_value::<ConfigValue>(json!({ "a": 1 })).is_err());
}

#[test]
fn op_result_minimo_solo_lleva_ok() {
    let r = OpResult {
        ok: true,
        ..OpResult::default()
    };
    assert_eq!(
        serde_json::to_value(&r).expect("serializa"),
        json!({ "ok": true })
    );
    let p = OpResult {
        pending: true,
        op_id: Some("op1".into()),
        ..OpResult::default()
    };
    assert_eq!(
        serde_json::to_value(&p).expect("serializa"),
        json!({ "ok": false, "pending": true, "opId": "op1" })
    );
}

#[test]
fn prefs_por_defecto() {
    let p = SessionPrefs::default();
    assert_eq!(p.launch_permission_mode, PermissionMode::BypassPermissions);
    assert_eq!(p.stall_seconds, 120);
    assert!(p.automatic_relay);
    let v = serde_json::to_value(&p).expect("serializa");
    assert_eq!(
        v,
        json!({ "launchPermissionMode": "bypassPermissions", "stallSeconds": 120, "automaticRelay": true })
    );
}

#[test]
fn clases_de_mensaje_y_comando_en_el_cable() {
    let v = serde_json::to_value([MessageKind::TaskNotification, MessageKind::CompactSummary])
        .expect("serializa");
    assert_eq!(v, json!(["taskNotification", "compactSummary"]));
    let k: Vec<CommandKind> = serde_json::from_value(json!(["menu", "exit"])).expect("kinds");
    assert_eq!(k, vec![CommandKind::Menu, CommandKind::Exit]);
    let d = serde_json::to_value(CommandDisposition::Menu).expect("disposition");
    assert_eq!(d, json!("menu"));
}
