// sesiones/persistencia_turno.rs — Cerrar a mitad de turno (opciones A + D).
//
// A: al salir de ULTRON (`volcar_ya`, antes de matar los PTY) se captura, de
// cada sesión con un turno vivo (`working` o `waiting`), qué hacía: desde
// cuándo, el último prompt, la herramienta en curso y un checkpoint de git
// del cwd (HEAD, rama y si el árbol estaba sucio; solo lectura, con
// `--no-optional-locks`, y nada si no es un repositorio). Va en
// `abiertas.json` como `turnoVivo` de la sesión. Al restaurar, el composer
// recibe un prompt de continuación que no se envía solo.
//
// D: los Workflows lanzados en segundo plano y sin final en el transcript
// (`analisis`) se guardan por runId; la continuación pide reanudarlos con
// `resumeFromRunId`. Una sesión idle con un Workflow vivo también se guarda:
// el Workflow muere con el proceso aunque el turno ya hubiera terminado.
//
// El campo se lee de forma tolerante: si falta (fichero antiguo) o no tiene
// la forma esperada, es `None` y el resto de la sesión se restaura igual.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::json;

use crate::sesiones::registro::{Persistible, Sink};
use crate::sesiones::types::SessionStatus;

/// Análisis de la cola del transcript.
#[path = "persistencia_turno_analisis.rs"]
pub mod analisis;

/// Texto del prompt de continuación.
#[path = "persistencia_turno_texto.rs"]
pub mod texto;

/// Caracteres que se guardan del último prompt.
pub const MAX_PROMPT: usize = 400;
/// Caracteres que se guardan de la herramienta en curso.
pub const MAX_HERRAMIENTA: usize = 160;
/// Workflows vivos que se guardan como mucho por sesión.
pub const MAX_WORKFLOWS: usize = 8;
/// Plazo de `git status` por sesión en la salida.
const PLAZO_GIT: Duration = Duration::from_millis(1500);
/// Bytes del final del transcript que se analizan.
const COLA_TRANSCRIPT: u64 = 4 << 20;

/// Turno vivo de una sesión al cerrar ULTRON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnoVivo {
    /// Inicio del turno (ISO); `None` si la sesión estaba idle con un
    /// Workflow en segundo plano.
    #[serde(default)]
    pub desde: Option<String>,
    #[serde(default)]
    pub ultimo_prompt: Option<String>,
    #[serde(default)]
    pub herramienta_en_curso: Option<String>,
    #[serde(default)]
    pub workflows_vivos: Vec<String>,
    #[serde(default)]
    pub checkpoint: Option<Checkpoint>,
}

/// Estado de git del cwd al cerrar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// SHA del HEAD; `None` en un repositorio sin commits.
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub rama: Option<String>,
    pub sucio: bool,
}

impl TurnoVivo {
    /// Copia validada: textos recortados, runIds con forma `wf_…` y HEAD
    /// hexadecimal. `None` si no queda nada que contar.
    pub fn saneado(self) -> Option<Self> {
        let t = Self {
            desde: self.desde.filter(|d| !d.is_empty() && d.len() <= 64),
            ultimo_prompt: recortar_opt(self.ultimo_prompt, MAX_PROMPT),
            herramienta_en_curso: recortar_opt(self.herramienta_en_curso, MAX_HERRAMIENTA),
            workflows_vivos: runs_validos(self.workflows_vivos),
            checkpoint: self.checkpoint.map(Checkpoint::saneado),
        };
        let vacio = t.desde.is_none() && t.workflows_vivos.is_empty();
        (!vacio).then_some(t)
    }
}

impl Checkpoint {
    fn saneado(self) -> Self {
        Self {
            head: self.head.filter(|h| es_sha(h)),
            rama: recortar_opt(self.rama, 200),
            sucio: self.sucio,
        }
    }
}

fn es_sha(h: &str) -> bool {
    (7..=64).contains(&h.len()) && h.chars().all(|c| c.is_ascii_hexdigit())
}

/// runId de un Workflow: `wf_` y letras, dígitos, `-` o `_`.
pub fn valid_run_id(s: &str) -> bool {
    s.len() <= 80
        && s.strip_prefix("wf_").is_some_and(|r| {
            !r.is_empty()
                && r.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

fn runs_validos(runs: Vec<String>) -> Vec<String> {
    let mut vistos = HashSet::new();
    runs.into_iter()
        .filter(|r| valid_run_id(r) && vistos.insert(r.clone()))
        .take(MAX_WORKFLOWS)
        .collect()
}

/// Recorta a `max` caracteres (con «…») en una sola línea.
pub fn recortar(s: &str, max: usize) -> String {
    let s = analisis::una_linea(s);
    if s.chars().count() <= max {
        return s;
    }
    let corto: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", corto.trim_end())
}

fn recortar_opt(s: Option<String>, max: usize) -> Option<String> {
    s.map(|x| recortar(&x, max)).filter(|x| !x.is_empty())
}

/// `deserialize_with` de `Abierta::turno_vivo`: cualquier valor que no sea un
/// `TurnoVivo` válido es `None`, nunca un error del fichero entero.
pub fn tolerante<'de, D: Deserializer<'de>>(d: D) -> Result<Option<TurnoVivo>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(v.and_then(|v| serde_json::from_value::<TurnoVivo>(v).ok())
        .and_then(TurnoVivo::saneado))
}

// ---------------------------------------------------------------------------
// Captura en la salida
// ---------------------------------------------------------------------------

/// Turnos capturados en la salida: la proyección los incluye desde entonces
/// (también si el hilo escritor vuelve a escribir mientras muere el proceso).
fn cierre() -> MutexGuard<'static, HashMap<String, TurnoVivo>> {
    static C: OnceLock<Mutex<HashMap<String, TurnoVivo>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Turno vivo capturado en la salida para la sesión `id`.
pub fn del_cierre(id: &str) -> Option<TurnoVivo> {
    cierre().get(id).cloned()
}

/// Captura los turnos vivos de las sesiones abiertas (salida de ULTRON).
pub fn capturar_cierre() {
    let sesiones = match crate::sesiones::registro::persistibles() {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "no se capturan los turnos vivos: registro no disponible");
            return;
        }
    };
    // En paralelo: cada `git status` puede tardar hasta `PLAZO_GIT`.
    let turnos: HashMap<String, TurnoVivo> = std::thread::scope(|s| {
        let hilos: Vec<_> = sesiones
            .iter()
            .map(|p| s.spawn(move || capturar(p).map(|t| (p.info.id.clone(), t))))
            .collect();
        hilos
            .into_iter()
            .filter_map(|h| h.join().ok().flatten())
            .collect()
    });
    tracing::info!(n = turnos.len(), "turnos vivos capturados al cerrar");
    *cierre() = turnos;
}

/// Turno vivo de una sesión: con turno abierto o con Workflows vivos.
pub fn capturar(p: &Persistible) -> Option<TurnoVivo> {
    let en_turno = matches!(
        p.info.status,
        SessionStatus::Working | SessionStatus::Waiting
    );
    if p.info.status == SessionStatus::Exited {
        return None;
    }
    let a = p
        .transcript
        .as_deref()
        .and_then(|t| leer_analisis(t).ok())
        .unwrap_or_default();
    let workflows = runs_vivos(&a.workflows_vivos);
    if !en_turno && workflows.is_empty() {
        return None;
    }
    TurnoVivo {
        desde: en_turno.then(|| {
            p.info
                .working_since
                .clone()
                .unwrap_or_else(crate::sesiones::types::now_iso)
        }),
        ultimo_prompt: a.ultimo_prompt,
        herramienta_en_curso: if en_turno {
            a.herramienta_en_curso
        } else {
            None
        },
        workflows_vivos: workflows,
        checkpoint: checkpoint(Path::new(&p.info.cwd)),
    }
    .saneado()
}

fn leer_analisis(transcript: &Path) -> Result<analisis::Analisis, String> {
    let texto = super::en_vuelo::leer_cola(transcript, COLA_TRANSCRIPT)
        .map_err(|e| format!("no se pudo leer {}: {e}", transcript.display()))?;
    Ok(analisis::analizar(&texto))
}

/// runIds vivos, sin los que esta ejecución ya ofreció al restaurar y que no
/// se han vuelto a lanzar desde entonces (si no, se ofrecerían en cada cierre).
fn runs_vivos(w: &[analisis::WorkflowLanzado]) -> Vec<String> {
    let ofrecidos = ofrecidos();
    w.iter()
        .filter(|x| !ofrecido_antes(&ofrecidos, x))
        .map(|x| x.run_id.clone())
        .collect()
}

fn ofrecido_antes(o: &Ofrecidos, w: &analisis::WorkflowLanzado) -> bool {
    if !o.runs.contains(&w.run_id) {
        return false;
    }
    let lanzado = w
        .lanzado_en
        .as_deref()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
    match (lanzado, o.desde) {
        (Some(l), Some(d)) => l.with_timezone(&chrono::Utc) < d,
        _ => true,
    }
}

#[derive(Default)]
struct Ofrecidos {
    runs: HashSet<String>,
    desde: Option<chrono::DateTime<chrono::Utc>>,
}

fn ofrecidos() -> MutexGuard<'static, Ofrecidos> {
    static O: OnceLock<Mutex<Ofrecidos>> = OnceLock::new();
    O.get_or_init(|| Mutex::new(Ofrecidos::default()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Anota los runIds ofrecidos al restaurar (con el instante de la primera vez).
pub fn marcar_ofrecidos(runs: &[String]) {
    let mut o = ofrecidos();
    o.desde.get_or_insert_with(chrono::Utc::now);
    o.runs.extend(runs.iter().cloned());
}

// ---------------------------------------------------------------------------
// Continuación al restaurar
// ---------------------------------------------------------------------------

/// Evento con el prompt de continuación: el composer lo deja sin enviar y,
/// si ya había borrador, debajo de él.
pub const EV_CONTINUACION: &str = "sesiones://continuation";

fn continuaciones() -> MutexGuard<'static, HashMap<String, String>> {
    static C: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Prepara la continuación de una sesión restaurada: sale con sus notas
/// (`entregar_avisos`), cuando la ventana ya escucha. Nunca se envía.
pub fn ofrecer(id: &str, t: &TurnoVivo, transcript: &Path) {
    let texto = texto::continuacion(t, &|run| script_de(transcript, run));
    marcar_ofrecidos(&t.workflows_vivos);
    continuaciones().insert(id.to_string(), texto);
    super::anotar(id, "info", texto::nota(t));
}

/// Emite la continuación pendiente de la sesión, si la hay (una sola vez).
pub fn entregar_continuacion(s: &dyn Sink, id: &str) {
    let Some(texto) = continuaciones().remove(id) else {
        return;
    };
    s.emit(EV_CONTINUACION, json!({ "id": id, "text": texto }));
}

pub fn olvidar_continuacion(id: &str) {
    continuaciones().remove(id);
}

/// Continuación pendiente de entregar (pruebas).
#[cfg(test)]
pub fn continuacion_pendiente(id: &str) -> Option<String> {
    continuaciones().get(id).cloned()
}

// ---------------------------------------------------------------------------
// Checkpoint de git (solo lectura)
// ---------------------------------------------------------------------------

/// HEAD, rama y suciedad del árbol de `cwd`. `None` si no es un repositorio,
/// git no está o no responde en `PLAZO_GIT`.
pub fn checkpoint(cwd: &Path) -> Option<Checkpoint> {
    checkpoint_con_plazo(cwd, PLAZO_GIT)
}

/// `checkpoint` con el plazo de `git status` explícito. La salida de ULTRON
/// usa `PLAZO_GIT`; las pruebas que leen un repositorio real pasan uno
/// holgado, porque en un runner frío con los tests en paralelo un
/// `git status` puede pasar de 1,5 s y dar `None` sin que el código falle.
pub fn checkpoint_con_plazo(cwd: &Path, plazo: Duration) -> Option<Checkpoint> {
    if !cwd.is_dir() {
        return None;
    }
    let salida = git_status(cwd, plazo)?;
    parsear_status(&salida)
}

/// Margen mínimo para recoger la salida ya escrita tras salir git.
const MARGEN_LECTURA: Duration = Duration::from_millis(200);

fn git_status(cwd: &Path, plazo: Duration) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args([
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=normal",
    ])
    .current_dir(cwd)
    .env("GIT_OPTIONAL_LOCKS", "0")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut hijo = cmd.spawn().ok()?;
    let mut stdout = hijo.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        let _ = tx.send(s);
    });
    let limite = Instant::now() + plazo;
    let estado = loop {
        match hijo.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if Instant::now() < limite => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = hijo.kill();
                let _ = hijo.wait();
                break None;
            }
        }
    };
    let ok = estado.is_some_and(|s| s.success());
    // El hilo lector puede tardar en ser planificado con la máquina cargada:
    // espera lo que quede del plazo, nunca menos que `MARGEN_LECTURA`.
    let resto = limite.saturating_duration_since(Instant::now());
    let texto = rx.recv_timeout(resto.max(MARGEN_LECTURA)).ok()?;
    ok.then_some(texto)
}

/// Lee la salida de `git status --porcelain=v2 --branch`.
pub fn parsear_status(salida: &str) -> Option<Checkpoint> {
    let mut oid = None;
    let mut rama = None;
    let mut sucio = false;
    for l in salida.lines() {
        if let Some(v) = l.strip_prefix("# branch.oid ") {
            oid = Some(v.trim().to_string());
        } else if let Some(v) = l.strip_prefix("# branch.head ") {
            rama = Some(v.trim().to_string()).filter(|r| r != "(detached)");
        } else if !l.starts_with('#') && !l.trim().is_empty() {
            sucio = true;
        }
    }
    let oid = oid?;
    Some(
        Checkpoint {
            head: Some(oid).filter(|h| es_sha(h)),
            rama,
            sucio,
        }
        .saneado(),
    )
}

/// Scripts de los Workflows de la conversación del transcript:
/// `<dir>/<sid>/workflows/scripts/*-<runId>.js`.
pub fn script_de(transcript: &Path, run_id: &str) -> Option<PathBuf> {
    let sid = transcript.file_stem()?;
    let dir = transcript
        .parent()?
        .join(sid)
        .join("workflows")
        .join("scripts");
    let fin = format!("-{run_id}.js");
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().ends_with(&fin))
        })
}

#[cfg(test)]
#[path = "tests_persistencia_turno.rs"]
mod tests;
