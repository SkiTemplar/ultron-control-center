//! Un servidor stdio por sesión. Ningún candado de este módulo cruza emisiones
//! ni llamadas a motor_sesion o registro; los lectores solo encolan eventos.
use serde_json::json;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex, OnceLock, Weak,
};
use std::time::{Duration, Instant};

use super::motor_eventos::{ComandoMotor, ConstructorTurno, EventoMotor, ModeloMotor, ModoMotor};
use super::types::{ev, now_iso, ChatMessage, EngineTask, TurnPayload};
use super::{motor, motor_sesion, registro};

#[path = "motor_vivo_comandos.rs"]
mod comandos_motor;
#[path = "motor_vivo_lanzar.rs"]
mod lanzar;
#[path = "motor_vivo_permisos.rs"]
mod permisos;
#[path = "motor_vivo_transcript.rs"]
mod transcript;
#[path = "motor_vivo_turno.rs"]
mod turno;
pub use comandos_motor::{comandos, dirigir};
use lanzar::Cliente;
pub use lanzar::{Conexion, Lanzador};
pub(super) use permisos::{aplicar_modo, espera_permiso};
pub use transcript::history;

const COALESCENCIA: Duration = Duration::from_millis(100);
const PLAZO: Duration = Duration::from_secs(30);
type Cierre = Box<dyn FnOnce() + Send>;

struct TurnoVivo {
    id: String,
    constructor: ConstructorTurno,
    fecha: String,
    inicio: Instant,
    ultima: Instant,
    sucio: bool,
}

#[derive(Default)]
struct Estado {
    turno: Option<TurnoVivo>,
    comandos: Vec<ComandoMotor>,
    modos: Vec<ModoMotor>,
    modo: String,
    modelos: Vec<ModeloMotor>,
    modelo: Option<String>,
}

pub struct Vivo {
    cliente: Cliente,
    estado: Mutex<Estado>,
    cierre: Mutex<Option<Cierre>>,
    eventos: mpsc::Sender<EventoMotor>,
    cerrado: AtomicBool,
    salida: Option<Arc<dyn registro::Sink>>,
}

impl Drop for Vivo {
    fn drop(&mut self) {
        self.terminar();
    }
}

impl Vivo {
    fn terminar(&self) {
        self.cerrado.store(true, Ordering::Release);
        let cierre = self.cierre.lock().ok().and_then(|mut c| c.take());
        if let Some(cerrar) = cierre {
            cerrar();
        }
    }

    fn emitir(&self, evento: &str, valor: serde_json::Value) {
        match &self.salida {
            Some(s) => s.emit(evento, valor),
            None => registro::emit(evento, valor),
        }
    }

    fn notice(&self, id: &str, nivel: &str, texto: &str) {
        self.emitir(ev::NOTICE, json!({"id":id,"level":nivel,"text":texto}));
    }
}

fn registro_vivo() -> &'static Mutex<HashMap<String, Arc<Vivo>>> {
    static REGISTRO: OnceLock<Mutex<HashMap<String, Arc<Vivo>>>> = OnceLock::new();
    REGISTRO.get_or_init(|| Mutex::new(HashMap::new()))
}

fn obtener(id: &str) -> Option<Arc<Vivo>> {
    registro_vivo().lock().ok()?.get(id).cloned()
}

/// La reserva Lanzando de motor_sesion serializa los arranques de un mismo id.
pub(super) fn asegurar(
    id: &str,
    lanzar: Lanzador,
    salida: Option<Arc<dyn registro::Sink>>,
) -> Result<Arc<Vivo>, String> {
    if let Some(vivo) = obtener(id).filter(|v| !v.cerrado.load(Ordering::Acquire)) {
        return Ok(vivo);
    }
    let sesion = motor_sesion::get(id)?;
    let inicio = Instant::now();
    let conexion = lanzar(&sesion)?;
    let (vivo, recibidos) = crear(&sesion, conexion, salida);
    let hilo = iniciar(&vivo, sesion, PLAZO.saturating_sub(inicio.elapsed()))?;
    motor_sesion::fijar_hilo(id, &hilo)?;
    drenar_arranque(id, &vivo, &recibidos)?;
    registro_vivo()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.into(), vivo.clone());
    if !motor_sesion::existe(id) {
        cerrar(id);
        return Err("la sesión se cerró durante el arranque".into());
    }
    let debil = Arc::downgrade(&vivo);
    let id = id.to_string();
    std::thread::spawn(move || escuchar(&id, debil, recibidos));
    Ok(vivo)
}

fn drenar_arranque(
    id: &str,
    vivo: &Arc<Vivo>,
    eventos: &mpsc::Receiver<EventoMotor>,
) -> Result<(), String> {
    // session/load puede reproducir el historial: no pertenece al nuevo turno.
    for evento in eventos.try_iter() {
        match evento {
            EventoMotor::Titulo(_)
            | EventoMotor::Comandos(_)
            | EventoMotor::Modo { .. }
            | EventoMotor::Modelos { .. } => turno::recibir(id, vivo, evento),
            EventoMotor::Error(texto) => return Err(texto),
            _ => {}
        }
    }
    Ok(())
}

fn crear(
    sesion: &motor_sesion::SesionMotor,
    conexion: Conexion,
    salida: Option<Arc<dyn registro::Sink>>,
) -> (Arc<Vivo>, mpsc::Receiver<EventoMotor>) {
    let (eventos, recibidos) = mpsc::channel();
    let (cliente, cierre) = Cliente::nuevo(sesion, conexion, eventos.clone());
    let vivo = Arc::new(Vivo {
        cliente,
        estado: Mutex::new(Estado::default()),
        cierre: Mutex::new(Some(cierre)),
        eventos,
        cerrado: AtomicBool::new(false),
        salida,
    });
    (vivo, recibidos)
}

fn iniciar(
    vivo: &Arc<Vivo>,
    sesion: motor_sesion::SesionMotor,
    plazo: Duration,
) -> Result<String, String> {
    let (enviar, recibir) = mpsc::sync_channel(1);
    let iniciando = vivo.clone();
    std::thread::spawn(move || {
        let _ = enviar.send(iniciando.cliente.iniciar(&sesion));
    });
    match recibir.recv_timeout(plazo) {
        Ok(Ok(hilo)) => Ok(hilo),
        resultado => {
            vivo.terminar();
            Err(match resultado {
                Ok(Err(e)) => e,
                _ => "plazo de arranque de 30 s agotado".into(),
            })
        }
    }
}

/// Mensajes de un turno `exec` de una sesión de motor (la caída cuando el
/// proceso persistente no arranca): en curso, solo el del usuario; terminado,
/// el par. Mismos uuid que `history`, así que el front los sustituye.
pub fn emitir_turno_exec(t: &EngineTask) {
    if let Some((id, mensajes)) = mensajes_turno_exec(t) {
        registro::emit(ev::MESSAGES, json!({"id":id,"messages":mensajes}));
    }
}

pub(super) fn mensajes_turno_exec(t: &EngineTask) -> Option<(String, Vec<ChatMessage>)> {
    let id = t.session_id.clone()?;
    Some((id, transcript::convertir(std::slice::from_ref(t))))
}

pub(super) fn tiene_historial(id: &str) -> bool {
    transcript::existe(id)
}

pub(super) fn asegurar_real(id: &str) -> Result<Arc<Vivo>, String> {
    asegurar(id, &lanzar::lanzar, None)
}

pub(super) fn enviar(
    id: &str,
    msg: &motor_sesion::Mensaje,
    vivo: Arc<Vivo>,
) -> Result<EngineTask, String> {
    if comandos_motor::ejecutar(id, msg.text, &vivo)? {
        motor_sesion::liberar_comando(id);
        let mut tarea = turno::nueva_tarea(id, msg)?;
        tarea.status = "done".into();
        return Ok(tarea);
    }
    turno::enviar(id, msg, vivo)
}

fn escuchar(id: &str, debil: Weak<Vivo>, eventos: mpsc::Receiver<EventoMotor>) {
    loop {
        let evento = eventos.recv_timeout(COALESCENCIA);
        let Some(vivo) = debil.upgrade() else {
            return;
        };
        if vivo.cerrado.load(Ordering::Acquire) {
            return;
        }
        match evento {
            Ok(evento) => turno::recibir(id, &vivo, evento),
            Err(mpsc::RecvTimeoutError::Timeout) => turno::vaciar(id, &vivo),
            Err(_) => return,
        }
        if vivo.cerrado.load(Ordering::Acquire) {
            return;
        }
    }
}

/// Extrae primero: el cierre del proceso nunca ocurre bajo el registro.
pub fn cerrar(id: &str) {
    let vivo = registro_vivo().lock().ok().and_then(|mut m| m.remove(id));
    if let Some(vivo) = vivo {
        permisos::cancelar(id, &vivo, super::types::AskCancelReason::SessionExited);
        vivo.terminar();
    }
}

pub(super) fn descartar(id: &str, vivo: &Arc<Vivo>) {
    permisos::cancelar(id, vivo, super::types::AskCancelReason::SessionExited);
    if let Ok(mut m) = registro_vivo().lock() {
        if m.get(id).is_some_and(|actual| Arc::ptr_eq(actual, vivo)) {
            m.remove(id);
        }
    }
    vivo.terminar();
}

pub(super) fn olvidar(id: &str) {
    cerrar(id);
    transcript::borrar(id);
}

pub fn interrumpir(id: &str) -> Result<(), String> {
    let Some(vivo) = obtener(id) else {
        motor::cancelar_de_sesion(id);
        return Ok(());
    };
    permisos::cancelar(id, &vivo, super::types::AskCancelReason::Interrupted);
    match &vivo.cliente {
        Cliente::Codex(c) => c.interrumpir(PLAZO).map(|_| ()).map_err(|e| e.to_string()),
        Cliente::Acp(c) => c.cancelar().map_err(|e| e.to_string()),
    }
}

#[cfg(test)]
#[path = "tests_motor_vivo.rs"]
mod tests;
