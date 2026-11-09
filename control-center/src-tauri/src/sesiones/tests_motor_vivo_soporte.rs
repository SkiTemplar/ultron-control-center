//! Servidores herméticos sobre canales; no se crean procesos ni sockets.
use super::*;
use crate::sesiones::{motor_sesion::Mensaje, registro::Sink, test_sink::MockSink};
use std::io::{self, BufReader, Read, Write};
use std::sync::atomic::AtomicUsize;

pub(super) struct Agente {
    entrada: Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    salida: mpsc::Receiver<Vec<u8>>,
}
impl Agente {
    pub fn leer_linea(&self) -> String {
        String::from_utf8(
            self.salida
                .recv_timeout(Duration::from_secs(5))
                .expect("línea"),
        )
        .unwrap()
    }
    pub fn leer(&self) -> serde_json::Value {
        serde_json::from_slice(
            &self
                .salida
                .recv_timeout(Duration::from_secs(5))
                .expect("petición"),
        )
        .expect("JSON")
    }
    pub fn enviar(&self, valor: serde_json::Value) {
        self.entrada
            .lock()
            .unwrap()
            .as_ref()
            .expect("canal vivo")
            .send(format!("{valor}\n").into_bytes())
            .unwrap();
    }
    pub fn responder(&self, peticion: &serde_json::Value, valor: serde_json::Value) {
        self.enviar(json!({"jsonrpc":"2.0","id":peticion["id"],"result":valor}));
    }
    pub fn cerrar(&self) {
        self.entrada.lock().unwrap().take();
    }
    pub fn esperar_cierre(&self) {
        esperar(|| self.entrada.lock().unwrap().is_none());
    }
    fn iniciar(
        &self,
        engine: &str,
        fallo: bool,
        replay: bool,
        modo: crate::sesiones::types::PermissionMode,
    ) {
        let p = self.leer();
        assert_eq!(p["method"], "initialize");
        if fallo {
            self.enviar(json!({"id":p["id"],"error":{"code":-1,"message":"inicio rechazado"}}));
            return;
        }
        self.responder(
            &p,
            if engine == "codex" {
                json!({})
            } else {
                json!({"protocolVersion":1})
            },
        );
        if engine == "codex" {
            assert_eq!(self.leer()["method"], "initialized");
        }
        let p = self.leer();
        if engine == "codex" {
            assert!(matches!(
                p["method"].as_str(),
                Some("thread/start" | "thread/resume")
            ));
            let (aprobacion, sandbox) = politica_esperada(modo);
            assert_eq!(p["params"]["approvalPolicy"], aprobacion);
            assert_eq!(p["params"]["sandbox"], sandbox);
            self.responder(&p, json!({"thread":{"id":"hilo-falso"}}));
        } else {
            self.iniciar_acp(engine, replay, modo, &p);
        }
    }

    fn iniciar_acp(
        &self,
        engine: &str,
        replay: bool,
        modo: crate::sesiones::types::PermissionMode,
        p: &serde_json::Value,
    ) {
        assert!(matches!(
            p["method"].as_str(),
            Some("session/new" | "session/load")
        ));
        let modos = json!({"sessionId":"hilo-falso","modes":{"currentModeId":"default","availableModes":[{"id":"default","name":"Normal"},{"id":"accept-edits","name":"Editar"},{"id":"plan","name":"Plan"},{"id":"yolo","name":"Sin permisos"}]}});
        self.responder(p, modos.clone());
        if replay {
            delta(self, engine, "historial reproducido");
        }
        let p = self.leer();
        assert_eq!(p["method"], "session/set_mode");
        assert_eq!(
            p["params"]["modeId"],
            lanzar::modo_acp(engine, modo, &modos).unwrap()
        );
        self.responder(&p, json!({}));
    }
}

struct Lector(mpsc::Receiver<Vec<u8>>, io::Cursor<Vec<u8>>);
impl Read for Lector {
    fn read(&mut self, datos: &mut [u8]) -> io::Result<usize> {
        if self.1.position() == self.1.get_ref().len() as u64 {
            match self.0.recv() {
                Ok(d) => self.1 = io::Cursor::new(d),
                Err(_) => return Ok(0),
            }
        }
        self.1.read(datos)
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

pub(super) struct Ensayo {
    pub id: String,
    pub sink: Arc<MockSink>,
    pub cierres: Arc<AtomicUsize>,
    pub arranques: AtomicUsize,
    pub exec: AtomicUsize,
    conexiones: Mutex<std::collections::VecDeque<Conexion>>,
    engine: &'static str,
    _dir: tempfile::TempDir,
}

impl Ensayo {
    pub fn nuevo(engine: &'static str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let s = motor_sesion::crear_en(engine, None, dir.path().to_string_lossy().into(), None)
            .unwrap();
        motor_sesion::set_permission_mode(
            &s.id,
            crate::sesiones::types::PermissionMode::AcceptEdits,
        )
        .unwrap();
        Self {
            id: s.id,
            sink: Arc::new(MockSink::opened()),
            cierres: Arc::new(AtomicUsize::new(0)),
            arranques: AtomicUsize::new(0),
            exec: AtomicUsize::new(0),
            conexiones: Mutex::default(),
            engine,
            _dir: dir,
        }
    }
    pub fn servidor(
        &self,
        fallo: bool,
        script: impl FnOnce(Agente) + Send + 'static,
    ) -> std::thread::JoinHandle<()> {
        self.servidor_con_replay(fallo, false, script)
    }

    pub fn servidor_con_replay(
        &self,
        fallo: bool,
        replay: bool,
        script: impl FnOnce(Agente) + Send + 'static,
    ) -> std::thread::JoinHandle<()> {
        let (entrada, recibida) = mpsc::channel();
        let (escribir, salida) = mpsc::channel();
        let entrada = Arc::new(Mutex::new(Some(entrada)));
        let cerrar = entrada.clone();
        let cierres = self.cierres.clone();
        self.conexiones.lock().unwrap().push_back(Conexion {
            lector: Box::new(BufReader::new(Lector(
                recibida,
                io::Cursor::new(Vec::new()),
            ))),
            escritor: Box::new(Escritor(escribir)),
            cerrar: Box::new(move || {
                cierres.fetch_add(1, Ordering::SeqCst);
                cerrar.lock().unwrap().take();
            }),
        });
        let engine = self.engine;
        let modo = motor_sesion::get(&self.id).unwrap().permission_mode;
        std::thread::spawn(move || {
            let a = Agente { entrada, salida };
            a.iniciar(engine, fallo, replay, modo);
            script(a);
        })
    }
    pub fn enviar(&self) -> Result<EngineTask, String> {
        self.enviar_texto("hola")
    }

    pub fn enviar_texto(&self, texto: &str) -> Result<EngineTask, String> {
        motor_sesion::send_con_vivo(
            &self.id,
            &Mensaje {
                text: texto,
                ..Mensaje::default()
            },
            &|spec, _, _, _| {
                self.exec.fetch_add(1, Ordering::SeqCst);
                motor::lanzar_para_prueba(spec)
            },
            Some(&|id| {
                asegurar(
                    id,
                    &|_| {
                        self.arranques.fetch_add(1, Ordering::SeqCst);
                        self.conexiones
                            .lock()
                            .unwrap()
                            .pop_front()
                            .ok_or_else(|| "sin conexión de prueba".into())
                    },
                    Some(self.sink.clone()),
                )
            }),
            &|id, text| {
                self.sink
                    .emit(ev::NOTICE, json!({"id":id,"level":"warn","text":text}))
            },
        )
    }
    pub fn libre(&self) {
        esperar(|| motor_sesion::get(&self.id).unwrap().turno == motor_sesion::Turno::Libre);
    }
}
impl Drop for Ensayo {
    fn drop(&mut self) {
        let _ = motor_sesion::kill(&self.id);
        olvidar(&self.id);
    }
}

pub(super) fn esperar(condicion: impl Fn() -> bool) {
    let fin = Instant::now() + Duration::from_secs(5);
    while !condicion() {
        assert!(Instant::now() < fin, "plazo de la aserción agotado");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn politica_esperada(modo: crate::sesiones::types::PermissionMode) -> (&'static str, &'static str) {
    use crate::sesiones::types::PermissionMode;
    match modo {
        PermissionMode::Default => ("untrusted", "workspace-write"),
        PermissionMode::AcceptEdits => ("on-request", "workspace-write"),
        PermissionMode::Plan => ("on-request", "read-only"),
        PermissionMode::BypassPermissions => ("never", "danger-full-access"),
        _ => panic!("modo sin equivalente en Codex"),
    }
}

pub(super) fn delta(a: &Agente, engine: &str, texto: &str) {
    if engine == "codex" {
        a.enviar(json!({"method":"item/agentMessage/delta","params":{"itemId":"respuesta","delta":texto}}));
    } else {
        a.enviar(json!({"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":texto}}}}));
    }
}

pub(super) fn completar(a: &Agente, engine: &str, p: &serde_json::Value) {
    if engine == "codex" {
        a.enviar(json!({"method":"turn/completed","params":{"turn":{"id":"turno-falso","status":"completed"}}}));
    } else {
        a.responder(p, json!({"stopReason":"end_turn"}));
    }
}

pub(super) fn aceptar_turno(a: &Agente, engine: &str) -> serde_json::Value {
    let p = a.leer();
    assert_eq!(
        p["method"],
        if engine == "codex" {
            "turn/start"
        } else {
            "session/prompt"
        }
    );
    if engine == "codex" {
        a.responder(&p, json!({"turn":{"id":"turno-falso"}}));
    }
    p
}
