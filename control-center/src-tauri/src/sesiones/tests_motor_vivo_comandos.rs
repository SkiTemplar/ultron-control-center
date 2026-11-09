//! Contrato F5 sobre servidores herméticos.
use super::*;

#[test]
fn codex_sin_proceso_ofrece_los_cuatro_propios() {
    let e = Ensayo::nuevo("codex");
    let items = comandos(&e.id);
    assert_eq!(
        items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
        ["compact", "review", "clear", "rewind"]
    );
    assert!(items
        .iter()
        .all(|i| i.source == "motor" && i.kind == crate::sesiones::types::CommandKind::Prompt));
}

#[test]
fn acp_sin_proceso_no_inventa_comandos() {
    let e = Ensayo::nuevo("gemini");
    assert!(comandos(&e.id).is_empty());
}

#[test]
fn catalogo_de_sesion_acp_cerrada_no_cae_a_claude() {
    let e = Ensayo::nuevo("gemini");
    motor_sesion::kill(&e.id).unwrap();
    let items = tauri::async_runtime::block_on(crate::sesiones::comandos_v2::sesiones_commands(
        String::new(),
        Some(e.id.clone()),
    ))
    .unwrap();
    assert!(items.is_empty());
}

#[test]
fn acp_actualiza_catalogo_y_emite_evento() {
    let e = Ensayo::nuevo("gemini");
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "gemini");
        a.enviar(json!({"method":"session/update","params":{"update":{
            "sessionUpdate":"available_commands_update","availableCommands":[
                {"name":"algo","description":"Acción remota","input":{"hint":"argumento"}}]}}}));
        completar(&a, "gemini", &p);
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    let items = comandos(&e.id);
    assert_eq!(items[0].arg_hint.as_deref(), Some("argumento"));
    assert_eq!(e.sink.payloads(ev::COMMANDS)[0]["items"][0]["name"], "algo");
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn barra_acp_se_envia_como_texto() {
    let e = Ensayo::nuevo("gemini");
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "gemini");
        assert_eq!(p["params"]["prompt"][0]["text"], "/algo");
        completar(&a, "gemini", &p);
        a.esperar_cierre();
    });
    e.enviar_texto("/algo").unwrap();
    e.libre();
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn compact_llama_metodo_sin_turno_y_avisa() {
    let e = Ensayo::nuevo("codex");
    let servidor = e.servidor(false, |a| {
        let p = a.leer();
        assert_eq!(p["method"], "thread/compact/start");
        a.responder(&p, json!({}));
        a.esperar_cierre();
    });
    e.enviar_texto("/compact").unwrap();
    e.libre();
    assert!(e.sink.payloads(ev::TURN).is_empty());
    assert!(e.sink.payloads(ev::MESSAGES).is_empty());
    assert_eq!(e.sink.payloads(ev::NOTICE)[0]["level"], "info");
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn clear_guarda_hilo_archiva_transcript_y_resetea() {
    let e = Ensayo::nuevo("codex");
    transcript::anexar(&e.id, &[transcript::usuario("antes", &[])]).unwrap();
    let servidor = e.servidor(false, |a| {
        let p = a.leer();
        assert_eq!(p["method"], "thread/start");
        a.responder(&p, json!({"thread":{"id":"hilo-nuevo"}}));
        a.esperar_cierre();
    });
    e.enviar_texto("/clear").unwrap();
    e.libre();
    assert_eq!(
        motor_sesion::get(&e.id).unwrap().thread_id.as_deref(),
        Some("hilo-nuevo")
    );
    assert!(transcript::leer(&e.id).unwrap().is_none());
    assert_eq!(e.sink.payloads(ev::RESET).len(), 1);
    assert!(e.sink.payloads(ev::TURN).is_empty());
    assert_eq!(e.sink.payloads(ev::NOTICE)[0]["level"], "info");
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn rewind_dos_consulta_turnos_y_revierte_antes_del_penultimo() {
    let e = Ensayo::nuevo("codex");
    let mensajes: Vec<_> = ["uno", "dos", "tres"]
        .iter()
        .flat_map(|t| {
            let usuario = transcript::usuario(t, &[]);
            let mut respuesta = transcript::usuario("respuesta", &[]);
            respuesta.role = "assistant".into();
            respuesta.kind = crate::sesiones::types::MessageKind::Answer;
            [usuario, respuesta]
        })
        .collect();
    transcript::anexar(&e.id, &mensajes).unwrap();
    let servidor = e.servidor(false, |a| {
        let p = a.leer();
        assert_eq!(p["method"], "thread/turns/list");
        assert_eq!(p["params"]["limit"], 2);
        a.responder(&p, json!({"data":[{"id":"tres"},{"id":"dos"}]}));
        let p = a.leer();
        assert_eq!(p["method"], "thread/revert");
        assert_eq!(p["params"]["beforeTurnId"], "dos");
        a.responder(&p, json!({}));
        a.esperar_cierre();
    });
    e.enviar_texto("/rewind 2").unwrap();
    e.libre();
    assert_eq!(transcript::leer(&e.id).unwrap().unwrap(), mensajes[..2]);
    assert_eq!(e.sink.payloads(ev::RESET).len(), 1);
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn rewind_con_mas_turnos_de_los_que_hay_se_rechaza_sin_rpc() {
    let e = Ensayo::nuevo("codex");
    let servidor = e.servidor(false, |a| a.esperar_cierre());
    let error = e.enviar_texto("/rewind 3").unwrap_err();
    assert!(error.contains("solo tiene 0 turno"), "{error}");
    assert!(e.sink.payloads(ev::RESET).is_empty());
    e.libre();
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn rewind_cero_se_rechaza_sin_rpc() {
    let e = Ensayo::nuevo("codex");
    let servidor = e.servidor(false, |a| a.esperar_cierre());
    assert!(e.enviar_texto("/rewind 0").unwrap_err().contains("entero"));
    e.libre();
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn rewind_ocupado_da_error_explicito() {
    let e = Ensayo::nuevo("codex");
    let servidor = e.servidor(false, |a| {
        aceptar_turno(&a, "codex");
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    assert!(e
        .enviar_texto("/rewind")
        .unwrap_err()
        .contains("trabajando"));
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn review_es_turno_normal_con_objetivo_sin_commitear() {
    let e = Ensayo::nuevo("codex");
    let servidor = e.servidor(false, |a| {
        let p = a.leer();
        assert_eq!(p["method"], "review/start");
        assert_eq!(p["params"]["target"]["type"], "uncommittedChanges");
        a.responder(&p, json!({"turn":{"id":"revision"}}));
        delta(&a, "codex", "Revisado");
        completar(&a, "codex", &p);
        a.esperar_cierre();
    });
    e.enviar_texto("/review").unwrap();
    e.libre();
    assert_eq!(e.sink.payloads(ev::TURN).len(), 1);
    assert_eq!(history(&e.id, None, None).unwrap().messages.len(), 2);
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn enviar_ya_codex_dirige_y_quita_elemento_de_cola() {
    let e = Ensayo::nuevo("codex");
    let servidor = e.servidor(false, |a| {
        aceptar_turno(&a, "codex");
        let p = a.leer();
        assert_eq!(p["method"], "turn/steer");
        assert_eq!(p["params"]["expectedTurnId"], "turno-falso");
        assert_eq!(p["params"]["input"][0]["text"], "añadido");
        a.responder(&p, json!({"turnId":"turno-falso"}));
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    let cola = crate::sesiones::motor_cola::global();
    cola.encolar(
        &e.id,
        crate::sesiones::types::QueueItemInput {
            client_id: "cliente".into(),
            text: "añadido".into(),
            attachments: vec![],
            delegate: false,
            kind: crate::sesiones::types::QueueItemKind::Prompt,
        },
    )
    .unwrap();
    assert!(cola.enviar_ya(&e.id, Some("cliente")).unwrap().is_empty());
    assert_eq!(transcript::leer(&e.id).unwrap().unwrap().len(), 2);
    assert_eq!(
        e.sink.payloads(ev::MESSAGES).last().unwrap()["messages"][0]["clientId"],
        "cliente"
    );
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn codex_skill_y_comando_desconocido_siguen_como_texto() {
    let e = Ensayo::nuevo("codex");
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "codex");
        assert_eq!(p["params"]["input"][0]["text"], "/skill-propia");
        completar(&a, "codex", &p);
        a.esperar_cierre();
    });
    e.enviar_texto("/skill-propia").unwrap();
    e.libre();
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn catalogo_codex_agrega_skills_del_proceso() {
    let e = Ensayo::nuevo("codex");
    let servidor = e.servidor(false, |a| {
        let p = a.leer();
        a.responder(&p, json!({}));
        let p = a.leer();
        assert_eq!(p["method"], "skills/list");
        a.responder(
            &p,
            json!({"data":[{"skills":[{"name":"prueba","description":"Skill del motor"}]}]}),
        );
        a.esperar_cierre();
    });
    e.enviar_texto("/compact").unwrap();
    let items = comandos(&e.id);
    assert_eq!(items.len(), 5);
    assert_eq!(items[4].name, "prueba");
    assert_eq!(items[4].source, "motor");
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn id_claude_sigue_el_catalogo_claude() {
    use crate::sesiones::{catalogo, comandos_v2, types::CommandInfoLive};
    let id = uuid::Uuid::new_v4().to_string();
    let items = catalogo::guardar_viva(
        &id,
        &[CommandInfoLive {
            name: "comando-claude".into(),
            description: "Vivo de Claude".into(),
            source: "user".into(),
            plugin: None,
            immediate: None,
        }],
    );
    let recibidos = tauri::async_runtime::block_on(comandos_v2::sesiones_commands(
        String::new(),
        Some(id.clone()),
    ))
    .unwrap();
    assert_eq!(recibidos, items);
    catalogo::olvidar_viva(&id);
}

#[test]
fn enviar_ya_sin_turno_drena_como_envio_normal() {
    use crate::sesiones::{
        motor_cola::{Colas, Entorno},
        types::{QueueItemInput, QueueItemKind},
    };
    let e = Ensayo::nuevo("codex");
    let libre = Arc::new(AtomicBool::new(false));
    let enviados = Arc::new(Mutex::new(Vec::new()));
    let (disponible, textos) = (libre.clone(), enviados.clone());
    let cola = Colas::nueva(Entorno {
        libre: Arc::new(move |_| disponible.load(Ordering::SeqCst)),
        enviar: Arc::new(move |_, msg| {
            textos.lock().unwrap().push(msg.text.to_string());
            Ok(())
        }),
        emitir: Arc::new(|_, _| {}),
        ejecutar: Arc::new(|f| f()),
    });
    for client_id in ["uno", "dos"] {
        cola.encolar(
            &e.id,
            QueueItemInput {
                client_id: client_id.into(),
                text: client_id.into(),
                attachments: vec![],
                delegate: false,
                kind: QueueItemKind::Prompt,
            },
        )
        .unwrap();
    }
    libre.store(true, Ordering::SeqCst);
    assert!(cola.enviar_ya(&e.id, None).unwrap().is_empty());
    assert_eq!(*enviados.lock().unwrap(), ["uno", "dos"]);
}
