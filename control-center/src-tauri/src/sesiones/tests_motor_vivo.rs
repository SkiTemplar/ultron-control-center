use super::*;
#[path = "tests_motor_vivo_soporte.rs"]
mod soporte;
use soporte::*;
#[path = "tests_motor_vivo_comandos.rs"]
mod comandos;
#[path = "tests_motor_vivo_opencode.rs"]
mod opencode;
#[path = "tests_motor_vivo_permisos.rs"]
mod permisos;
#[path = "tests_motor_vivo_permisos_estado.rs"]
mod permisos_estado;
#[path = "tests_motor_vivo_protocolo.rs"]
mod protocolo;

#[test]
fn acp_emite_usuario_instantaneas_fin_y_transcript_definitivo() {
    let e = Ensayo::nuevo("gemini");
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "gemini");
        delta(&a, "gemini", "respuesta");
        completar(&a, "gemini", &p);
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    let mensajes = e.sink.payloads(ev::MESSAGES);
    assert_eq!(mensajes[0]["messages"][0]["kind"], "prompt");
    assert_eq!(
        mensajes.last().unwrap()["messages"][0]["blocks"][0]["text"],
        "respuesta"
    );
    assert_eq!(e.sink.payloads(ev::TURN)[0]["reason"], "answer");
    let historial = history(&e.id, None, None).unwrap();
    assert_eq!(historial.messages.len(), 2);
    assert_eq!(
        historial.messages[1].uuid,
        mensajes.last().unwrap()["messages"][0]["uuid"]
    );
    assert_eq!(e.exec.load(Ordering::SeqCst), 0);
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn codex_espera_la_notificacion_despues_del_acuse() {
    let e = Ensayo::nuevo("codex");
    let (seguir, esperar_fin) = mpsc::channel();
    let servidor = e.servidor(false, move |a| {
        let p = aceptar_turno(&a, "codex");
        esperar_fin.recv_timeout(Duration::from_secs(5)).unwrap();
        delta(&a, "codex", "terminado");
        completar(&a, "codex", &p);
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    assert!(matches!(
        motor_sesion::get(&e.id).unwrap().turno,
        motor_sesion::Turno::Vivo(_)
    ));
    assert!(e.sink.payloads(ev::TURN).is_empty());
    seguir.send(()).unwrap();
    e.libre();
    assert_eq!(e.sink.payloads(ev::TURN).len(), 1);
    assert_eq!(
        motor_sesion::get(&e.id).unwrap().thread_id.as_deref(),
        Some("hilo-falso")
    );
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn cincuenta_deltas_se_coalescen_y_el_ultimo_sale_completo() {
    let e = Ensayo::nuevo("gemini");
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "gemini");
        for _ in 0..50 {
            delta(&a, "gemini", "x");
        }
        completar(&a, "gemini", &p);
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    let emisiones = e.sink.payloads(ev::MESSAGES);
    assert!(emisiones.len() < 50);
    assert_eq!(
        emisiones.last().unwrap()["messages"][0]["blocks"][0]["text"],
        "x".repeat(50)
    );
    assert_eq!(transcript::leer(&e.id).unwrap().unwrap().len(), 2);
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn permiso_acp_en_bypass_contesta_sin_aviso() {
    let e = Ensayo::nuevo("gemini");
    motor_sesion::set_permission_mode(
        &e.id,
        crate::sesiones::types::PermissionMode::BypassPermissions,
    )
    .unwrap();
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "gemini");
        a.enviar(json!({"id":"permiso","method":"session/request_permission","params":{"toolCall":{"title":"editar","kind":"edit"},"options":[{"optionId":"una","name":"Una vez","kind":"allow_once"}]}}));
        assert_eq!(a.leer_linea(), "{\"id\":\"permiso\",\"jsonrpc\":\"2.0\",\"result\":{\"outcome\":{\"optionId\":\"una\",\"outcome\":\"selected\"}}}\n");
        completar(&a, "gemini", &p); a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    assert!(e.sink.payloads(ev::NOTICE).is_empty());
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn initialize_fallido_cae_a_exec_con_notice_warn() {
    let e = Ensayo::nuevo("gemini");
    motor_sesion::set_permission_mode(
        &e.id,
        crate::sesiones::types::PermissionMode::BypassPermissions,
    )
    .unwrap();
    let servidor = e.servidor(true, |a| a.esperar_cierre());
    let t = e.enviar().unwrap();
    assert_eq!(e.exec.load(Ordering::SeqCst), 1);
    assert!(e
        .sink
        .payloads(ev::NOTICE)
        .iter()
        .any(|n| n["level"] == "warn" && n["text"].as_str().unwrap().contains("inicio rechazado")));
    motor::terminar_para_prueba(&t.id, "done", "exec", None);
    servidor.join().unwrap();
}

#[test]
fn muerte_durante_turno_descarta_y_relanzara() {
    let e = Ensayo::nuevo("codex");
    let primero = e.servidor(false, |a| {
        aceptar_turno(&a, "codex");
        delta(&a, "codex", "parcial");
        a.cerrar();
    });
    e.enviar().unwrap();
    e.libre();
    esperar(|| obtener(&e.id).is_none());
    assert_eq!(e.sink.payloads(ev::TURN)[0]["reason"], "error");
    assert!(e
        .sink
        .payloads(ev::NOTICE)
        .iter()
        .any(|n| n["level"] == "error"));
    let segundo = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "codex");
        completar(&a, "codex", &p);
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    assert_eq!(e.arranques.load(Ordering::SeqCst), 2);
    motor_sesion::kill(&e.id).unwrap();
    primero.join().unwrap();
    segundo.join().unwrap();
}

#[test]
fn el_motivo_de_fin_se_traduce_al_del_front() {
    for (crudo, front) in [
        ("end_turn", "answer"),
        ("completed", "answer"),
        ("max_tokens", "answer"),
        ("cancelled", "aborted"),
        ("interrupted", "aborted"),
        ("refusal", "refusal"),
        ("failed", "error"),
        ("error", "error"),
    ] {
        assert_eq!(turno::motivo_turno(crudo), front, "{crudo}");
    }
}

#[test]
fn error_del_prompt_acp_avisa_una_sola_vez() {
    let e = Ensayo::nuevo("gemini");
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "gemini");
        a.enviar(
            json!({"jsonrpc":"2.0","id":p["id"],"error":{"code":-32000,"message":"cuota agotada"}}),
        );
        a.esperar_cierre();
    });
    let _ = e.enviar();
    e.libre();
    let errores = e
        .sink
        .payloads(ev::NOTICE)
        .into_iter()
        .filter(|n| n["level"] == "error")
        .count();
    assert_eq!(errores, 1);
    assert_eq!(e.sink.payloads(ev::TURN)[0]["reason"], "error");
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn historial_pagina_por_turnos_y_detecta_cursor_perdido() {
    let e = Ensayo::nuevo("gemini");
    let a = transcript::usuario("uno", &[]);
    let b = transcript::usuario("dos", &[]);
    transcript::anexar(&e.id, &[a.clone(), b.clone()]).unwrap();
    let p = history(&e.id, None, Some(1)).unwrap();
    assert!(p.has_more);
    assert_eq!(p.messages, vec![b.clone()]);
    let p = history(&e.id, Some(&b.uuid), Some(1)).unwrap();
    assert!(!p.has_more);
    assert_eq!(p.messages, vec![a]);
    assert_eq!(
        history(&e.id, Some("ausente"), None).unwrap_err(),
        "history_cursor_gone"
    );
    motor_sesion::kill(&e.id).unwrap();
    assert_eq!(history(&e.id, None, None).unwrap().messages.len(), 2);
}

#[test]
fn historial_fusiona_turnos_exec_y_transcript_por_fecha() {
    let e = Ensayo::nuevo("gemini");
    let t = motor_sesion::send_con(
        &e.id,
        &motor_sesion::Mensaje {
            text: "por exec",
            ..Default::default()
        },
        &|s, _, _, _| motor::lanzar_para_prueba(s),
    )
    .unwrap();
    motor::terminar_para_prueba(&t.id, "done", "respuesta exec", None);
    std::thread::sleep(Duration::from_millis(5));
    let vivo = transcript::usuario("por proceso vivo", &[]);
    transcript::anexar(&e.id, std::slice::from_ref(&vivo)).unwrap();
    let p = history(&e.id, None, None).unwrap();
    let textos: Vec<String> = p
        .messages
        .iter()
        .map(|m| serde_json::to_string(&m.blocks).unwrap())
        .collect();
    assert_eq!(p.messages.len(), 3, "{textos:?}");
    assert!(textos[0].contains("por exec"));
    assert!(textos[1].contains("respuesta exec"));
    assert_eq!(p.messages[2].uuid, vivo.uuid);
    motor_sesion::kill(&e.id).unwrap();
}

#[test]
fn turno_exec_da_el_usuario_al_lanzarse_y_el_par_al_terminar_con_los_uuid_del_historial() {
    let e = Ensayo::nuevo("codex");
    let t = motor_sesion::send_con(
        &e.id,
        &motor_sesion::Mensaje {
            text: "caída a exec",
            ..Default::default()
        },
        &|s, _, _, _| motor::lanzar_para_prueba(s),
    )
    .unwrap();
    let (sid, en_curso) = mensajes_turno_exec(&t).unwrap();
    assert_eq!(sid, e.id);
    assert_eq!(en_curso.len(), 1);
    motor::terminar_para_prueba(&t.id, "done", "hecho", None);
    let fin = motor::turnos_de_sesion(&e.id).pop().unwrap();
    let (_, par) = mensajes_turno_exec(&fin).unwrap();
    assert_eq!(par.len(), 2);
    assert_eq!(par[0].uuid, en_curso[0].uuid);
    let historial = history(&e.id, None, None).unwrap();
    assert_eq!(
        historial
            .messages
            .iter()
            .map(|m| &m.uuid)
            .collect::<Vec<_>>(),
        par.iter().map(|m| &m.uuid).collect::<Vec<_>>()
    );
    motor_sesion::kill(&e.id).unwrap();
}

#[test]
fn sesion_antigua_convierte_pares_con_uuid_estable_sin_escribir() {
    let e = Ensayo::nuevo("gemini");
    let t = motor_sesion::send_con(
        &e.id,
        &motor_sesion::Mensaje {
            text: "antes",
            ..Default::default()
        },
        &|s, _, _, _| motor::lanzar_para_prueba(s),
    )
    .unwrap();
    motor::terminar_para_prueba(&t.id, "done", "respuesta antigua", None);
    let a = history(&e.id, None, None).unwrap();
    motor_sesion::kill(&e.id).unwrap();
    let b = history(&e.id, None, None).unwrap();
    assert_eq!(a, b);
    assert_eq!(a.messages.len(), 2);
    assert_eq!(a.messages[0].kind, super::super::types::MessageKind::Prompt);
    assert!(transcript::leer(&e.id).unwrap().is_none());
}

#[test]
fn interrupcion_acp_envia_cancel_y_conserva_proceso() {
    let e = Ensayo::nuevo("gemini");
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "gemini");
        assert_eq!(
            a.leer(),
            json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"hilo-falso"}})
        );
        a.responder(&p, json!({"stopReason":"cancelled"}));
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    interrumpir(&e.id).unwrap();
    e.libre();
    assert!(obtener(&e.id).is_some());
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn interrupcion_codex_envia_interrupt() {
    let e = Ensayo::nuevo("codex");
    let (aceptado, listo) = mpsc::channel();
    let servidor = e.servidor(false, move |a| {
        let p = aceptar_turno(&a, "codex");
        a.enviar(json!({"method":"turn/started","params":{"turn":{"id":"turno-falso"}}}));
        aceptado.send(()).unwrap();
        let interrumpir = a.leer();
        assert_eq!(interrumpir["method"], "turn/interrupt");
        assert_eq!(
            interrumpir["params"],
            json!({"threadId":"hilo-falso","turnId":"turno-falso"})
        );
        a.responder(&interrumpir, json!({}));
        completar(&a, "codex", &p);
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    listo.recv_timeout(Duration::from_secs(5)).unwrap();
    esperar(|| e.sink.payloads(ev::TURN).is_empty());
    // El acuse y turn/started recorren el mismo lector antes de interrupt.
    interrumpir(&e.id).unwrap();
    e.libre();
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn kill_termina_una_vez_y_quita_el_vivo() {
    let e = Ensayo::nuevo("gemini");
    let servidor = e.servidor(false, |a| {
        aceptar_turno(&a, "gemini");
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    motor_sesion::kill(&e.id).unwrap();
    esperar(|| e.cierres.load(Ordering::SeqCst) == 1);
    assert!(obtener(&e.id).is_none());
    assert_eq!(
        motor_sesion::get(&e.id).unwrap().turno,
        motor_sesion::Turno::Libre
    );
    servidor.join().unwrap();
}

#[test]
#[ignore = "real: lanza agy acp"]
fn agy_real_responde_en_directorio_temporal() {
    let e = Ensayo::nuevo("gemini");
    motor_sesion::send(
        &e.id,
        &motor_sesion::Mensaje {
            text: "Responde solo OK",
            ..Default::default()
        },
    )
    .unwrap();
    let fin = Instant::now() + Duration::from_secs(120);
    while motor_sesion::get(&e.id).unwrap().turno != motor_sesion::Turno::Libre {
        assert!(Instant::now() < fin);
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(history(&e.id, None, None).unwrap().messages.len() >= 2);
}

#[test]
fn initialize_fallido_fuera_de_bypass_no_cae_a_exec() {
    // exec corre con acceso total: con Aceptar ediciones no puede sustituir al
    // proceso persistente.
    let e = Ensayo::nuevo("gemini");
    let servidor = e.servidor(true, |a| a.esperar_cierre());
    let error = e.enviar().unwrap_err();
    assert_eq!(e.exec.load(Ordering::SeqCst), 0);
    assert!(error.contains("no respeta el modo acceptEdits"), "{error}");
    assert_eq!(
        motor_sesion::get(&e.id).unwrap().turno,
        motor_sesion::Turno::Libre
    );
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}
