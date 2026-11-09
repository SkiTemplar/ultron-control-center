// sesiones/motor_chat.rs — Turnos de las sesiones de motor (submódulo de
// `motor`): tareas con `kind = "chat"` y `session_id` = id de la sesión de
// motor (`motor_sesion.rs`).
//
// Los turnos viven en el registro de tareas mientras su sesión está abierta
// (stream `sesiones://engine`, cancelar, plazo), pero no cuentan para
// `MAX_GUARDADAS`, no se escriben en `motores.json` y `limpiar` no los borra:
// los persiste `motor_sesion` en `motor-sesiones.json`.

#[cfg(test)]
use super::emit;
use super::{list, lock, EngineTask, Entry};
use crate::sesiones::registro;
use crate::sesiones::types::ev;

/// Tipo de las tareas que son turnos de una sesión de motor.
pub const KIND_CHAT: &str = "chat";

/// ¿Es un turno de una sesión de motor?
pub fn es_chat(t: &EngineTask) -> bool {
    t.kind == KIND_CHAT
}

/// Turnos de la sesión `session_id`, en orden cronológico.
pub fn turnos_de_sesion(session_id: &str) -> Vec<EngineTask> {
    let mut v: Vec<EngineTask> = list(None)
        .into_iter()
        .filter(|t| es_chat(t) && t.session_id.as_deref() == Some(session_id))
        .collect();
    v.reverse();
    v
}

/// Registra turnos ya terminados (al reabrir una sesión de motor). No pisa
/// una tarea que ya esté en el registro.
pub fn insertar_turnos(turnos: Vec<EngineTask>) {
    if turnos.is_empty() {
        return;
    }
    if let Ok(mut m) = lock() {
        for task in turnos {
            m.entry(task.id.clone()).or_insert(Entry {
                task,
                child: None,
                trabajo: None,
            });
        }
    }
    emitir_lista();
}

/// Saca del registro los turnos terminados de la sesión (al cerrarla) y los
/// devuelve en orden cronológico. Los que sigan en curso se quedan.
pub fn retirar_turnos(session_id: &str) -> Vec<EngineTask> {
    let mut fuera: Vec<EngineTask> = match lock() {
        Ok(mut m) => {
            let ids: Vec<String> = m
                .values()
                .filter(|e| es_turno_terminado(&e.task, session_id))
                .map(|e| e.task.id.clone())
                .collect();
            ids.iter()
                .filter_map(|id| m.remove(id))
                .map(|e| e.task)
                .collect()
        }
        Err(_) => Vec::new(),
    };
    fuera.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    if !fuera.is_empty() {
        emitir_lista();
    }
    fuera
}

fn es_turno_terminado(t: &EngineTask, session_id: &str) -> bool {
    es_chat(t) && t.status != "running" && t.session_id.as_deref() == Some(session_id)
}

/// Conserva los `max` turnos terminados más recientes de la sesión (y los
/// que sigan en curso).
pub fn podar_turnos(session_id: &str, max: usize) {
    let Ok(mut m) = lock() else {
        return;
    };
    let mut terminados: Vec<(String, String)> = m
        .values()
        .filter(|e| es_turno_terminado(&e.task, session_id))
        .map(|e| (e.task.started_at.clone(), e.task.id.clone()))
        .collect();
    if terminados.len() <= max {
        return;
    }
    terminados.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, id) in terminados.into_iter().skip(max) {
        m.remove(&id);
    }
}

/// Emite la lista de tareas (`sesiones://engine-list`) a las ventanas.
pub(super) fn emitir_lista() {
    if let Ok(v) = serde_json::to_value(list(None)) {
        registro::emit(ev::ENGINE_LIST, v);
    }
}

/// Avisa a `motor_sesion` de cada cambio de un turno (fin, cancelación,
/// plazo vencido): la sesión vuelve a `idle` y guarda el hilo de Codex.
pub(super) fn avisar_cambio(t: &EngineTask) {
    if es_chat(t) {
        crate::sesiones::motor_sesion::turno_actualizado(t);
    }
}

/// Tarea nueva sin registrar (solo tests).
#[cfg(test)]
pub fn nueva_para_prueba(spec: super::TaskSpec) -> EngineTask {
    super::new_task(spec)
}

/// Registra un turno en curso sin proceso (solo tests).
#[cfg(test)]
pub fn lanzar_para_prueba(spec: super::TaskSpec) -> Result<EngineTask, String> {
    let task = super::new_task(spec);
    lock()?.insert(
        task.id.clone(),
        Entry {
            task: task.clone(),
            child: None,
            trabajo: None,
        },
    );
    emit(&task);
    Ok(task)
}

/// Cierra un turno en curso con `status`, respuesta e hilo (solo tests).
#[cfg(test)]
pub fn terminar_para_prueba(id: &str, status: &str, summary: &str, thread: Option<&str>) {
    super::with_task(id, |t| {
        t.status = status.to_string();
        t.finished_at = Some(crate::sesiones::types::now_iso());
        t.summary = Some(summary.to_string());
        t.thread_id = thread.map(str::to_string);
    });
}
