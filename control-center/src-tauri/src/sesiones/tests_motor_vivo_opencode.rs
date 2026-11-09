//! Ensayo optativo con OpenCode real: solo requiere una instalación configurada.
use super::*;
use serde_json::Value;

#[test]
#[ignore = "real: opencode acp y modelo configurado"]
fn opencode_real_negocia_modos_y_finaliza_prompt() {
    let e = Ensayo::nuevo("opencode");
    let sesion = motor_sesion::get(&e.id).unwrap();
    let conexion = match conexion_aislada(&sesion) {
        Ok(c) => c,
        Err(_) => {
            eprintln!("Omitido: OpenCode no está disponible en el entorno");
            return;
        }
    };
    let (vivo, eventos) = crear(&sesion, conexion, Some(e.sink.clone()));
    let Cliente::Acp(c) = &vivo.cliente else {
        panic!("OpenCode debe usar ACP");
    };
    c.initialize(PLAZO).expect("initialize de OpenCode");
    let r = c
        .nueva_sesion(&sesion.cwd, PLAZO)
        .expect("session/new de OpenCode");
    let ids: Vec<_> = r["modes"]["availableModes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["id"].as_str())
        .collect();
    eprintln!("Modos ACP de OpenCode: {ids:?}");
    let modo = lanzar::modo_acp("opencode", sesion.permission_mode, &r).expect("modo equivalente");
    c.establecer_modo(&modo, PLAZO)
        .expect("establecer modo de OpenCode");
    probar_prompt(c, eventos);
}

fn probar_prompt(c: &crate::sesiones::acp::ClienteAcp, eventos: mpsc::Receiver<EventoMotor>) {
    // El perfil aislado no contiene credenciales ni un modelo del usuario.
    let Ok(modelo) = std::env::var("ULTRON_TEST_OPENCODE_MODEL") else {
        eprintln!(
            "Omitido el prompt: no hay modelo configurado; establece ULTRON_TEST_OPENCODE_MODEL"
        );
        return;
    };
    c.establecer_modelo(&modelo, PLAZO)
        .expect("modelo configurado para el ensayo");
    let resultado = c.prompt("Responde solo OK", &[], Duration::from_secs(60));
    if let Err(error) = resultado {
        let texto = error.to_string().to_lowercase();
        if ["model", "provider", "auth", "api key", "credential"]
            .iter()
            .any(|s| texto.contains(s))
        {
            eprintln!("Omitido: OpenCode no tiene modelo o proveedor configurado");
            return;
        }
        panic!("falló el prompt ACP de OpenCode: {error}");
    }
    assert!(eventos
        .try_iter()
        .any(|e| matches!(e, EventoMotor::FinTurno { .. })));
}

fn conexion_aislada(sesion: &motor_sesion::SesionMotor) -> Result<Conexion, String> {
    let programa = crate::sesiones::opencode_entorno::opencode_program()?;
    let mut cmd = crate::sesiones::motores::command_for_task(&programa, &sesion.cwd);
    let claves = crate::sesiones::opencode_entorno::claves();
    crate::sesiones::opencode_entorno::inyectar(&mut cmd, &claves);
    // OpenCode escribe logs y cachés al arrancar: no usar el perfil personal.
    for variable in [
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "XDG_CONFIG_HOME",
    ] {
        cmd.env(variable, &sesion.cwd);
    }
    cmd.args(["acp", "--pure"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    lanzar::conectar(cmd.spawn().map_err(|e| e.to_string())?)
}

#[test]
fn open_code_elige_agente_y_las_reglas_van_en_el_entorno() {
    use crate::sesiones::types::PermissionMode;
    let r: Value = serde_json::from_str(include_str!(
        "fixtures/opencode-acp-1.19.4-configuracion.json"
    ))
    .unwrap();
    let r = crate::sesiones::acp_normalizar::configuracion_compatible(r);
    let modo = lanzar::modo_acp;
    assert_eq!(
        modo("opencode", PermissionMode::AcceptEdits, &r).unwrap(),
        "build"
    );
    assert_eq!(modo("opencode", PermissionMode::Plan, &r).unwrap(), "plan");
    assert_eq!(
        modo("opencode", PermissionMode::Default, &r).unwrap(),
        "build"
    );
    assert_eq!(
        modo("opencode", PermissionMode::BypassPermissions, &r).unwrap(),
        "build"
    );
}

#[test]
fn open_code_fuera_de_bypass_pide_permiso_para_bash() {
    use crate::sesiones::opencode::permisos_sesion;
    use crate::sesiones::types::PermissionMode;
    // Los agentes build y plan de OpenCode 1.19 arrancan con "*": allow: sin
    // estas reglas, bash corre sin llegar a la tarjeta de permiso.
    assert_eq!(permisos_sesion(PermissionMode::BypassPermissions), None);
    for modo in [
        PermissionMode::Default,
        PermissionMode::AcceptEdits,
        PermissionMode::Plan,
    ] {
        let reglas: Value = serde_json::from_str(&permisos_sesion(modo).unwrap()).unwrap();
        assert_eq!(reglas["*"], "ask", "{modo:?}");
        assert!(reglas.get("bash").is_none(), "{modo:?}");
        assert_eq!(reglas["read"]["*.env"], "deny", "{modo:?}");
    }
    let editar =
        |m| serde_json::from_str::<Value>(&permisos_sesion(m).unwrap()).unwrap()["edit"].clone();
    assert_eq!(editar(PermissionMode::AcceptEdits), "allow");
    assert_eq!(editar(PermissionMode::Plan), "deny");
    assert!(editar(PermissionMode::Default).is_null());
}
