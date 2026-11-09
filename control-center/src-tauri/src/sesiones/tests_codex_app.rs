use super::*;
use std::io::{self, BufReader, Read};
use std::sync::mpsc;
use std::thread;

const PLAZO: Duration = Duration::from_secs(3);
struct Lector(mpsc::Receiver<Vec<u8>>, io::Cursor<Vec<u8>>);
impl Read for Lector {
    fn read(&mut self, salida: &mut [u8]) -> io::Result<usize> {
        if self.1.position() >= self.1.get_ref().len() as u64 {
            match self.0.recv() {
                Ok(datos) => self.1 = io::Cursor::new(datos),
                Err(_) => return Ok(0),
            }
        }
        self.1.read(salida)
    }
}
struct Escritor(mpsc::Sender<Vec<u8>>);
impl Write for Escritor {
    fn write(&mut self, datos: &[u8]) -> io::Result<usize> {
        self.0
            .send(datos.to_vec())
            .map_err(|_| io::ErrorKind::BrokenPipe)?;
        Ok(datos.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
type ConexionPrueba = (
    Arc<ClienteCodexApp>,
    mpsc::Sender<Vec<u8>>,
    mpsc::Receiver<Vec<u8>>,
    mpsc::Receiver<EventoMotor>,
);
fn conexion() -> ConexionPrueba {
    let (entrada, lector) = mpsc::channel();
    let (escritor, salida) = mpsc::channel();
    let (emitir, eventos) = mpsc::channel();
    let cliente = ClienteCodexApp::nuevo(
        BufReader::new(Lector(lector, io::Cursor::new(Vec::new()))),
        Escritor(escritor),
        move |e| {
            let _ = emitir.send(e);
        },
    );
    (Arc::new(cliente), entrada, salida, eventos)
}
fn enviar(entrada: &mpsc::Sender<Vec<u8>>, valor: Value) {
    entrada.send(format!("{valor}\n").into_bytes()).unwrap();
}
fn recibir(salida: &mpsc::Receiver<Vec<u8>>) -> Value {
    serde_json::from_slice(&salida.recv_timeout(PLAZO).unwrap()).unwrap()
}

#[test]
fn aprobacion_cero_no_roba_respuesta_cero_sin_jsonrpc() {
    let (cliente, entrada, salida, eventos) = conexion();
    let copia = cliente.clone();
    let pendiente = thread::spawn(move || copia.iniciar(PLAZO));
    let solicitud = recibir(&salida);
    assert_eq!(solicitud["id"], 0);
    enviar(
        &entrada,
        json!({"id":0,"method":"item/commandExecution/requestApproval","params":{"command":"git status"}}),
    );
    assert!(
        matches!(eventos.recv_timeout(PLAZO).unwrap(), EventoMotor::PeticionPermiso { id_peticion, .. } if id_peticion == "0")
    );
    cliente
        .responder_aprobacion("0", Decision::Decline)
        .unwrap();
    let linea = String::from_utf8(salida.recv_timeout(PLAZO).unwrap()).unwrap();
    assert_eq!(
        linea,
        "{\"id\":0,\"jsonrpc\":\"2.0\",\"result\":{\"decision\":\"decline\"}}\n"
    );
    enviar(&entrada, json!({"id":0,"result":{"userAgent":"falso"}}));
    assert_eq!(pendiente.join().unwrap().unwrap()["userAgent"], "falso");
    assert_eq!(recibir(&salida)["method"], "initialized");
    assert!(cliente.responder_aprobacion("0", Decision::Accept).is_err());
}

#[test]
fn cuatro_politicas_llegan_a_thread_start() {
    for (politica, aprobacion, sandbox) in [
        (PoliticaCodex::Default, "untrusted", "workspace-write"),
        (PoliticaCodex::AcceptEdits, "on-request", "workspace-write"),
        (PoliticaCodex::Plan, "on-request", "read-only"),
        (
            PoliticaCodex::BypassPermissions,
            "never",
            "danger-full-access",
        ),
    ] {
        let (cliente, entrada, salida, _) = conexion();
        let pendiente = thread::spawn(move || cliente.nuevo_hilo("proyecto", politica, PLAZO));
        let solicitud = recibir(&salida);
        assert_eq!(solicitud["method"], "thread/start");
        assert_eq!(
            solicitud["params"],
            json!({"cwd":"proyecto","approvalPolicy":aprobacion,"sandbox":sandbox})
        );
        enviar(
            &entrada,
            json!({"id":solicitud["id"],"result":{"thread":{"id":"hilo"}}}),
        );
        pendiente.join().unwrap().unwrap();
    }
}

#[test]
fn decisiones_serializan_los_tipos_del_esquema() {
    for (decision, esperado) in [
        (Decision::Accept, "accept"),
        (Decision::AcceptForSession, "acceptForSession"),
        (Decision::Decline, "decline"),
        (Decision::Cancel, "cancel"),
    ] {
        assert_eq!(serde_json::to_value(decision).unwrap(), esperado);
    }
}

#[test]
fn operaciones_sin_hilo_o_turno_fallan_localmente() {
    let (cliente, _, _, _) = conexion();
    assert!(cliente.turno("hola", &[], PLAZO).is_err());
    assert!(cliente.interrumpir(PLAZO).is_err());
    assert!(cliente.steer("hola", &[], PLAZO).is_err());
}

#[test]
#[ignore = "real: lanza codex app-server"]
fn inicializa_y_abre_hilo_real() {
    use std::process::Stdio;
    let directorio = tempfile::tempdir().unwrap();
    let programa = crate::sesiones::motores::codex_program().expect("codex instalado");
    let cwd = directorio.path().to_string_lossy().into_owned();
    let mut proceso = crate::sesiones::motores::command_for(&programa, &cwd)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let cliente = ClienteCodexApp::nuevo(
        BufReader::new(proceso.stdout.take().unwrap()),
        proceso.stdin.take().unwrap(),
        |_| {},
    );
    let resultado = cliente.iniciar(Duration::from_secs(20)).and_then(|_| {
        cliente.nuevo_hilo(
            &directorio.path().to_string_lossy(),
            PoliticaCodex::Plan,
            Duration::from_secs(20),
        )
    });
    let _ = proceso.kill();
    let _ = proceso.wait();
    assert!(resultado.unwrap()["thread"]["id"].is_string());
}

#[test]
fn metodos_y_entradas_siguen_el_esquema_generado() {
    let (cliente, entrada_servidor, salida, _) = conexion();
    let servidor = thread::spawn(move || {
        let mut solicitudes = Vec::new();
        for _ in 0..8 {
            let solicitud = recibir(&salida);
            enviar(
                &entrada_servidor,
                json!({"id":solicitud["id"],"result":{"thread":{"id":"hilo"},"turn":{"id":"turno"}}}),
            );
            solicitudes.push(solicitud);
        }
        solicitudes
    });
    cliente.retomar_hilo("hilo", PLAZO).unwrap();
    cliente
        .turno(
            "hola",
            &[
                ImagenCodex::Url("data:image/png;base64,AA==".into()),
                ImagenCodex::Local("imagen.png".into()),
            ],
            PLAZO,
        )
        .unwrap();
    cliente.steer("continúa", &[], PLAZO).unwrap();
    cliente.interrumpir(PLAZO).unwrap();
    cliente.compactar(PLAZO).unwrap();
    cliente.bifurcar(PLAZO).unwrap();
    cliente.modelos(PLAZO).unwrap();
    cliente.skills(PLAZO).unwrap();
    let solicitudes = servidor.join().unwrap();
    comprobar_solicitudes(&solicitudes);
}

fn comprobar_solicitudes(solicitudes: &[Value]) {
    let metodos: Vec<_> = solicitudes
        .iter()
        .map(|s| s["method"].as_str().unwrap())
        .collect();
    assert_eq!(
        metodos,
        [
            "thread/resume",
            "turn/start",
            "turn/steer",
            "turn/interrupt",
            "thread/compact/start",
            "thread/fork",
            "model/list",
            "skills/list"
        ]
    );
    assert_eq!(
        solicitudes[1]["params"]["input"],
        json!([{"type":"text","text":"hola","text_elements":[]},{"type":"image","url":"data:image/png;base64,AA=="},{"type":"localImage","path":"imagen.png"}])
    );
    assert_eq!(solicitudes[2]["params"]["expectedTurnId"], "turno");
    assert_eq!(
        solicitudes[3]["params"],
        json!({"threadId":"hilo","turnId":"turno"})
    );
}

#[test]
fn decisiones_compuestas_conservan_los_nombres_del_esquema() {
    let decision = Decision::AcceptWithExecpolicyAmendment {
        execpolicy_amendment: vec!["git".into(), "status".into()],
    };
    assert_eq!(
        serde_json::to_value(decision).unwrap(),
        json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["git","status"]}})
    );
    let decision = Decision::ApplyNetworkPolicyAmendment {
        network_policy_amendment: EnmiendaRed {
            host: "example.test".into(),
            action: AccionRed::Deny,
        },
    };
    assert_eq!(
        serde_json::to_value(decision).unwrap(),
        json!({"applyNetworkPolicyAmendment":{"network_policy_amendment":{"host":"example.test","action":"deny"}}})
    );
}

#[test]
fn las_aprobaciones_de_comando_y_fichero_conservan_id_opaco_y_decline() {
    let (cliente, entrada, salida, eventos) = conexion();
    for metodo in [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
    ] {
        enviar(
            &entrada,
            json!({"id":"permiso","method":metodo,"params":{}}),
        );
        assert!(
            matches!(eventos.recv_timeout(PLAZO).unwrap(), EventoMotor::PeticionPermiso { id_peticion, .. } if id_peticion == "\"permiso\"")
        );
        cliente
            .responder_aprobacion("\"permiso\"", Decision::Decline)
            .unwrap();
        assert_eq!(
            recibir(&salida),
            json!({"jsonrpc":"2.0","id":"permiso","result":{"decision":"decline"}})
        );
    }
}

#[test]
fn la_aprobacion_de_permisos_responde_permissions_y_scope() {
    let (cliente, entrada, salida, eventos) = conexion();
    let solicitados = json!({"network": {"enabled": true}, "fileSystem": null});
    let casos = [
        (
            Decision::Accept,
            json!({"network": {"enabled": true}}),
            "turn",
        ),
        (
            Decision::AcceptForSession,
            json!({"network": {"enabled": true}}),
            "session",
        ),
        // Caso negativo: rechazar no concede nada ni responde `decision`.
        (Decision::Decline, json!({}), "turn"),
    ];
    for (i, (decision, concedidos, alcance)) in casos.into_iter().enumerate() {
        enviar(
            &entrada,
            json!({"id": i, "method": "item/permissions/requestApproval",
                   "params": {"permissions": solicitados}}),
        );
        assert!(matches!(
            eventos.recv_timeout(PLAZO).unwrap(),
            EventoMotor::PeticionPermiso { .. }
        ));
        cliente
            .responder_aprobacion(&i.to_string(), decision)
            .unwrap();
        assert_eq!(
            recibir(&salida),
            json!({"jsonrpc": "2.0", "id": i,
                   "result": {"permissions": concedidos, "scope": alcance}})
        );
    }
}
