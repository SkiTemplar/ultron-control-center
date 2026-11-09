//! Persistencia, cancelación y continuidad de políticas.
use super::*;
use crate::sesiones::preguntas::{Broker, Resolucion};
use crate::sesiones::types::{AskCancelReason, PermissionMode, SessionPrefs};

#[test]
fn codex_muestra_las_rutas_del_cambio_en_la_tarjeta() {
    let e = Ensayo::nuevo("codex");
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "codex");
        a.enviar(json!({"method":"item/started","params":{"item":{"type":"fileChange","id":"edicion","changes":[{"path":"src/demo.rs","kind":{"type":"update"}}]}}}));
        a.enviar(json!({"id":91,"method":"item/fileChange/requestApproval","params":{"itemId":"edicion"}}));
        assert_eq!(a.leer()["result"]["decision"], "decline");
        completar(&a, "codex", &p);
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    esperar(|| !Broker::global().pending_for(&e.id).is_empty());
    let ask = Broker::global().pending_for(&e.id).remove(0);
    assert_eq!(ask.payload["input"]["paths"][0], "src/demo.rs");
    assert!(ask.payload["summary"]
        .as_str()
        .unwrap()
        .contains("src/demo.rs"));
    Broker::global()
        .answer(
            &*e.sink,
            &ask.ask_id,
            crate::sesiones::types::AskAnswer::Permission {
                decision: crate::sesiones::types::PermissionDecision::Deny,
                reason: None,
            },
        )
        .unwrap();
    e.libre();
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn modo_incompatible_al_arrancar_no_cae_a_exec() {
    let e = Ensayo::nuevo("gemini");
    let resultado = motor_sesion::send_con_vivo(
        &e.id,
        &crate::sesiones::motor_sesion::Mensaje {
            text: "hola",
            ..Default::default()
        },
        &|_, _, _, _| panic!("no debe lanzar exec con otra política"),
        Some(&|_| Err("gemini no anuncia un modo equivalente a bypassPermissions".into())),
        &|_, _| panic!("no debe anunciar una caída a exec"),
    );
    assert!(resultado.unwrap_err().contains("bypassPermissions"));
    assert_eq!(
        motor_sesion::get(&e.id).unwrap().turno,
        motor_sesion::Turno::Libre
    );
}

#[test]
fn modo_de_preferencias_se_guarda_y_se_recupera() {
    let dir = tempfile::tempdir().unwrap();
    let prefs = SessionPrefs {
        launch_permission_mode: PermissionMode::Plan,
        ..Default::default()
    };
    let info = motor_sesion::crear_con_preferencias(
        "codex",
        None,
        dir.path().to_string_lossy().into(),
        None,
        &prefs,
    )
    .unwrap();
    let path = dir.path().join("sesiones.json");
    motor_sesion::guardar_en(&path, &[motor_sesion::get(&info.id).unwrap()], &[]).unwrap();
    let cargadas = motor_sesion::cargar_de(&path);
    assert_eq!(cargadas[0].permission_mode, prefs.launch_permission_mode);
    assert_eq!(
        cargadas[0].info().permission_mode,
        Some(PermissionMode::Plan)
    );
    let settings = motor_sesion::ajustes(&info.id).unwrap();
    assert_eq!(settings.permission_mode.as_deref(), Some("plan"));
    assert_eq!(settings.launch_permission_mode, Some(PermissionMode::Plan));
    motor_sesion::kill(&info.id).unwrap();
}

#[test]
fn guardada_antigua_sin_modo_usa_default() {
    let e = Ensayo::nuevo("codex");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sesiones.json");
    motor_sesion::guardar_en(&path, &[motor_sesion::get(&e.id).unwrap()], &[]).unwrap();
    let mut datos: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    datos[0].as_object_mut().unwrap().remove("permissionMode");
    std::fs::write(&path, datos.to_string()).unwrap();
    assert_eq!(
        motor_sesion::cargar_de(&path)[0].permission_mode,
        PermissionMode::Default
    );
}

#[test]
fn codex_cambia_politica_del_siguiente_turno_sin_reiniciar() {
    let e = Ensayo::nuevo("codex");
    let servidor = e.servidor(false, |a| {
        let p = aceptar_turno(&a, "codex");
        completar(&a, "codex", &p);
        let p = aceptar_turno(&a, "codex");
        assert_eq!(p["params"]["sandboxPolicy"]["type"], "readOnly");
        assert_eq!(p["params"]["approvalPolicy"], "on-request");
        completar(&a, "codex", &p);
        a.esperar_cierre();
    });
    e.enviar().unwrap();
    e.libre();
    assert!(
        motor_sesion::set_permission_mode(&e.id, PermissionMode::Plan)
            .unwrap()
            .ok
    );
    e.enviar().unwrap();
    e.libre();
    assert_eq!(e.arranques.load(Ordering::SeqCst), 1);
    motor_sesion::kill(&e.id).unwrap();
    servidor.join().unwrap();
}

#[test]
fn muerte_y_cierre_cancelan_las_tarjetas_pendientes() {
    for muerte in [true, false] {
        let e = Ensayo::nuevo("gemini");
        let (seguir, fin) = mpsc::channel();
        let servidor = e.servidor(false, move |a| {
            aceptar_turno(&a, "gemini");
            super::permisos::pedir(&a, "gemini");
            fin.recv_timeout(Duration::from_secs(5)).unwrap();
            if muerte {
                a.cerrar();
            }
            a.esperar_cierre();
        });
        e.enviar().unwrap();
        let ask = super::permisos::pendiente(&e);
        seguir.send(()).unwrap();
        if muerte {
            e.libre();
        } else {
            motor_sesion::kill(&e.id).unwrap();
        }
        esperar(|| Broker::global().pending_for(&e.id).is_empty());
        let resultado = Broker::global().esperar(&[ask], Duration::ZERO);
        assert!(matches!(
            resultado[0].resolucion,
            Resolucion::Cancelada(AskCancelReason::SessionExited)
        ));
        servidor.join().unwrap();
    }
}

#[test]
fn modo_inicial_se_expone_en_el_hud() {
    let e = Ensayo::nuevo("codex");
    let info = motor_sesion::get(&e.id).unwrap().info();
    assert_eq!(info.permission_mode, Some(info.launch_permission_mode));
}

#[test]
fn bypass_sin_modo_propio_cae_al_de_edicion() {
    use crate::sesiones::types::PermissionMode;
    // agy 1.5 no anuncia bypass: la sesión arranca en accept-edits y
    // `permiso` aprueba cada petición mientras siga en bypass.
    let agy =
        json!({"modes":{"availableModes":[{"id":"default"},{"id":"accept-edits"},{"id":"plan"}]}});
    assert_eq!(
        lanzar::modo_acp("gemini", PermissionMode::BypassPermissions, &agy).unwrap(),
        "accept-edits"
    );
    let con_yolo = json!({"modes":{"availableModes":[{"id":"accept-edits"},{"id":"yolo"}]}});
    assert_eq!(
        lanzar::modo_acp("gemini", PermissionMode::BypassPermissions, &con_yolo).unwrap(),
        "yolo"
    );
}

#[test]
fn opencode_sin_equivalente_devuelve_error() {
    use crate::sesiones::types::PermissionMode;
    assert!(lanzar::modo_acp("opencode", PermissionMode::Default, &json!({})).is_err());
    assert!(lanzar::modo_acp(
        "opencode",
        PermissionMode::Plan,
        &json!({"modes":{"availableModes":[{"id":"build"}]}})
    )
    .is_err());
    assert!(lanzar::modo_acp(
        "gemini",
        PermissionMode::AcceptEdits,
        &json!({"modes":{"availableModes":[{"id":"plan"}]}})
    )
    .is_err());
}
