// sesiones/tests_preguntas.rs — Registro de preguntas sin caducidad,
// cancelación por motivo, sondeo multiplexado y recuperación (§4.1-§4.2).

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use super::*;
use crate::sesiones::test_sink::MockSink;
use crate::sesiones::types::{PermissionDecision, PlanAnswer, PlanDecision};

fn permiso() -> Value {
    json!({ "kind": "permission", "tool": "Bash", "input": {}, "summary": "ls" })
}

fn permitir() -> AskAnswer {
    AskAnswer::Permission {
        decision: PermissionDecision::Allow,
        reason: None,
    }
}

#[test]
fn sin_ventana_el_ask_queda_pendiente_se_lista_y_avisa() {
    let b = Broker::new();
    let sink = MockSink::default();
    let p = b.abrir(&sink, "s1", &permiso(), None).expect("abrir");
    assert_eq!(b.pending_for("s1").len(), 1);
    assert_eq!(b.list(Some("s1"))[0]["askId"], p.ask_id.as_str());
    assert!(b.list(Some("otra")).is_empty());
    assert_eq!(sink.avisos.lock().expect("avisos").len(), 1);
}

#[test]
fn list_ve_el_pendiente_desde_otro_hilo() {
    let b = Arc::new(Broker::new());
    let sink = Arc::new(MockSink::opened());
    let (b2, s2) = (b.clone(), sink.clone());
    std::thread::spawn(move || b2.abrir(&*s2, "s1", &permiso(), None))
        .join()
        .expect("hilo")
        .expect("abrir");
    assert_eq!(b.list(None).len(), 1);
    assert!(
        sink.avisos.lock().expect("avisos").is_empty(),
        "con ventana, sin aviso"
    );
}

#[test]
fn cancelar_por_sesion_lo_ve_el_wait_y_responder_despues_es_gone() {
    let b = Arc::new(Broker::new());
    let sink = Arc::new(MockSink::opened());
    let p = b.abrir(&*sink, "s1", &permiso(), None).expect("abrir");
    let (b2, id) = (b.clone(), p.ask_id.clone());
    let h = std::thread::spawn(move || b2.esperar(&[id], Duration::from_secs(5)));
    std::thread::sleep(Duration::from_millis(30));
    let t = Instant::now();
    let canceladas = b.cancel_for(&*sink, "s1", AskCancelReason::Interrupted);
    assert_eq!(canceladas, vec![p.ask_id.clone()]);
    let r = h.join().expect("hilo");
    assert!(
        t.elapsed() < Duration::from_secs(1),
        "el wait vuelve al momento"
    );
    assert_eq!(
        r[0].resolucion,
        Resolucion::Cancelada(AskCancelReason::Interrupted)
    );
    assert_eq!(b.answer(&*sink, &p.ask_id, permitir()), Err(AskError::Gone));
    let resueltos = sink.payloads(ev::ASK_RESOLVED);
    assert_eq!(resueltos[0]["outcome"], "cancelled");
    assert_eq!(resueltos[0]["reason"], "interrupted");
}

#[test]
fn wait_multiplexado_vuelve_con_el_primero_resuelto() {
    let b = Arc::new(Broker::new());
    let sink = MockSink::opened();
    let a = b.abrir(&sink, "s1", &permiso(), None).expect("a");
    let c = b.abrir(&sink, "s1", &permiso(), None).expect("c");
    let ids = vec![a.ask_id.clone(), c.ask_id.clone(), "nadie".to_string()];
    b.answer(&sink, &c.ask_id, permitir()).expect("responder");
    let r = b.esperar(&ids, Duration::from_secs(5));
    assert_eq!(r[0].resolucion, Resolucion::Pendiente);
    assert_eq!(r[1].resolucion, Resolucion::Respondida(permitir()));
    assert_eq!(
        r[2].resolucion,
        Resolucion::Cancelada(AskCancelReason::Unknown)
    );
    assert_eq!(resultado_json(&r[1])["status"], "answered");
}

#[test]
fn wait_sin_cambios_vence_su_plazo() {
    let b = Broker::new();
    let sink = MockSink::opened();
    let a = b.abrir(&sink, "s1", &permiso(), None).expect("a");
    let t = Instant::now();
    let r = b.esperar(&[a.ask_id], Duration::from_millis(80));
    assert!(t.elapsed() >= Duration::from_millis(80));
    assert_eq!(r[0].resolucion, Resolucion::Pendiente);
}

#[test]
fn respuesta_de_otro_tipo_es_invalida_y_no_resuelve() {
    let b = Broker::new();
    let sink = MockSink::opened();
    let a = b.abrir(&sink, "s1", &permiso(), None).expect("a");
    let plan = AskAnswer::Plan(PlanAnswer {
        decision: PlanDecision::Approve,
        mode: None,
        feedback: None,
    });
    assert_eq!(b.answer(&sink, &a.ask_id, plan), Err(AskError::Invalid));
    assert_eq!(b.pending_for("s1").len(), 1);
    assert_eq!(AskError::Gone.codigo(), "ask_gone");
}

#[test]
fn protocolo_1_bloquea_hasta_la_respuesta() {
    let b = Arc::new(Broker::new());
    let sink = Arc::new(MockSink::opened());
    let (b2, s2) = (b.clone(), sink.clone());
    let h = std::thread::spawn(move || b2.ask(&*s2, "s1", &permiso()));
    let ask_id = loop {
        if let Some(p) = b.pending_for("s1").first() {
            break p.ask_id.clone();
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    b.answer(&*sink, &ask_id, permitir()).expect("responder");
    assert_eq!(h.join().expect("hilo").expect("ok"), Some(permitir()));
}

#[test]
fn rechaza_tipo_desconocido_y_payload_lleva_ids() {
    let sink = MockSink::default();
    assert!(Broker::new()
        .abrir(&sink, "s1", &json!({"kind": "otro"}), None)
        .is_err());
    let p = build_payload("s9", &permiso()).expect("payload");
    assert_eq!(p["id"], "s9");
    assert!(p["askId"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(p["agentId"].is_null());
    assert!(p["createdAt"].as_str().is_some_and(|s| !s.is_empty()));
}
