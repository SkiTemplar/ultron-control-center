// sesiones/puente_fondo.rs — Trabajo en segundo plano del hilo principal que
// el mod no ve: shells y monitores lanzados con `run_in_background` y los
// despertadores (`ScheduleWakeup`, `/loop`).
//
// La CLI cierra el turno en cuanto los lanza, así que la sesión queda `idle`
// aunque siga esperando a un proceso. La API de mods no expone esa lista; el
// hook `Stop` de Claude Code sí (`background_tasks`, `session_crons`). El hook
// `sesiones-fondo.js` la reenvía a `/v1/background` al final de cada turno y
// aquí se normaliza. Los subagentes y workflows se descartan: ya llegan por
// el puente (`agentSpawn`, seguidor de workflows) y contarían dos veces.

use serde_json::Value;

use crate::sesiones::types::BackgroundTask;

/// Tope de entradas por sesión: la lista solo alimenta un contador y un
/// texto, y el cuerpo del hook viene de fuera.
pub const MAX_TAREAS: usize = 32;
/// Tope de la descripción en caracteres.
pub const MAX_DESCRIPCION: usize = 200;

/// Tipos que ya cuenta el puente por su cuenta.
const YA_CONTADOS: [&str; 2] = ["subagent", "workflow"];
/// Estados que ya no son trabajo vivo.
const TERMINADOS: [&str; 4] = ["completed", "failed", "killed", "stopped"];

fn texto(v: &Value, campo: &str) -> Option<String> {
    v.get(campo)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn recortar(s: &str) -> String {
    s.chars().take(MAX_DESCRIPCION).collect()
}

fn tarea(v: &Value) -> Option<BackgroundTask> {
    let id = texto(v, "id")?;
    let kind = texto(v, "type").unwrap_or_else(|| "task".into());
    if YA_CONTADOS.contains(&kind.as_str()) {
        return None;
    }
    let status = texto(v, "status").unwrap_or_default();
    if TERMINADOS.contains(&status.as_str()) {
        return None;
    }
    let description = texto(v, "description")
        .or_else(|| texto(v, "command"))
        .unwrap_or_else(|| kind.clone());
    Some(BackgroundTask {
        id,
        kind,
        description: recortar(&description),
        schedule: None,
        recurring: false,
    })
}

fn despertador(v: &Value) -> Option<BackgroundTask> {
    Some(BackgroundTask {
        id: texto(v, "id")?,
        kind: "cron".into(),
        description: recortar(&texto(v, "prompt").unwrap_or_default()),
        schedule: Some(texto(v, "schedule")?),
        recurring: v.get("recurring").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn lista<'a>(body: &'a Value, campo: &str) -> impl Iterator<Item = &'a Value> {
    body.get(campo)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// Lista normalizada del cuerpo de `/v1/background`: `backgroundTasks` y
/// `sessionCrons` tal y como los da el hook `Stop`. Un cuerpo sin ellas da
/// una lista vacía: el hook manda las dos siempre, y vacías significan que
/// no queda nada en vuelo.
pub fn tareas(body: &Value) -> Vec<BackgroundTask> {
    lista(body, "backgroundTasks")
        .filter_map(tarea)
        .chain(lista(body, "sessionCrons").filter_map(despertador))
        .take(MAX_TAREAS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shell_y_monitor_cuentan_y_subagentes_y_workflows_no() {
        let body = json!({
            "backgroundTasks": [
                { "id": "b1", "type": "shell", "status": "running", "description": "", "command": "npm run build" },
                { "id": "m1", "type": "monitor", "status": "running", "description": "vigila el CI" },
                { "id": "a1", "type": "subagent", "status": "running", "description": "revisor" },
                { "id": "w1", "type": "workflow", "status": "running", "description": "review" }
            ],
            "sessionCrons": []
        });
        let t = tareas(&body);
        assert_eq!(t.len(), 2);
        assert_eq!(
            (t[0].kind.as_str(), t[0].description.as_str()),
            ("shell", "npm run build")
        );
        assert_eq!(
            (t[1].kind.as_str(), t[1].description.as_str()),
            ("monitor", "vigila el CI")
        );
    }

    #[test]
    fn los_despertadores_llevan_su_expresion_cron() {
        let body = json!({
            "backgroundTasks": [],
            "sessionCrons": [{ "id": "c1", "schedule": "30 14 23 11 *", "recurring": false, "prompt": "mira el CI" }]
        });
        let t = tareas(&body);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].kind, "cron");
        assert_eq!(t[0].schedule.as_deref(), Some("30 14 23 11 *"));
        assert!(!t[0].recurring);
    }

    /// Caso negativo: listas vacías, entradas terminadas, sin id o mal
    /// formadas no dejan trabajo vivo.
    #[test]
    fn sin_trabajo_vivo_la_lista_queda_vacia() {
        assert!(tareas(&json!({ "backgroundTasks": [], "sessionCrons": [] })).is_empty());
        assert!(tareas(&json!({})).is_empty());
        let body = json!({
            "backgroundTasks": [
                { "id": "b1", "type": "shell", "status": "completed" },
                { "type": "shell", "status": "running" },
                "basura"
            ],
            "sessionCrons": [{ "id": "c1", "prompt": "sin schedule" }]
        });
        assert!(tareas(&body).is_empty());
    }

    #[test]
    fn recorta_descripciones_y_numero_de_entradas() {
        let largas: Vec<Value> = (0..50)
            .map(|i| json!({ "id": format!("b{i}"), "type": "shell", "status": "running", "description": "x".repeat(500) }))
            .collect();
        let t = tareas(&json!({ "backgroundTasks": largas }));
        assert_eq!(t.len(), MAX_TAREAS);
        assert_eq!(t[0].description.chars().count(), MAX_DESCRIPCION);
    }
}
