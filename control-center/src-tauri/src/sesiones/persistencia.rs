// sesiones/persistencia.rs — Sesiones abiertas y su cola en disco (hallazgo
// #35, opción B).
//
// `~/.ultron/cockpit/sesiones/abiertas.json` guarda la proyección de cada
// sesión abierta: id de ULTRON, proyecto, cwd, título, conversación de
// Claude, transcript, modelo, modo de lanzamiento, alta, `Config` de
// lanzamiento y su cola (`queued` y `failed`; un `sending` se guarda como
// `queued` con aviso). No lleva `lastActivityAt` ni `status`, así que no se
// reescribe cada 5 s: un hilo escritor espera ~500 ms de calma y solo
// escribe (tmp + rename) si la proyección cambió.
//
// Marcan el fichero `registro::emit_sessions` (alta, baja y cambios del
// registro), `cola::emitir` y `lanzamiento::guardar`. El escritor no existe
// hasta que `restaurar::restaurar` ha leído el fichero en el arranque: la
// primera escritura nunca pisa lo que había sin leerlo, y en los tests nunca
// se activa.
//
// Propiedad: WP-ESTADO.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::lanzamiento::Config;
use super::registro::{self, Persistible, Sink};
use super::titulo::OrigenTitulo;
use super::types::{ev, PermissionMode, QueueItem, QueueItemKind, QueueOrigin, QueueState};

/// Restauración al arrancar ULTRON.
#[path = "persistencia_restaurar.rs"]
pub mod restaurar;

/// Envíos que estaban en `sending` al cerrar: se cruzan con el transcript.
#[path = "persistencia_en_vuelo.rs"]
pub mod en_vuelo;

/// Sesiones no restauradas por una causa pasajera: se apartan y se reintentan.
#[path = "persistencia_descartes.rs"]
pub mod descartes;

/// Turno vivo al cerrar (qué hacía, checkpoint y Workflows) y su continuación.
#[path = "persistencia_turno.rs"]
pub mod turno;

/// Versión del formato de `abiertas.json`.
pub const VERSION: u32 = 1;
/// Calma que espera el escritor antes de escribir.
const CALMA: Duration = Duration::from_millis(500);
/// Con cambios continuos se escribe igualmente pasado este plazo.
const ESPERA_MAXIMA: Duration = Duration::from_secs(3);
/// En la salida, lo que se espera como mucho a que el hilo escritor termine
/// una escritura en curso antes de renunciar al volcado.
const ESPERA_SALIDA: Duration = Duration::from_millis(200);
/// Aviso de un envío que estaba en `sending` al guardar. Al restaurar se
/// cruza con el transcript (`en_vuelo`) y se sustituye.
pub const AVISO_SENDING: &str = "Se estaba enviando cuando se cerró ULTRON: al restaurar se \
     comprueba en el transcript si llegó.";

/// Contenido de `abiertas.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fichero {
    pub version: u32,
    pub sesiones: Vec<Abierta>,
}

/// Sesión abierta tal como se guarda.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Abierta {
    pub id: String,
    pub project_id: Option<String>,
    pub cwd: String,
    pub title: String,
    /// El primer prompt aún puede poner el título. Se sigue escribiendo para
    /// las versiones anteriores, que no conocen `titleSource`.
    #[serde(default)]
    pub title_auto: bool,
    /// Quién puso el título; sin campo (versión anterior) sale de `titleAuto`.
    #[serde(default)]
    pub title_source: Option<OrigenTitulo>,
    pub claude_session_id: Option<String>,
    pub transcript: Option<String>,
    pub model: Option<String>,
    pub launch_permission_mode: PermissionMode,
    pub started_at: String,
    /// `None` si la sesión aún no tenía su lanzamiento guardado.
    pub config: Option<Config>,
    #[serde(default)]
    pub cola: Vec<Guardado>,
    /// Solo lo lleva el volcado de la salida, si la sesión tenía un turno vivo
    /// o un Workflow en marcha. Lectura tolerante (`turno::tolerante`).
    #[serde(
        default,
        deserialize_with = "turno::tolerante",
        skip_serializing_if = "Option::is_none"
    )]
    pub turno_vivo: Option<turno::TurnoVivo>,
}

/// Elemento de la cola tal como se guarda (`QueueItem` solo serializa).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Guardado {
    pub client_id: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub delegate: bool,
    pub kind: QueueItemKind,
    pub origin: QueueOrigin,
    pub state: QueueState,
    pub created_at: String,
    pub error: Option<String>,
}

impl Guardado {
    pub fn a_item(&self) -> QueueItem {
        QueueItem {
            client_id: self.client_id.clone(),
            text: self.text.clone(),
            attachments: self.attachments.clone(),
            delegate: self.delegate,
            kind: self.kind,
            origin: self.origin,
            state: self.state,
            created_at: self.created_at.clone(),
            sent_at: None,
            error: self.error.clone(),
            message_uuid: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Proyección
// ---------------------------------------------------------------------------

/// Lo que sobrevive de la cola: `queued` y `failed` tal cual, y `sending` y
/// `cliQueued` como `queued` con `AVISO_SENDING` (pudo llegar o no; la cola
/// nativa vive en la memoria del proceso `claude`, que muere al cerrar
/// ULTRON). El resto ya está entregado o absorbido.
pub fn cola_guardable(items: &[QueueItem]) -> Vec<Guardado> {
    items
        .iter()
        .filter_map(|i| {
            let (state, error) = match i.state {
                QueueState::Queued | QueueState::Failed => (i.state, i.error.clone()),
                QueueState::Sending | QueueState::CliQueued => {
                    (QueueState::Queued, Some(AVISO_SENDING.to_string()))
                }
                _ => return None,
            };
            Some(Guardado {
                client_id: i.client_id.clone(),
                text: i.text.clone(),
                attachments: i.attachments.clone(),
                delegate: i.delegate,
                kind: i.kind,
                origin: i.origin,
                state,
                created_at: i.created_at.clone(),
                error,
            })
        })
        .collect()
}

fn abierta_de(p: &Persistible, config: Option<Config>, cola: &[QueueItem]) -> Abierta {
    let i = &p.info;
    Abierta {
        id: i.id.clone(),
        project_id: i.project_id.clone(),
        cwd: i.cwd.clone(),
        title: i.title.clone(),
        title_auto: p.titulo.title_auto(),
        title_source: Some(p.titulo),
        claude_session_id: i.claude_session_id.clone(),
        transcript: p
            .transcript
            .as_ref()
            .map(|t| t.to_string_lossy().into_owned()),
        model: i.model.clone(),
        launch_permission_mode: i.launch_permission_mode,
        started_at: i.started_at.clone(),
        config,
        cola: cola_guardable(cola),
        turno_vivo: turno::del_cierre(&i.id),
    }
}

/// Proyección pura de las sesiones abiertas con su `Config` y su cola.
pub fn proyectar(
    sesiones: &[Persistible],
    config: &dyn Fn(&str) -> Option<Config>,
    cola: &dyn Fn(&str) -> Vec<QueueItem>,
) -> Fichero {
    Fichero {
        version: VERSION,
        sesiones: sesiones
            .iter()
            .map(|p| abierta_de(p, config(&p.info.id), &cola(&p.info.id)))
            .collect(),
    }
}

/// Proyección de lo que hay en memoria. Un lock envenenado (registro o cola)
/// es un error: una proyección vacía no puede sustituir el fichero.
fn proyeccion_actual() -> Result<Fichero, String> {
    let ahora = super::buzon::ahora_ms();
    let sesiones = registro::persistibles()?;
    let mut colas = HashMap::with_capacity(sesiones.len());
    for p in &sesiones {
        let items = super::cola::global().lista_o_error(&p.info.id, ahora)?;
        colas.insert(p.info.id.clone(), items);
    }
    Ok(proyectar(&sesiones, &super::lanzamiento::guardada, &|id| {
        colas.get(id).cloned().unwrap_or_default()
    }))
}

// ---------------------------------------------------------------------------
// Disco
// ---------------------------------------------------------------------------

/// Ruta de `abiertas.json` (los tests nunca tocan el cockpit real).
pub fn ruta() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    crate::ultron_root()
        .ok()
        .map(|r| r.join("cockpit").join("sesiones").join("abiertas.json"))
}

/// Escribe `texto` en `ruta` de forma atómica: fichero temporal y rename.
pub fn escribir_atomico(ruta: &Path, texto: &str) -> Result<(), String> {
    if let Some(dir) = ruta.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("no se pudo crear {}: {e}", dir.display()))?;
    }
    let tmp = ruta.with_extension("json.tmp");
    std::fs::write(&tmp, texto)
        .map_err(|e| format!("no se pudo escribir {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, ruta).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("no se pudo sustituir {}: {e}", ruta.display())
    })
}

/// Resultado de leer `abiertas.json` en el arranque.
#[derive(Debug, PartialEq, Eq)]
pub enum Lectura {
    /// No existe: primer arranque o nada abierto.
    Vacia,
    Leida(Fichero),
    /// Dañado o de otra versión: se apartó a `destino` sin borrarlo.
    Apartada {
        destino: PathBuf,
        error: String,
    },
}

/// Lee el fichero. Un error de E/S que no sea «no existe» es `Err`: en ese
/// caso no se activa el escritor, para no pisar un fichero que no se leyó.
pub fn leer(ruta: &Path) -> Result<Lectura, String> {
    let texto = match std::fs::read_to_string(ruta) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Lectura::Vacia),
        Err(e) => return Err(format!("no se pudo leer {}: {e}", ruta.display())),
    };
    match parsear(&texto) {
        Ok(f) => Ok(Lectura::Leida(f)),
        Err(error) => Ok(Lectura::Apartada {
            destino: apartar(ruta)?,
            error,
        }),
    }
}

fn parsear(texto: &str) -> Result<Fichero, String> {
    let f: Fichero = serde_json::from_str(texto).map_err(|e| format!("JSON no válido: {e}"))?;
    if f.version != VERSION {
        return Err(format!("versión {} desconocida", f.version));
    }
    Ok(f)
}

/// Renombra el fichero dañado a `.bad` (con marca de tiempo si ya hay uno).
fn apartar(ruta: &Path) -> Result<PathBuf, String> {
    let mut destino = ruta.with_extension("json.bad");
    if destino.exists() {
        destino = ruta.with_extension(format!("{}.json.bad", super::buzon::ahora_ms()));
    }
    std::fs::rename(ruta, &destino)
        .map_err(|e| format!("no se pudo apartar {}: {e}", ruta.display()))?;
    Ok(destino)
}

// ---------------------------------------------------------------------------
// Escritor con calma
// ---------------------------------------------------------------------------

static ESCRITOR: OnceLock<Escritor> = OnceLock::new();
static FALLANDO: AtomicBool = AtomicBool::new(false);

/// Escritor activo: canal del hilo, ruta y último texto en disco. El hilo y
/// `volcar_ya` comparten `ultima`, así que nunca escriben a la vez.
struct Escritor {
    tx: Sender<()>,
    ruta: PathBuf,
    ultima: Mutex<Option<String>>,
}

impl Escritor {
    fn nuevo(tx: Sender<()>, ruta: PathBuf) -> Self {
        Self {
            tx,
            ruta,
            ultima: Mutex::new(None),
        }
    }

    /// Vuelca la proyección actual si cambió (desde el hilo escritor).
    fn volcar(&self) {
        let guarda = self.ultima.lock().unwrap_or_else(PoisonError::into_inner);
        self.volcar_con(guarda);
    }

    /// Como `volcar`, pero esperando como mucho `espera` a que el hilo
    /// suelte el último texto. false si no se pudo volcar a tiempo.
    fn volcar_en_salida(&self, espera: Duration) -> bool {
        let limite = Instant::now() + espera;
        loop {
            match self.ultima.try_lock() {
                Ok(g) => return self.volcar_con(g),
                Err(std::sync::TryLockError::Poisoned(p)) => {
                    return self.volcar_con(p.into_inner())
                }
                Err(std::sync::TryLockError::WouldBlock) if Instant::now() < limite => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(std::sync::TryLockError::WouldBlock) => return false,
            }
        }
    }

    fn volcar_con(&self, mut ultima: MutexGuard<'_, Option<String>>) -> bool {
        let previa = ultima.take();
        *ultima = volcar(&self.ruta, previa);
        true
    }
}

/// Volcado síncrono de `abiertas.json` en la salida de ULTRON
/// (`RunEvent::Exit`, antes de matar los PTY): sin él se pierden los cambios
/// de los últimos ~500 ms de calma. Sin escritor activo (arranque que no leyó
/// el fichero, o tests) no escribe nada. Espera al hilo escritor como mucho
/// `ESPERA_SALIDA`; true si quedó volcado.
pub fn volcar_ya() -> bool {
    let Some(e) = ESCRITOR.get() else {
        return false;
    };
    // Con los PTY aún vivos: qué hacía cada sesión con un turno abierto.
    turno::capturar_cierre();
    let ok = e.volcar_en_salida(ESPERA_SALIDA);
    if !ok {
        tracing::warn!("abiertas.json no se volcó en la salida: el escritor seguía ocupado");
    }
    ok
}

/// Pide reescribir el fichero. Antes de `activar` (arranque sin leer o
/// tests) no hay escritor y no se escribe nada, a propósito.
pub fn marcar() {
    if let Some(e) = ESCRITOR.get() {
        if e.tx.send(()).is_err() && !FALLANDO.swap(true, Ordering::Relaxed) {
            tracing::error!("el escritor de abiertas.json terminó: no se guardan las sesiones");
        }
    }
}

/// Arranca el escritor sobre `ruta` (una vez por proceso) y escribe la
/// proyección actual.
pub fn activar(ruta: PathBuf) {
    let (tx, rx) = channel();
    if ESCRITOR.set(Escritor::nuevo(tx, ruta)).is_err() {
        tracing::warn!("el escritor de abiertas.json ya estaba activo");
        return;
    }
    let r = std::thread::Builder::new()
        .name("sesiones-abiertas".into())
        .spawn(move || bucle(&rx));
    if let Err(e) = r {
        tracing::error!(error = %e, "no se pudo lanzar el escritor de abiertas.json");
        avisar(&format!(
            "No se guardarán las sesiones abiertas: el escritor no arrancó ({e})."
        ));
        return;
    }
    marcar();
}

/// Hilo escritor supervisado (hallazgo nocturno 9): un pánico al proyectar o
/// escribir relanza el bucle (reinicios acotados, en el log); si se agotan,
/// se avisa de que las sesiones ya no se guardan.
fn bucle(rx: &Receiver<()>) {
    let Some(e) = ESCRITOR.get() else {
        return;
    };
    supervisar_escritor(super::supervisor::PAUSA_REINICIO, || {
        while rx.recv().is_ok() {
            esperar_calma(rx);
            e.volcar();
        }
    });
}

fn supervisar_escritor(pausa: Duration, cuerpo: impl FnMut()) -> super::supervisor::Fin {
    use super::supervisor::{con_reinicio, Fin, MAX_REINICIOS};
    let fin = con_reinicio(
        "escritor de abiertas.json",
        MAX_REINICIOS,
        pausa,
        cuerpo,
        |_| {},
    );
    if fin == Fin::Agotado {
        avisar("No se guardarán las sesiones abiertas: el escritor falló varias veces.");
    }
    fin
}

/// Espera a que pasen `CALMA` sin marcas (como mucho `ESPERA_MAXIMA`).
fn esperar_calma(rx: &Receiver<()>) {
    let inicio = Instant::now();
    loop {
        match rx.recv_timeout(CALMA) {
            Ok(()) if inicio.elapsed() < ESPERA_MAXIMA => {}
            Ok(()) | Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Escribe la proyección si cambió respecto a `ultima`; devuelve la que
/// queda en disco.
fn volcar(ruta: &Path, ultima: Option<String>) -> Option<String> {
    volcar_proyeccion(ruta, ultima, proyeccion_actual())
}

/// Como `volcar`, con la proyección ya calculada. Si no se pudo calcular,
/// no se escribe nada (se conserva el fichero) y se avisa una sola vez.
fn volcar_proyeccion(
    ruta: &Path,
    ultima: Option<String>,
    proyeccion: Result<Fichero, String>,
) -> Option<String> {
    let fichero = match proyeccion {
        Ok(f) => f,
        Err(e) => {
            tracing::error!(error = %e, "proyección de abiertas.json no disponible: no se escribe");
            if !FALLANDO.swap(true, Ordering::Relaxed) {
                avisar(&format!(
                    "No se pueden guardar las sesiones abiertas ({e}): se conserva el fichero anterior."
                ));
            }
            return ultima;
        }
    };
    let texto = match serde_json::to_string_pretty(&fichero) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "no se pudo serializar abiertas.json");
            return ultima;
        }
    };
    if ultima.as_deref() == Some(texto.as_str()) {
        return ultima;
    }
    match escribir_atomico(ruta, &texto) {
        Ok(()) => {
            FALLANDO.store(false, Ordering::Relaxed);
            Some(texto)
        }
        Err(e) => {
            tracing::error!(error = %e, "no se pudo guardar abiertas.json");
            if !FALLANDO.swap(true, Ordering::Relaxed) {
                avisar(&format!(
                    "No se pudieron guardar las sesiones abiertas: {e}. Si ULTRON se cierra ahora, no se restaurarán."
                ));
            }
            ultima
        }
    }
}

// ---------------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------------

/// Aviso sin sesión (Control Center): fichero dañado, sesiones descartadas o
/// fallos de escritura.
pub fn avisar(texto: &str) {
    tracing::warn!(texto, "aviso de la persistencia de Sesiones");
    if let Some(s) = registro::sink() {
        s.avisar(texto);
    }
}

type Nota = (&'static str, String);

/// Notas de restauración pendientes y sesiones cuya ventana ya las recibió.
#[derive(Default)]
struct Notas {
    pendientes: HashMap<String, Vec<Nota>>,
    entregadas: HashSet<String>,
}

/// Un lock envenenado no pierde las notas: el dato sigue siendo válido.
fn notas() -> MutexGuard<'static, Notas> {
    static N: OnceLock<Mutex<Notas>> = OnceLock::new();
    N.get_or_init(|| Mutex::new(Notas::default()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Nota del chat de una sesión restaurada (`sesiones://notice`).
pub fn anotar(id: &str, nivel: &'static str, texto: String) {
    anotar_en(registro::sink().as_deref(), id, nivel, texto);
}

/// Si la ventana ya recibió las notas de la sesión y sigue abierta, se emite
/// en el acto (el fallo de un relanzamiento llega después de cargar el
/// historial); si no, queda pendiente hasta `entregar_avisos`.
pub fn anotar_en(destino: Option<&dyn Sink>, id: &str, nivel: &'static str, texto: String) {
    let abierta = destino.is_some_and(|s| s.window_open());
    let directa = {
        let mut n = notas();
        if abierta && n.entregadas.contains(id) {
            Some(texto)
        } else {
            n.pendientes
                .entry(id.to_string())
                .or_default()
                .push((nivel, texto));
            None
        }
    };
    if let (Some(texto), Some(s)) = (directa, destino) {
        emitir_nota(s, id, nivel, &texto);
    }
}

/// Saca las notas pendientes de la sesión (pruebas).
#[cfg(test)]
pub fn tomar_avisos(id: &str) -> Vec<Nota> {
    notas().pendientes.remove(id).unwrap_or_default()
}

/// Emite las notas pendientes de la sesión. La llama `gestor::history` en la
/// primera página del hilo, cuando la ventana ya escucha los eventos.
pub fn entregar_avisos(id: &str) {
    entregar_avisos_en(registro::sink().as_deref(), id);
}

/// Sin destino (sin app) las notas siguen pendientes.
pub fn entregar_avisos_en(destino: Option<&dyn Sink>, id: &str) {
    let Some(s) = destino else {
        tracing::debug!(
            sesion = id,
            "notas de restauración sin destino: quedan pendientes"
        );
        return;
    };
    let pendientes = {
        let mut n = notas();
        n.entregadas.insert(id.to_string());
        n.pendientes.remove(id).unwrap_or_default()
    };
    for (nivel, texto) in pendientes {
        emitir_nota(s, id, nivel, &texto);
    }
    turno::entregar_continuacion(s, id);
}

/// Olvida las notas de una sesión cerrada.
pub fn olvidar_avisos(id: &str) {
    let mut n = notas();
    n.pendientes.remove(id);
    n.entregadas.remove(id);
    turno::olvidar_continuacion(id);
}

fn emitir_nota(s: &dyn Sink, id: &str, nivel: &str, texto: &str) {
    s.emit(
        ev::NOTICE,
        json!({ "id": id, "level": nivel, "text": texto }),
    );
}

#[cfg(test)]
#[path = "tests_persistencia.rs"]
mod tests;

#[cfg(test)]
mod tests_supervision {
    use super::*;
    use crate::sesiones::supervisor::{Fin, MAX_REINICIOS};

    /// Hallazgo nocturno 9: un pánico en el escritor relanza el bucle (antes
    /// el hilo moría y `abiertas.json` dejaba de guardarse en silencio).
    #[test]
    fn un_panico_en_el_escritor_lo_reinicia() {
        let mut vueltas = 0;
        let fin = supervisar_escritor(Duration::ZERO, || {
            vueltas += 1;
            assert!(vueltas > 1, "pánico de prueba");
        });
        assert_eq!(fin, Fin::Normal { reinicios: 1 });
        assert_eq!(vueltas, 2);
    }

    #[test]
    fn el_escritor_se_rinde_tras_los_reinicios_acotados() {
        let mut vueltas = 0u32;
        let fin = supervisar_escritor(Duration::ZERO, || {
            vueltas += 1;
            panic!("pánico de prueba");
        });
        assert_eq!(fin, Fin::Agotado);
        assert_eq!(vueltas, MAX_REINICIOS + 1);
    }
}
