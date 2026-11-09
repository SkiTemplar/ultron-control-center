// sesiones/workflows_seguidor.rs — Seguimiento en disco de los runs de
// `Workflow` de una sesión.
//
// Cada run tiene un cursor sobre su journal y otro por agente (solo para la
// actividad: los mensajes los sigue `seguidor_agentes.rs`). El JSON final se
// relee solo si cambia su fecha. `seguir` devuelve los runs que cambiaron
// desde la última emisión; `scan` reconstruye todo desde cero (recarga de
// la ventana o sesión que aún no se ha seguido). Un run terminado hace más
// de `RETIRO` se revisa cada `REVISION_RETIRADO` por si se reanuda.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

use super::actividad::Actividad;
use super::meta::{parse_meta, MetaScript};
use super::{componer, final_vigente, Fuentes, Journal, MetaAgente};
use crate::sesiones::agentes;
use crate::sesiones::persistencia::turno::valid_run_id;
use crate::sesiones::registro::{self, Sesion};
use crate::sesiones::seguidor::Cursor;
use crate::sesiones::types::{SessionStatus, WorkflowRun, WorkflowStatus};

/// Intervalo mínimo entre dos pasadas por una sesión.
const INTERVALO: Duration = Duration::from_millis(500);
const RETIRO: Duration = Duration::from_secs(120);
const REVISION_RETIRADO: Duration = Duration::from_secs(10);

fn ms(t: SystemTime) -> Option<u64> {
    let d = t.duration_since(SystemTime::UNIX_EPOCH).ok()?;
    u64::try_from(d.as_millis()).ok()
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn leer_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// Script del run: `<sid>/workflows/scripts/<nombre>-<runId>.js`.
fn buscar_script(sesion_dir: &Path, run_id: &str) -> Option<MetaScript> {
    let fin = format!("-{run_id}.js");
    let p = std::fs::read_dir(sesion_dir.join("workflows").join("scripts"))
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().ends_with(&fin))
        })?;
    parse_meta(&std::fs::read_to_string(p).ok()?)
}

/// `agentId` sale del contenido del journal y acaba en una ruta
/// (`agent-{id}.jsonl`): solo se aceptan `[A-Za-z0-9_-]` para que no pueda
/// salir del directorio del run.
pub(crate) fn agent_id_valido(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn leer_meta_agente(dir: &Path, agent_id: &str) -> MetaAgente {
    let v = agent_id_valido(agent_id)
        .then(|| leer_json(&dir.join(format!("agent-{agent_id}.meta.json"))))
        .flatten()
        .unwrap_or(Value::Null);
    let s = |k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    MetaAgente {
        agent_type: s("agentType"),
        model: s("model"),
    }
}

struct RunSeguido {
    run_id: String,
    dir: PathBuf,
    journal: Cursor,
    diario: Journal,
    cursores: HashMap<String, Cursor>,
    actividad: HashMap<String, Actividad>,
    metas: HashMap<String, MetaAgente>,
    meta: Option<MetaScript>,
    final_json: Option<(SystemTime, Value)>,
    inicio_ms: Option<u64>,
    ultimo: Option<WorkflowRun>,
    cerrado_desde: Option<Instant>,
    proxima_revision: Option<Instant>,
}

impl RunSeguido {
    fn abrir(sesion_dir: &Path, run_id: &str, dir: PathBuf) -> Self {
        let journal = dir.join("journal.jsonl");
        let inicio = std::fs::metadata(&journal)
            .ok()
            .and_then(|m| m.created().ok());
        Self {
            run_id: run_id.to_string(),
            journal: Cursor::al_dia(journal),
            dir,
            diario: Journal::default(),
            cursores: HashMap::new(),
            actividad: HashMap::new(),
            metas: HashMap::new(),
            meta: buscar_script(sesion_dir, run_id),
            final_json: None,
            inicio_ms: inicio.and_then(ms),
            ultimo: None,
            cerrado_desde: None,
            proxima_revision: None,
        }
    }

    fn toca(&mut self, ahora: Instant) -> bool {
        let retirado = self
            .cerrado_desde
            .is_some_and(|t| ahora.saturating_duration_since(t) > RETIRO);
        if !retirado || self.proxima_revision.is_none_or(|p| ahora >= p) {
            self.proxima_revision = retirado.then_some(ahora + REVISION_RETIRADO);
            return true;
        }
        false
    }

    fn leer_agentes(&mut self) {
        for i in &self.diario.intentos {
            let id = &i.agent_id;
            if !agent_id_valido(id) {
                continue;
            }
            if !self.cursores.contains_key(id) {
                let p = self.dir.join(format!("agent-{id}.jsonl"));
                if !p.is_file() {
                    continue;
                }
                self.cursores.insert(id.clone(), Cursor::al_dia(p));
                self.metas
                    .insert(id.clone(), leer_meta_agente(&self.dir, id));
            }
            let Some(c) = self.cursores.get_mut(id) else {
                continue;
            };
            let l = c.leer();
            let act = self.actividad.entry(id.clone()).or_default();
            if l.reiniciado {
                *act = Actividad::default();
            }
            l.lineas.iter().for_each(|v| act.feed(v));
        }
    }

    /// Relee el JSON final si cambió; lo descarta si es más viejo que el journal.
    fn leer_final(&mut self, sesion_dir: &Path) {
        let p = sesion_dir
            .join("workflows")
            .join(format!("{}.json", self.run_id));
        let Some(t) = mtime(&p) else {
            self.final_json = None;
            return;
        };
        let journal_ms = mtime(&self.journal.path).and_then(ms).unwrap_or(0);
        if !final_vigente(ms(t).unwrap_or(0), journal_ms) {
            self.final_json = None;
            return;
        }
        if self.final_json.as_ref().is_some_and(|(prev, _)| *prev == t) {
            return;
        }
        self.final_json = leer_json(&p).map(|v| (t, v));
        if self.meta.is_none() {
            let script = self
                .final_json
                .as_ref()
                .and_then(|(_, v)| v.get("script")?.as_str());
            self.meta = script.and_then(parse_meta);
        }
    }

    /// Pasada completa; devuelve el run si cambió desde la última emisión.
    fn actualizar(
        &mut self,
        sesion_dir: &Path,
        proceso: Option<SystemTime>,
        ahora: Instant,
    ) -> Option<WorkflowRun> {
        let viva = run_vivo(&self.journal.path, proceso);
        self.journal
            .leer()
            .lineas
            .iter()
            .for_each(|v| self.diario.aplicar(v));
        self.leer_agentes();
        self.leer_final(sesion_dir);
        let run = componer(&Fuentes {
            run_id: &self.run_id,
            journal: &self.diario,
            meta: self.meta.as_ref(),
            final_json: self.final_json.as_ref().map(|(_, v)| v),
            actividad: &self.actividad,
            metas: &self.metas,
            inicio_ms: self.inicio_ms,
            sesion_viva: viva,
        });
        if run.status == WorkflowStatus::Running {
            self.cerrado_desde = None;
        } else {
            self.cerrado_desde.get_or_insert(ahora);
        }
        if self.ultimo.as_ref() == Some(&run) {
            return None;
        }
        self.ultimo = Some(run.clone());
        Some(run)
    }
}

/// Un run sin JSON final solo puede seguir vivo en el proceso que lo lanzó o
/// lo reanudó: con la sesión cerrada, o con un journal que no se ha tocado
/// desde que arrancó el proceso actual, el run se perdió con el anterior.
pub fn run_vivo(journal: &Path, proceso: Option<SystemTime>) -> bool {
    let Some(arranque) = proceso else {
        return false;
    };
    mtime(journal).is_some_and(|t| t + Duration::from_secs(2) >= arranque)
}

/// Runs de `<sid>/subagents/workflows/wf_*`.
fn listar_runs(sesion_dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(sesion_dir.join("subagents").join("workflows")) else {
        return Vec::new();
    };
    rd.flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let id = e.file_name().to_string_lossy().to_string();
            valid_run_id(&id).then(|| (id, e.path()))
        })
        .collect()
}

/// Runs seguidos de una sesión.
#[derive(Default)]
pub struct Workflows {
    runs: HashMap<String, RunSeguido>,
    ultima: Option<Instant>,
}

impl Workflows {
    pub fn clear(&mut self) {
        self.runs.clear();
        self.ultima = None;
    }

    /// Pasada por los runs de `sesion_dir` (`<slug>/<sid>`); devuelve los
    /// que cambiaron. `proceso`: arranque del proceso de Claude de la sesión,
    /// `None` si ya salió. Como mucho una vez cada `INTERVALO`.
    pub fn seguir(
        &mut self,
        sesion_dir: &Path,
        proceso: Option<SystemTime>,
        ahora: Instant,
    ) -> Vec<WorkflowRun> {
        self.pasada(sesion_dir, proceso, ahora).0
    }

    /// `seguir` y, si algo cambió (runs nuevos o actualizados, o runs cuyo
    /// directorio desapareció), guarda la foto de la sesión `id`.
    pub fn seguir_y_guardar(
        &mut self,
        id: &str,
        sesion_dir: &Path,
        proceso: Option<SystemTime>,
        ahora: Instant,
    ) -> Vec<WorkflowRun> {
        let (cambiados, quitados) = self.pasada(sesion_dir, proceso, ahora);
        if !cambiados.is_empty() || quitados {
            guardar(id, self.todos());
        }
        cambiados
    }

    /// Runs que cambiaron y si se dejó de seguir alguno: solo se conservan
    /// los que `listar_runs` aún encuentra en disco.
    fn pasada(
        &mut self,
        sesion_dir: &Path,
        proceso: Option<SystemTime>,
        ahora: Instant,
    ) -> (Vec<WorkflowRun>, bool) {
        if self
            .ultima
            .is_some_and(|u| ahora.saturating_duration_since(u) < INTERVALO)
        {
            return (Vec::new(), false);
        }
        self.ultima = Some(ahora);
        let en_disco = listar_runs(sesion_dir);
        let antes = self.runs.len();
        self.runs
            .retain(|id, _| en_disco.iter().any(|(run_id, _)| run_id == id));
        let quitados = self.runs.len() < antes;
        let mut cambiados = Vec::new();
        for (run_id, dir) in en_disco {
            let r = self
                .runs
                .entry(run_id.clone())
                .or_insert_with(|| RunSeguido::abrir(sesion_dir, &run_id, dir));
            if r.toca(ahora) {
                cambiados.extend(r.actualizar(sesion_dir, proceso, ahora));
            }
        }
        (cambiados, quitados)
    }

    /// Último estado de todos los runs, del más antiguo al más reciente.
    pub fn todos(&self) -> Vec<WorkflowRun> {
        let mut v: Vec<WorkflowRun> = self
            .runs
            .values()
            .filter_map(|r| r.ultimo.clone())
            .collect();
        v.sort_by(|a, b| {
            a.started_at
                .cmp(&b.started_at)
                .then_with(|| a.run_id.cmp(&b.run_id))
        });
        v
    }
}

/// Reconstrucción completa desde el disco.
pub fn scan(sesion_dir: &Path, proceso: Option<SystemTime>) -> Vec<WorkflowRun> {
    let mut w = Workflows::default();
    w.seguir(sesion_dir, proceso, Instant::now());
    w.todos()
}

fn cache() -> &'static Mutex<HashMap<String, Vec<WorkflowRun>>> {
    static C: OnceLock<Mutex<HashMap<String, Vec<WorkflowRun>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Guarda la foto de los runs de una sesión seguida.
pub fn guardar(id: &str, runs: Vec<WorkflowRun>) {
    if let Ok(mut m) = cache().lock() {
        m.insert(id.to_string(), runs);
    }
}

pub fn en_cache(id: &str) -> Option<Vec<WorkflowRun>> {
    cache().lock().ok()?.get(id).cloned()
}

pub fn olvidar(id: &str) {
    if let Ok(mut m) = cache().lock() {
        m.remove(id);
    }
}

/// Arranque del proceso de Claude de la sesión; `None` si ya salió.
pub fn proceso_de(s: &Sesion) -> Option<SystemTime> {
    (s.info.status != SessionStatus::Exited).then_some(s.spawned_at)
}

/// Runs de una sesión (comando `sesiones_workflows`): la foto del seguidor
/// o, si aún no la hay, una reconstrucción desde el disco.
pub fn de_sesion(id: &str) -> Result<Vec<WorkflowRun>, String> {
    if let Some(v) = en_cache(id) {
        return Ok(v);
    }
    let (sub, proceso) = registro::read(id, |s| {
        let sid = s.info.claude_session_id.as_ref();
        (
            sid.map(|sid| agentes::subagents_dir(&s.slug_dir, sid)),
            proceso_de(s),
        )
    })?;
    let sesion_dir = sub.as_deref().and_then(Path::parent).map(Path::to_path_buf);
    Ok(sesion_dir.map(|d| scan(&d, proceso)).unwrap_or_default())
}
