// sesiones/persistencia_turno_analisis.rs — Lo que se estaba haciendo según
// la cola del transcript al cerrar ULTRON (cerrar a mitad de turno, A + D).
//
// Del hilo principal (sin `isSidechain`) saca:
//
// - el último prompt del usuario (mismo criterio que el chat: `parse_all`);
// - la última herramienta pedida sin `tool_result` (la que estaba en curso);
// - los Workflows vivos. La herramienta `Workflow` responde en el acto con
//   `toolUseResult { status: "async_launched", taskType: "local_workflow",
//   runId: "wf_…", taskId, scriptPath }` y su final llega más tarde como un
//   `<task-notification>` con `<tool-use-id>` y `<task-id>` (en una línea de
//   usuario, en `queue-operation` o en un adjunto `queued_command`). Un
//   lanzamiento sin esa notificación, y que ninguna llamada posterior retoma
//   con `resumeFromRunId`, sigue vivo. Un `Workflow` sin `tool_result` aún no
//   tiene runId y no se puede ofrecer.

use std::collections::HashSet;

use serde_json::Value;

use crate::sesiones::transcript;
use crate::sesiones::types::{Block, MessageKind};

/// Workflow lanzado y sin notificación de final.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowLanzado {
    pub tool_use_id: String,
    pub task_id: Option<String>,
    pub run_id: String,
    /// Marca de tiempo de la línea del lanzamiento (ISO), si la tiene.
    pub lanzado_en: Option<String>,
}

/// Resultado del análisis.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Analisis {
    pub ultimo_prompt: Option<String>,
    pub herramienta_en_curso: Option<String>,
    pub workflows_vivos: Vec<WorkflowLanzado>,
}

/// Herramienta pedida por el asistente que aún no tiene resultado.
struct Pendiente {
    id: String,
    descripcion: String,
}

#[derive(Default)]
struct Estado {
    pendientes: Vec<Pendiente>,
    lanzados: Vec<WorkflowLanzado>,
    terminados: HashSet<String>,
    retomados: HashSet<String>,
}

/// Analiza el texto JSONL (la cola del transcript). Nunca falla: una línea
/// ilegible se ignora.
pub fn analizar(texto: &str) -> Analisis {
    let mut e = Estado::default();
    for linea in texto.lines() {
        linea_de(&mut e, linea);
    }
    let vivos = e
        .lanzados
        .into_iter()
        .filter(|w| {
            !e.terminados.contains(&w.tool_use_id)
                && !w.task_id.as_ref().is_some_and(|t| e.terminados.contains(t))
                && !e.retomados.contains(&w.tool_use_id)
        })
        .collect();
    Analisis {
        ultimo_prompt: ultimo_prompt(texto),
        herramienta_en_curso: e.pendientes.pop().map(|p| p.descripcion),
        workflows_vivos: vivos,
    }
}

fn linea_de(e: &mut Estado, linea: &str) {
    if linea.contains("<task-notification>") {
        e.terminados.extend(etiquetas(linea, "tool-use-id"));
        e.terminados.extend(etiquetas(linea, "task-id"));
    }
    if es_prompt_nuevo(linea) {
        // Turno nuevo: lo que quedó sin resultado antes ya no está en curso.
        e.pendientes.clear();
        return;
    }
    // Solo se parsean las líneas que pueden llevar herramientas.
    if !linea.contains("\"tool_use\"") && !linea.contains("\"tool_result\"") {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(linea) else {
        return;
    };
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let Some(bloques) = v.pointer("/message/content").and_then(Value::as_array) else {
        return;
    };
    for b in bloques {
        match b.get("type").and_then(Value::as_str) {
            Some("tool_use") => tool_use(e, b),
            Some("tool_result") => tool_result(e, b, &v),
            _ => {}
        }
    }
}

fn tool_use(e: &mut Estado, b: &Value) {
    let Some(id) = b.get("id").and_then(Value::as_str) else {
        return;
    };
    let nombre = b
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("herramienta");
    let input = b.get("input");
    if nombre == "Workflow" {
        if let Some(run) = input
            .and_then(|i| i.get("resumeFromRunId"))
            .and_then(Value::as_str)
        {
            // Los lanzamientos anteriores de ese runId quedan retomados.
            let previos: Vec<String> = e
                .lanzados
                .iter()
                .filter(|w| w.run_id == run)
                .map(|w| w.tool_use_id.clone())
                .collect();
            e.retomados.extend(previos);
        }
    }
    e.pendientes.push(Pendiente {
        id: id.to_string(),
        descripcion: describir(nombre, input),
    });
}

fn tool_result(e: &mut Estado, b: &Value, linea: &Value) {
    let Some(id) = b.get("tool_use_id").and_then(Value::as_str) else {
        return;
    };
    e.pendientes.retain(|p| p.id != id);
    let Some(r) = linea.get("toolUseResult") else {
        return;
    };
    let es_lanzamiento = r.get("taskType").and_then(Value::as_str) == Some("local_workflow")
        && r.get("status").and_then(Value::as_str) == Some("async_launched");
    let run = r
        .get("runId")
        .and_then(Value::as_str)
        .filter(|s| super::valid_run_id(s));
    if let (true, Some(run)) = (es_lanzamiento, run) {
        e.lanzados.push(WorkflowLanzado {
            tool_use_id: id.to_string(),
            task_id: r.get("taskId").and_then(Value::as_str).map(str::to_string),
            run_id: run.to_string(),
            lanzado_en: linea
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
}

/// Línea de usuario que abre un turno: ni resultado de herramienta, ni meta,
/// ni de un subagente.
fn es_prompt_nuevo(linea: &str) -> bool {
    linea.contains("\"type\":\"user\"")
        && !linea.contains("\"tool_result\"")
        && !linea.contains("\"isMeta\":true")
        && !linea.contains("\"isSidechain\":true")
}

/// `Nombre: detalle` con la descripción, la orden o la ruta de la llamada.
fn describir(nombre: &str, input: Option<&Value>) -> String {
    let detalle = input.and_then(|i| {
        ["description", "command", "file_path", "pattern", "prompt"]
            .iter()
            .find_map(|k| i.get(*k).and_then(Value::as_str))
    });
    match detalle.map(una_linea).filter(|d| !d.is_empty()) {
        Some(d) => format!("{nombre}: {d}"),
        None => nombre.to_string(),
    }
}

/// Texto en una línea, sin espacios repetidos.
pub fn una_linea(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Valores de `<tag>…</tag>` en la línea (texto JSON escapado incluido).
fn etiquetas<'a>(linea: &'a str, tag: &str) -> Vec<String> {
    let abre = format!("<{tag}>");
    let cierra = format!("</{tag}>");
    let mut out = Vec::new();
    let mut resto: &'a str = linea;
    while let Some(i) = resto.find(&abre) {
        let tras = &resto[i + abre.len()..];
        let Some(j) = tras.find(&cierra) else {
            break;
        };
        let valor = tras[..j].trim();
        if !valor.is_empty() && valor.len() <= 128 {
            out.push(valor.to_string());
        }
        resto = &tras[j + cierra.len()..];
    }
    out
}

/// Último prompt del usuario en el hilo principal.
fn ultimo_prompt(texto: &str) -> Option<String> {
    transcript::parse_all(texto, None)
        .into_iter()
        .rev()
        .filter(|m| m.agent_id.is_none() && m.role == "user" && m.kind == MessageKind::Prompt)
        .find_map(|m| {
            m.blocks.iter().find_map(|b| match b {
                Block::Text { text } if !text.trim().is_empty() => Some(text.clone()),
                _ => None,
            })
        })
}
