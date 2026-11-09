use super::*;
use std::io::{self, BufReader, Read};
use std::sync::mpsc;
use std::thread;

const PLAZO: Duration = Duration::from_secs(3);

#[test]
fn opencode_config_options_negocia_modo_modelo_y_fin() {
    let (cliente, agente, eventos) = conexion();
    let servidor = thread::spawn(move || {
        let p = agente.leer();
        agente.responder(&p, json!({"protocolVersion":1}));
        let p = agente.leer();
        assert_eq!(p["method"], "session/new");
        let r: Value = serde_json::from_str(include_str!(
            "fixtures/opencode-acp-1.19.4-configuracion.json"
        ))
        .unwrap();
        agente.responder(&p, r);
        for (id, valor) in [("mode", "plan"), ("model", "opencode/big-pickle")] {
            let p = agente.leer();
            assert_eq!(p["method"], "session/set_config_option");
            assert_eq!(
                p["params"],
                json!({"sessionId":"sesion-falsa","configId":id,"value":valor})
            );
            agente.responder(&p, json!({"configOptions":[]}));
        }
        let p = agente.leer();
        assert_eq!(p["method"], "session/prompt");
        agente.responder(&p, json!({"stopReason":"end_turn"}));
    });
    cliente.initialize(PLAZO).unwrap();
    let r = cliente.nueva_sesion("/proyecto", PLAZO).unwrap();
    assert_eq!(r["modes"]["availableModes"][0]["id"], "build");
    assert_eq!(r["models"]["currentModelId"], "opencode/big-pickle");
    cliente.establecer_modo("plan", PLAZO).unwrap();
    cliente
        .establecer_modelo("opencode/big-pickle", PLAZO)
        .unwrap();
    cliente.prompt("hola", &[], PLAZO).unwrap();
    assert!(eventos
        .try_iter()
        .any(|e| matches!(e, EventoMotor::FinTurno { .. })));
    servidor.join().unwrap();
}

struct Lector(mpsc::Receiver<Vec<u8>>, io::Cursor<Vec<u8>>);
impl Read for Lector {
    fn read(&mut self, salida: &mut [u8]) -> io::Result<usize> {
        if self.1.position() == self.1.get_ref().len() as u64 {
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

struct AgenteFalso {
    entrada: mpsc::Sender<Vec<u8>>,
    salida: mpsc::Receiver<Vec<u8>>,
}
impl AgenteFalso {
    fn enviar(&self, valor: Value) {
        self.entrada
            .send(format!("{valor}\n").into_bytes())
            .unwrap();
    }
    fn leer(&self) -> Value {
        serde_json::from_slice(&self.salida.recv_timeout(PLAZO).unwrap()).unwrap()
    }
    fn responder(&self, peticion: &Value, resultado: Value) {
        self.enviar(json!({"jsonrpc":"2.0","id":peticion["id"],"result":resultado}));
    }
}

fn conexion() -> (ClienteAcp, AgenteFalso, mpsc::Receiver<EventoMotor>) {
    let (entrada, receptor) = mpsc::channel();
    let (emisor, salida) = mpsc::channel();
    let (eventos, recibidos) = mpsc::channel();
    let cliente = ClienteAcp::nuevo(
        BufReader::new(Lector(receptor, io::Cursor::new(Vec::new()))),
        Escritor(emisor),
        move |evento| {
            eventos.send(evento).unwrap();
        },
    );
    (cliente, AgenteFalso { entrada, salida }, recibidos)
}

fn iniciar(agente: &AgenteFalso) {
    let peticion = agente.leer();
    assert_eq!(peticion["method"], "initialize");
    assert_eq!(
        peticion["params"],
        json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}})
    );
    agente.responder(
        &peticion,
        json!({"protocolVersion":1,"agentCapabilities":{"promptCapabilities":{"image":true}}}),
    );
    let peticion = agente.leer();
    assert_eq!(
        peticion["params"],
        json!({"cwd":"/proyecto","mcpServers":[]})
    );
    agente.responder(&peticion, json!({"sessionId":"sesion-prueba","modes":{"currentModeId":"default","availableModes":[{"id":"default","name":"Normal"}]}}));
}

#[test]
fn agente_falso_recibe_rechazo_exacto_sin_bloquear_lector() {
    let (cliente, agente, eventos) = conexion();
    let hilo = thread::spawn(move || {
        iniciar(&agente);
        agente.enviar(json!({"jsonrpc":"2.0","id":"permiso-1","method":"session/request_permission","params":{"toolCall":{"title":"git status","kind":"execute"},"options":[{"optionId":"deny","name":"Rechazar","kind":"reject_once"}]}}));
        let linea = agente.salida.recv_timeout(PLAZO).unwrap();
        assert_eq!(String::from_utf8(linea).unwrap(), "{\"id\":\"permiso-1\",\"jsonrpc\":\"2.0\",\"result\":{\"outcome\":{\"optionId\":\"deny\",\"outcome\":\"selected\"}}}\n");
    });
    cliente.initialize(PLAZO).unwrap();
    cliente.nueva_sesion("/proyecto", PLAZO).unwrap();
    while let Ok(evento) = eventos.recv_timeout(PLAZO) {
        if let EventoMotor::PeticionPermiso {
            id_peticion,
            opciones,
            ..
        } = evento
        {
            assert_eq!(opciones[0].tipo, "reject_once");
            assert!(cliente
                .responder_permiso(&id_peticion, Some("inexistente"))
                .is_err());
            cliente
                .responder_permiso(&id_peticion, Some(&opciones[0].id))
                .unwrap();
            assert!(cliente.responder_permiso(&id_peticion, None).is_err());
            hilo.join().unwrap();
            return;
        }
    }
    panic!("No llegó la petición de permiso");
}

#[test]
fn prompt_imagenes_modo_modelo_carga_y_cancelacion() {
    let (cliente, agente, eventos) = conexion();
    let hilo = thread::spawn(move || simular_turno(&agente));
    cliente.initialize(PLAZO).unwrap();
    cliente.nueva_sesion("/proyecto", PLAZO).unwrap();
    cliente.cargar_sesion("otra", "/proyecto", PLAZO).unwrap();
    cliente.establecer_modo("plan", PLAZO).unwrap();
    cliente.establecer_modelo("modelo", PLAZO).unwrap();
    cliente
        .prompt(
            "Describe",
            &[ImagenAcp {
                tipo_mime: "image/png".into(),
                datos: "YWJj".into(),
            }],
            PLAZO,
        )
        .unwrap();
    cliente.cancelar().unwrap();
    hilo.join().unwrap();
    assert!(eventos.try_iter().any(
        |e| matches!(e, EventoMotor::FinTurno {uso:Some(u),..} if u.input == 5 && u.output == 2)
    ));
}

fn simular_turno(agente: &AgenteFalso) {
    iniciar(agente);
    let cargar = agente.leer();
    assert_eq!(cargar["method"], "session/load");
    assert_eq!(
        cargar["params"],
        json!({"sessionId":"otra","cwd":"/proyecto","mcpServers":[]})
    );
    agente.responder(&cargar, json!({}));
    for (metodo, campo, valor) in [
        ("session/set_mode", "modeId", "plan"),
        ("session/set_model", "modelId", "modelo"),
    ] {
        let peticion = agente.leer();
        assert_eq!(peticion["method"], metodo);
        assert_eq!(peticion["params"][campo], valor);
        agente.responder(&peticion, json!({}));
    }
    let peticion = agente.leer();
    assert_eq!(peticion["method"], "session/prompt");
    assert_eq!(
        peticion["params"],
        json!({"sessionId":"otra","prompt":[{"type":"text","text":"Describe"},{"type":"image","mimeType":"image/png","data":"YWJj"}]})
    );
    agente.responder(
        &peticion,
        json!({"stopReason":"end_turn","usage":{"inputTokens":5,"outputTokens":2}}),
    );
    let cancelar = agente.leer();
    assert_eq!(cancelar["method"], "session/cancel");
    assert!(cancelar.get("id").is_none());
}

#[test]
fn capacidades_no_soportadas_y_permiso_cancelado() {
    let (cliente, agente, eventos) = conexion();
    for metodo in ["fs/read_text_file", "terminal/create", "desconocido"] {
        agente.enviar(json!({"jsonrpc":"2.0","id":7,"method":metodo,"params":{}}));
        assert_eq!(agente.leer()["error"]["code"], -32601);
    }
    agente.enviar(json!({"jsonrpc":"2.0","id":8,"method":"session/request_permission","params":{"toolCall":{},"options":[]}}));
    let EventoMotor::PeticionPermiso { id_peticion, .. } = eventos.recv_timeout(PLAZO).unwrap()
    else {
        panic!("Falta permiso")
    };
    cliente.responder_permiso(&id_peticion, None).unwrap();
    assert_eq!(
        agente.leer(),
        json!({"jsonrpc":"2.0","id":8,"result":{"outcome":{"outcome":"cancelled"}}})
    );
    assert!(cliente.prompt("Texto", &[], PLAZO).is_err());
}

#[test]
#[ignore = "real: lanza agy acp"]
fn agy_real_inicializa_sesion_con_modos_y_comandos() {
    use std::process::{Command, Stdio};
    let directorio = tempfile::tempdir().unwrap();
    let mut proceso = Command::new("agy")
        .arg("acp")
        .current_dir(directorio.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let (emisor, eventos) = mpsc::channel();
    let cliente = ClienteAcp::nuevo(
        BufReader::new(proceso.stdout.take().unwrap()),
        proceso.stdin.take().unwrap(),
        move |e| {
            let _ = emisor.send(e);
        },
    );
    let resultado = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        cliente.initialize(Duration::from_secs(30)).unwrap();
        let sesion = cliente
            .nueva_sesion(directorio.path().to_str().unwrap(), Duration::from_secs(30))
            .unwrap();
        assert!(!sesion["modes"]["availableModes"]
            .as_array()
            .unwrap()
            .is_empty());
        cliente
            .prompt(
                "Responde hola sin herramientas",
                &[],
                Duration::from_secs(60),
            )
            .unwrap();
        assert!(eventos
            .try_iter()
            .any(|e| matches!(e, EventoMotor::Comandos(c) if !c.is_empty())));
    }));
    let _ = proceso.kill();
    let _ = proceso.wait();
    assert!(resultado.is_ok());
}
