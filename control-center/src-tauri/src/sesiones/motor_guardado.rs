// sesiones/motor_guardado.rs — Persistencia de las tareas terminadas de
// motores (submódulo de `motor`): `cockpit/sesiones/motores.json`, ignorado por
// git. `brought_at` sobrevive a un reinicio de la app y el botón «Traer a
// Claude» no vuelve a ofrecerse (R25).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::{
    es_chat, evt, list, push_event, CodexEvent, EngineTask, EngineUsage, Entry, MAX_GUARDADAS,
};

fn store_path() -> Option<PathBuf> {
    if cfg!(test) {
        return None; // los tests nunca tocan el cockpit real
    }
    crate::ultron_root()
        .ok()
        .map(|r| r.join("cockpit").join("sesiones").join("motores.json"))
}

/// Forma en disco de `EngineTask` (el tipo compartido solo serializa).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Guardada {
    id: String,
    engine: String,
    kind: String,
    mode: String,
    cwd: String,
    prompt: String,
    status: String,
    started_at: String,
    finished_at: Option<String>,
    #[serde(default)]
    events: Vec<EventoGuardado>,
    summary: Option<String>,
    cloud_task_id: Option<String>,
    session_id: Option<String>,
    thread_id: Option<String>,
    #[serde(default)]
    context_chars: usize,
    model: Option<String>,
    brought_at: Option<String>,
    anchor_message_uuid: Option<String>,
    #[serde(default)]
    usage: Option<EngineUsage>,
    #[serde(default)]
    group: Option<String>,
}

#[derive(serde::Deserialize)]
struct EventoGuardado {
    kind: String,
    text: String,
}

impl From<Guardada> for EngineTask {
    fn from(g: Guardada) -> Self {
        EngineTask {
            id: g.id,
            engine: g.engine,
            kind: g.kind,
            mode: g.mode,
            cwd: g.cwd,
            prompt: g.prompt,
            status: g.status,
            started_at: g.started_at,
            finished_at: g.finished_at,
            events: g
                .events
                .into_iter()
                .map(|e| CodexEvent {
                    kind: e.kind,
                    text: e.text,
                })
                .collect(),
            summary: g.summary,
            cloud_task_id: g.cloud_task_id,
            session_id: g.session_id,
            thread_id: g.thread_id,
            context_chars: g.context_chars,
            model: g.model,
            brought_at: g.brought_at,
            anchor_message_uuid: g.anchor_message_uuid,
            usage: g.usage,
            group: g.group,
        }
    }
}

/// Tareas de `motores.json` más los turnos de las sesiones de motor abiertas
/// (`motor_sesion`).
pub(super) fn cargar_inicial() -> HashMap<String, Entry> {
    let Some(path) = store_path() else {
        return HashMap::new();
    };
    let turnos = crate::sesiones::motor_sesion::turnos_iniciales();
    cargar_de(&path)
        .into_iter()
        .filter(|t| !es_chat(t))
        .chain(turnos)
        .map(|task| {
            let entry = Entry {
                task,
                child: None,
                trabajo: None,
            };
            (entry.task.id.clone(), entry)
        })
        .collect()
}

/// Tareas guardadas en `path`. Una tarea que figuraba en curso no puede
/// seguir viva tras un reinicio: se marca con error.
pub fn cargar_de(path: &Path) -> Vec<EngineTask> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            tracing::warn!(error = %e, "no se pudieron leer las tareas de motores guardadas");
            return Vec::new();
        }
    };
    let tasks: Vec<Guardada> = serde_json::from_str(&raw).unwrap_or_else(|e| {
        tracing::warn!(error = %e, "tareas de motores guardadas no válidas: se ignoran");
        Vec::new()
    });
    tasks
        .into_iter()
        .map(EngineTask::from)
        .map(cerrar_en_curso)
        .collect()
}

/// Una tarea que figuraba en curso no puede seguir viva tras un reinicio.
fn cerrar_en_curso(mut t: EngineTask) -> EngineTask {
    if t.status == "running" {
        t.status = "error".into();
        push_event(
            &mut t,
            evt("error", "la app se cerró con la tarea en curso".into()),
        );
    }
    t
}

/// Tareas en su forma de disco (los turnos de `motor-sesiones.json`); una que
/// no se pueda leer se descarta con un aviso y una en curso pasa a `error`.
pub fn tareas_de(valores: Vec<serde_json::Value>) -> Vec<EngineTask> {
    valores
        .into_iter()
        .filter_map(|v| {
            serde_json::from_value::<Guardada>(v)
                .inspect_err(|e| tracing::warn!(error = %e, "turno guardado no válido: se ignora"))
                .ok()
        })
        .map(EngineTask::from)
        .map(cerrar_en_curso)
        .collect()
}

/// Escribe en `path` las tareas terminadas más recientes (escritura atómica).
pub fn guardar_en(path: &Path, tasks: &[EngineTask]) -> Result<(), String> {
    let mut done: Vec<&EngineTask> = tasks
        .iter()
        .filter(|t| t.status != "running" && !es_chat(t))
        .collect();
    done.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    done.truncate(MAX_GUARDADAS);
    let json = serde_json::to_string(&done).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn guardar() {
    let Some(path) = store_path() else {
        return;
    };
    if let Err(e) = guardar_en(&path, &list(None)) {
        tracing::warn!(error = %e, "no se pudieron guardar las tareas de motores");
    }
}
