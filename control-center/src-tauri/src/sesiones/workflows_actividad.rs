// sesiones/workflows_actividad.rs — Actividad de un agente de `Workflow` a
// partir de su transcript (`agent-<id>.jsonl`).
//
// Las líneas de un mismo `message.id` se repiten mientras el mensaje crece
// (`output_tokens` 8 → 7832): el uso se toma del último que llega, no del
// primero (ese es el error del contador de `AgentStats`).

use std::collections::HashSet;

use serde_json::Value;

use crate::sesiones::persistencia::turno::analisis::una_linea;

/// Longitud máxima de la línea de actividad.
const MAX_ACTIVIDAD: usize = 80;

#[derive(Debug, Default, Clone)]
pub struct Actividad {
    pub primero_ms: Option<u64>,
    pub ultimo_ms: Option<u64>,
    /// Contexto del último mensaje: entrada + caché leída + caché escrita + salida.
    pub contexto: Option<u64>,
    herramientas: HashSet<String>,
    pub ultima: Option<String>,
}

impl Actividad {
    pub fn llamadas(&self) -> u64 {
        self.herramientas.len() as u64
    }

    /// Incorpora una línea cruda del JSONL.
    pub fn feed(&mut self, v: &Value) {
        if let Some(ms) = v.get("timestamp").and_then(Value::as_str).and_then(iso_ms) {
            self.primero_ms.get_or_insert(ms);
            self.ultimo_ms = Some(ms);
        }
        if v.get("type").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        let Some(msg) = v.get("message") else { return };
        if let Some(u) = msg.get("usage") {
            let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
            self.contexto = Some(
                n("input_tokens")
                    + n("cache_read_input_tokens")
                    + n("cache_creation_input_tokens")
                    + n("output_tokens"),
            );
        }
        for b in msg
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            self.bloque(b);
        }
    }

    fn bloque(&mut self, b: &Value) {
        match b.get("type").and_then(Value::as_str) {
            Some("tool_use") => {
                let id = b.get("id").and_then(Value::as_str).unwrap_or_default();
                if !id.is_empty() {
                    self.herramientas.insert(id.to_string());
                }
                let nombre = b
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("herramienta");
                self.ultima = Some(recortar(&describir(nombre, b.get("input")), MAX_ACTIVIDAD));
            }
            Some("text") => {
                let t = b.get("text").and_then(Value::as_str).unwrap_or_default();
                let linea = t.lines().map(str::trim).find(|l| !l.is_empty());
                if let Some(l) = linea {
                    self.ultima = Some(recortar(l, MAX_ACTIVIDAD));
                }
            }
            _ => {}
        }
    }
}

/// `Nombre: detalle` con el primer campo descriptivo de la entrada.
fn describir(nombre: &str, input: Option<&Value>) -> String {
    let detalle = input.and_then(|i| {
        [
            "description",
            "command",
            "file_path",
            "pattern",
            "prompt",
            "label",
        ]
        .iter()
        .find_map(|k| {
            i.get(*k)
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
        })
    });
    match detalle.map(una_linea).filter(|d| !d.is_empty()) {
        Some(d) => format!("{nombre}: {d}"),
        None => nombre.to_string(),
    }
}

/// Recorta a `max` caracteres (no bytes) con elipsis.
pub fn recortar(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// ISO 8601 → milisegundos desde la época.
pub fn iso_ms(iso: &str) -> Option<u64> {
    let d = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    u64::try_from(d.timestamp_millis()).ok()
}
