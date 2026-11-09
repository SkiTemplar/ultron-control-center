//! Permisos herméticos: mismos asks que Claude, decisiones propias del motor.
use super::*;
use crate::sesiones::preguntas::Broker;
use crate::sesiones::types::{AskAnswer, PermissionDecision, PermissionMode, SessionStatus};

pub(super) fn pedir(a: &Agente, engine: &str) {
    if engine == "codex" {
        a.enviar(json!({"id":81,"method":"item/commandExecution/requestApproval","params":{"command":"pwsh.exe -Command 'git status'"}}));
    } else {
        a.enviar(json!({"id":81,"method":"session/request_permission","params":{"toolCall":{"title":"git status","kind":"execute","rawInput":{"command":"git status"}},"options":[
            {"optionId":"op-una","name":"Una vez","kind":"allow_once"},
            {"optionId":"op-siempre","name":"Siempre","kind":"allow_always"},
            {"optionId":"op-no","name":"Denegar","kind":"reject_once"}]}}));
    }
}

pub(super) fn pendiente(e: &Ensayo) -> String {
    esperar(|| !Broker::global().pending_for(&e.id).is_empty());
    let ask = Broker::global().pending_for(&e.id).remove(0);
    assert_eq!(ask.kind, "permission");
    assert_eq!(ask.payload["always"]["destination"], "session");
    assert_eq!(ask.payload["always"]["rules"][0], "git status");
    assert_eq!(ask.payload["input"]["command"], "git status");
    let info = motor_sesion::get(&e.id).unwrap().info();
    assert_eq!(info.status, SessionStatus::Waiting);
    assert_eq!(
        info.waiting.unwrap().ask_id.as_deref(),
        Some(ask.ask_id.as_str())
    );
    ask.ask_id
}

fn aprobar(engine: &'static str, decision: PermissionDecision, esperado: &'static str) {
    let e = Ensayo::nuevo(engine);
    motor_sesion::set_permission_mode(&e.id, PermissionMode::Default).unwrap();
    let (seguir, fin) = mpsc::channel();
    let (respondido, recibido) = mpsc::channel();
    let servidor = e.servidor(false, move |a| {
        let p = aceptar_turno(&a, engine);
        pedir(&a, engine);
        let r = a.leer();
        assert_eq!(r["id"], 81);
        comprobar_decision(&r, engine, esperado);
        respondido.send(()).unwrap();
        fin.recv_timeout(Duration::from_secs(5)).unwrap();
        completar(&a, engine, &p);
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    let ask = pendiente(&e);
    assert!(!crate::sesiones::comandos::requiere_regla_claude(&e.id));
    Broker::global()
        .answer(
            &*e.sink,
            &ask,
            AskAnswer::Permission {
                decision,
                reason: None,
            },
        )
        .unwrap();
    recibido.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        motor_sesion::get(&e.id).unwrap().info().status,
        SessionStatus::Working
    );
    assert!(motor_sesion::get(&e.id).unwrap().info().waiting.is_none());
    assert!(
        !std::path::Path::new(&motor_sesion::get(&e.id).unwrap().cwd)
            .join(".claude/settings.local.json")
            .exists()
    );
    seguir.send(()).unwrap();
    e.libre();
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

fn comprobar_decision(r: &serde_json::Value, engine: &str, esperado: &str) {
    let valor = if engine == "codex" {
        &r["result"]["decision"]
    } else {
        &r["result"]["outcome"]["optionId"]
    };
    assert_eq!(valor, esperado);
}

#[test]
fn acp_default_abre_tarjeta_y_permite_una_vez() {
    aprobar("gemini", PermissionDecision::Allow, "op-una");
}
#[test]
fn acp_siempre_usa_opcion_de_sesion_sin_fichero_claude() {
    aprobar("gemini", PermissionDecision::AllowAlways, "op-siempre");
}
#[test]
fn acp_denegar_usa_opcion_real() {
    aprobar("gemini", PermissionDecision::Deny, "op-no");
}
#[test]
fn codex_denegar_envia_decline() {
    aprobar("codex", PermissionDecision::Deny, "decline");
}
#[test]
fn codex_siempre_envia_accept_for_session() {
    aprobar("codex", PermissionDecision::AllowAlways, "acceptForSession");
}

#[test]
fn bypass_no_abre_tarjeta_ni_avisa() {
    for engine in ["codex", "gemini"] {
        let e = Ensayo::nuevo(engine);
        motor_sesion::set_permission_mode(&e.id, PermissionMode::BypassPermissions).unwrap();
        let servidor = e.servidor(false, move |a| {
            let p = aceptar_turno(&a, engine);
            pedir(&a, engine);
            let r = a.leer();
            assert_eq!(
                if engine == "codex" {
                    &r["result"]["decision"]
                } else {
                    &r["result"]["outcome"]["optionId"]
                },
                if engine == "codex" {
                    "accept"
                } else {
                    "op-una"
                }
            );
            completar(&a, engine, &p);
            a.esperar_cierre();
        });
        e.enviar().unwrap();
        e.libre();
        assert!(e.sink.payloads(ev::ASK).is_empty());
        assert!(e.sink.payloads(ev::NOTICE).is_empty());
        motor_sesion::kill(&e.id).unwrap();
        servidor.join().unwrap();
    }
}

#[test]
fn codex_aplica_los_cuatro_modos_al_hilo_y_al_turno() {
    for (modo, aprobacion, sandbox) in [
        (PermissionMode::Default, "untrusted", "workspaceWrite"),
        (PermissionMode::AcceptEdits, "on-request", "workspaceWrite"),
        (PermissionMode::Plan, "on-request", "readOnly"),
        (
            PermissionMode::BypassPermissions,
            "never",
            "dangerFullAccess",
        ),
    ] {
        let e = Ensayo::nuevo("codex");
        motor_sesion::set_permission_mode(&e.id, modo).unwrap();
        let servidor = e.servidor(false, move |a| {
            let p = aceptar_turno(&a, "codex");
            assert_eq!(p["params"]["approvalPolicy"], aprobacion);
            assert_eq!(p["params"]["sandboxPolicy"]["type"], sandbox);
            completar(&a, "codex", &p);
            a.esperar_cierre();
        });
        e.enviar().unwrap();
        e.libre();
        motor_sesion::kill(&e.id).unwrap();
        servidor.join().unwrap();
    }
}

#[test]
fn cambiar_modo_acp_vivo_envia_id_traducido() {
    let e = Ensayo::nuevo("gemini");
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "gemini");
        completar(&a, "gemini", &p);
        let cambio = a.leer();
        assert_eq!(cambio["method"], "session/set_mode");
        assert_eq!(cambio["params"]["modeId"], "plan");
        a.responder(&cambio, json!({}));
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    assert!(
        motor_sesion::set_permission_mode(&e.id, PermissionMode::Plan)
            .unwrap()
            .ok
    );
    assert_eq!(
        motor_sesion::get(&e.id).unwrap().permission_mode,
        PermissionMode::Plan
    );
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn modo_acp_sin_equivalente_informa_motor_y_modo() {
    let e = Ensayo::nuevo("gemini");
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "gemini");
        completar(&a, "gemini", &p);
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    obtener(&e.id)
        .unwrap()
        .estado
        .lock()
        .unwrap()
        .modos
        .retain(|m| !matches!(m.id.as_str(), "yolo" | "accept-edits"));
    let resultado =
        motor_sesion::set_permission_mode(&e.id, PermissionMode::BypassPermissions).unwrap();
    assert!(!resultado.ok);
    let error = resultado.error.unwrap();
    assert!(error.contains("gemini") && error.contains("bypassPermissions"));
    assert_eq!(
        motor_sesion::get(&e.id).unwrap().permission_mode,
        PermissionMode::AcceptEdits
    );
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn interrumpir_cancela_tarjeta_y_rechaza_en_el_motor() {
    let e = Ensayo::nuevo("gemini");
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "gemini");
        pedir(&a, "gemini");
        let mut rechazado = false;
        let mut cancelado = false;
        for _ in 0..2 {
            let r = a.leer();
            rechazado |= r["result"]["outcome"]["optionId"] == "op-no";
            cancelado |= r["method"] == "session/cancel";
        }
        assert!(rechazado && cancelado);
        completar(&a, "gemini", &p);
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    let ask = pendiente(&e);
    interrumpir(&e.id).unwrap();
    e.libre();
    let estado = Broker::global().esperar(&[ask], Duration::ZERO);
    assert!(matches!(
        estado[0].resolucion,
        crate::sesiones::preguntas::Resolucion::Cancelada(
            crate::sesiones::types::AskCancelReason::Interrupted
        )
    ));
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn claude_conserva_el_guardado_de_reglas() {
    assert!(crate::sesiones::comandos::requiere_regla_claude(
        "claude-aislado"
    ));
}
