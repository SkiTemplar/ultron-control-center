//! Regresiones del cableado con las capturas versionadas de ambos servidores.
use super::*;
use crate::sesiones::types::{Block, MessageKind};

#[test]
fn captura_agy_150_conserva_herramientas_y_usage() {
    let e = Ensayo::nuevo("gemini");
    motor_sesion::set_permission_mode(
        &e.id,
        crate::sesiones::types::PermissionMode::BypassPermissions,
    )
    .unwrap();
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "gemini");
        for linea in include_str!("fixtures/acp-agy-1.5.0-turno.ndjson").lines() {
            let Some(linea) = linea.strip_prefix("< ") else {
                continue;
            };
            let v: serde_json::Value = serde_json::from_str(linea).unwrap();
            if v["method"] == "session/update" {
                a.enviar(v);
            } else if v["method"] == "session/request_permission" {
                a.enviar(v);
                assert_eq!(a.leer()["result"]["outcome"]["optionId"], "allow");
            } else if v["result"]["stopReason"].is_string() {
                a.responder(&p, v["result"].clone());
            }
        }
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    let p = history(&e.id, None, None).unwrap();
    assert!(p
        .messages
        .iter()
        .flat_map(|m| &m.blocks)
        .any(|b| matches!(b, Block::ToolUse { .. })));
    assert_eq!(e.sink.payloads(ev::TURN)[0]["usage"]["input"], 6986);
    assert_eq!(
        p.messages.last().unwrap().usage.as_ref().unwrap().output,
        331
    );
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn captura_codex_01621_finaliza_solo_por_completed() {
    let e = Ensayo::nuevo("codex");
    let servidor = e.servidor(false, |a| {
        aceptar_turno(&a, "codex");
        for linea in include_str!("fixtures/codex-app-server-0.162.1-turno.ndjson").lines() {
            let Some(linea) = linea.strip_prefix("< ") else {
                continue;
            };
            let v: serde_json::Value = serde_json::from_str(linea).unwrap();
            if v["method"].is_string() && v.get("id").is_none() {
                a.enviar(v);
            }
        }
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    assert_eq!(e.sink.payloads(ev::TURN).len(), 1);
    let p = history(&e.id, None, None).unwrap();
    assert!(p.messages.iter().any(|m| m.kind == MessageKind::Answer));
    assert!(p
        .messages
        .iter()
        .flat_map(|m| &m.blocks)
        .any(|b| matches!(b, Block::ToolUse { .. })));
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn dos_turnos_reutilizan_proceso_y_conservan_el_titulo_inicial() {
    let e = Ensayo::nuevo("gemini");
    let servidor = e.servidor(false, |a| {
        for _ in 0..2 {
            let p = aceptar_turno(&a, "gemini");
            delta(&a, "gemini", "texto");
            completar(&a, "gemini", &p);
        }
        a.esperar_cierre();
    });
    e.enviar_texto("primer título").unwrap();
    e.libre();
    let primero = history(&e.id, None, None).unwrap().messages[1].uuid.clone();
    e.enviar_texto("segundo mensaje").unwrap();
    e.libre();
    assert_eq!(e.arranques.load(Ordering::SeqCst), 1);
    assert_eq!(e.exec.load(Ordering::SeqCst), 0);
    assert_eq!(motor_sesion::get(&e.id).unwrap().title, "primer título");
    let mensajes = history(&e.id, None, None).unwrap().messages;
    assert_eq!(mensajes.len(), 4);
    assert_ne!(primero, mensajes[3].uuid);
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn permiso_codex_en_bypass_acepta_sin_notice() {
    let e = Ensayo::nuevo("codex");
    motor_sesion::set_permission_mode(
        &e.id,
        crate::sesiones::types::PermissionMode::BypassPermissions,
    )
    .unwrap();
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "codex");
        a.enviar(json!({"id":8,"method":"item/commandExecution/requestApproval","params":{"command":"git status"}}));
        assert_eq!(a.leer_linea(), "{\"id\":8,\"jsonrpc\":\"2.0\",\"result\":{\"decision\":\"accept\"}}\n");
        completar(&a, "codex", &p); a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    assert!(e.sink.payloads(ev::NOTICE).is_empty());
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn titulo_manual_se_conserva_y_catalogo_emite_su_actualizacion() {
    let e = Ensayo::nuevo("gemini");
    motor_sesion::rename(&e.id, "manual").unwrap();
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "gemini");
        for update in [json!({"sessionUpdate":"session_info_update","title":"automático"}),
            json!({"sessionUpdate":"available_commands_update","availableCommands":[{"name":"ayuda","description":"Ayuda"}]}),
            json!({"sessionUpdate":"current_mode_update","currentModeId":"accept-edits"})] {
            a.enviar(json!({"method":"session/update","params":{"update":update}}));
        }
        completar(&a, "gemini", &p); a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    assert_eq!(motor_sesion::get(&e.id).unwrap().title, "manual");
    let v = obtener(&e.id).unwrap();
    {
        let s = v.estado.lock().unwrap();
        assert_eq!(s.comandos[0].nombre, "ayuda");
        assert_eq!(s.modo, "accept-edits");
    }
    assert_eq!(
        e.sink.payloads(ev::COMMANDS)[0]["items"][0]["name"],
        "ayuda"
    );
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn adjuntos_del_usuario_se_guardan_como_imagen_y_lista_de_ficheros() {
    let mensaje = transcript::usuario("ver", &["foto.png".into(), "notas.md".into()]);
    assert!(
        matches!(&mensaje.blocks[1], Block::Image {media_type, path: Some(p), ..} if media_type == "image/png" && p == "foto.png")
    );
    assert!(matches!(&mensaje.blocks[0], Block::Text {text} if text.contains("notas.md")));
}

#[test]
fn la_poda_borra_el_transcript_y_rechaza_un_fin_tardio() {
    let e = Ensayo::nuevo("gemini");
    let mensaje = transcript::usuario("texto", &[]);
    transcript::anexar(&e.id, std::slice::from_ref(&mensaje)).unwrap();
    olvidar(&e.id);
    assert!(transcript::leer(&e.id).unwrap().is_none());
    assert!(transcript::anexar(&e.id, &[mensaje]).is_err());
    assert!(transcript::leer(&e.id).unwrap().is_none());
}

#[test]
fn la_carga_no_mezcla_el_historial_reproducido_con_el_turno_nuevo() {
    let e = Ensayo::nuevo("gemini");
    motor_sesion::fijar_hilo(&e.id, "hilo-falso").unwrap();
    let servidor = e.servidor_con_replay(false, true, |a| {
        let p = aceptar_turno(&a, "gemini");
        delta(&a, "gemini", "nuevo");
        completar(&a, "gemini", &p);
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    let mensajes = history(&e.id, None, None).unwrap().messages;
    assert!(matches!(&mensajes[1].blocks[0], Block::Text {text} if text == "nuevo"));
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}
