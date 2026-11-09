// sesiones/workflows.rs — Tarjeta en vivo de los `Workflow` de Claude Code.
//
// Fuentes (formato interno de Claude Code, sin documentar: todo opcional y
// los tipos desconocidos se ignoran):
// - `<sid>/subagents/workflows/<runId>/journal.jsonl`: `launched`,
//   `started` {key, agentId, label, phase}, `result` {key, agentId, result} y
//   `failed` {key, agentId}. Sin marcas de tiempo; un reintento repite
//   `started` con la misma key y otro agentId; `failed` no trae motivo y no
//   hay evento de fin de run.
// - `agent-<id>.meta.json` (tipo, modelo) y `agent-<id>.jsonl` (tiempos,
//   tokens y última actividad: `workflows_actividad.rs`).
// - `<sid>/workflows/scripts/<nombre>-<runId>.js`: `export const meta`.
// - `<sid>/workflows/<runId>.json`: solo al terminar (estado, error,
//   duración, totales). Cuenta si no es más viejo que el journal: un
//   `resumeFromRunId` reutiliza el runId y deja el JSON del run anterior.
//
// Este módulo es puro (journal → `WorkflowRun`); el disco lo recorre
// `workflows_seguidor.rs`.

use std::collections::HashMap;

use serde_json::Value;

use super::types::{WfAgentStatus, WorkflowAgent, WorkflowPhase, WorkflowRun, WorkflowStatus};

#[path = "workflows_actividad.rs"]
pub mod actividad;
#[path = "workflows_meta.rs"]
pub mod meta;
#[path = "workflows_seguidor.rs"]
pub mod seguidor;

use actividad::{recortar, Actividad};
use meta::MetaScript;

/// Longitud máxima de un resultado en la tarjeta.
const MAX_RESULTADO: usize = 600;
/// Fase de los agentes que no declaran ninguna.
const SIN_FASE: &str = "Sin fase";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EstadoJournal {
    Abierto,
    Hecho,
    Fallido,
}

/// Último intento de una clave del journal.
#[derive(Debug, Clone)]
pub struct Intento {
    pub key: String,
    pub agent_id: String,
    pub label: String,
    pub phase: String,
    pub attempt: u32,
    estado: EstadoJournal,
    resultado: Option<String>,
}

/// Estado acumulado del journal de un run.
#[derive(Debug, Default, Clone)]
pub struct Journal {
    pub intentos: Vec<Intento>,
}

fn texto(v: &Value, k: &str) -> String {
    v.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Resultado recortado: la cadena tal cual o el JSON compacto.
pub fn vista_resultado(v: &Value) -> Option<String> {
    let s = match v {
        Value::Null => return None,
        Value::String(s) => s.clone(),
        otro => otro.to_string(),
    };
    let s = s.trim();
    (!s.is_empty() && s != "null").then(|| recortar(s, MAX_RESULTADO))
}

impl Journal {
    /// Aplica una línea; ignora tipos desconocidos, líneas sin key o
    /// agentId y cierres de claves (o intentos) que no se han visto.
    pub fn aplicar(&mut self, v: &Value) {
        let (key, agent_id) = (texto(v, "key"), texto(v, "agentId"));
        if key.is_empty() || agent_id.is_empty() {
            return;
        }
        match v.get("type").and_then(Value::as_str) {
            Some("started") => self.empezar(v, key, agent_id),
            Some("result") => {
                if let Some(i) = self.intento(&key, &agent_id) {
                    i.estado = EstadoJournal::Hecho;
                    i.resultado = v.get("result").and_then(vista_resultado);
                }
            }
            Some("failed") => {
                if let Some(i) = self.intento(&key, &agent_id) {
                    i.estado = EstadoJournal::Fallido;
                }
            }
            _ => {}
        }
    }

    fn intento(&mut self, key: &str, agent_id: &str) -> Option<&mut Intento> {
        self.intentos
            .iter_mut()
            .find(|i| i.key == key && i.agent_id == agent_id)
    }

    fn empezar(&mut self, v: &Value, key: String, agent_id: String) {
        let (label, phase) = (texto(v, "label"), texto(v, "phase"));
        if let Some(i) = self.intentos.iter_mut().find(|i| i.key == key) {
            if i.agent_id != agent_id {
                i.agent_id = agent_id;
                i.attempt += 1;
                i.estado = EstadoJournal::Abierto;
                i.resultado = None;
            }
            if !label.is_empty() {
                i.label = label;
            }
            return;
        }
        self.intentos.push(Intento {
            key,
            agent_id,
            label,
            phase,
            attempt: 1,
            estado: EstadoJournal::Abierto,
            resultado: None,
        });
    }
}

/// Datos de `agent-<id>.meta.json` que usa la tarjeta.
#[derive(Debug, Clone, Default)]
pub struct MetaAgente {
    pub agent_type: Option<String>,
    pub model: Option<String>,
}

/// Todo lo que se sabe de un run en un instante.
pub struct Fuentes<'a> {
    pub run_id: &'a str,
    pub journal: &'a Journal,
    pub meta: Option<&'a MetaScript>,
    /// JSON final vigente (ver `final_vigente`).
    pub final_json: Option<&'a Value>,
    pub actividad: &'a HashMap<String, Actividad>,
    pub metas: &'a HashMap<String, MetaAgente>,
    /// Creación del journal (lanzamiento del run).
    pub inicio_ms: Option<u64>,
    /// La sesión aún tiene proceso de Claude.
    pub sesion_viva: bool,
}

/// El JSON final cuenta si no es más viejo que el journal (2 s de margen).
pub fn final_vigente(json_ms: u64, journal_ms: u64) -> bool {
    json_ms + 2_000 >= journal_ms
}

fn estado_run(f: &Fuentes) -> WorkflowStatus {
    match f
        .final_json
        .and_then(|j| j.get("status"))
        .and_then(Value::as_str)
    {
        Some("completed") => WorkflowStatus::Completed,
        Some("failed") => WorkflowStatus::Failed,
        Some("killed") => WorkflowStatus::Killed,
        Some(_) => WorkflowStatus::Stopped,
        None if f.sesion_viva => WorkflowStatus::Running,
        None => WorkflowStatus::Stopped,
    }
}

/// Elementos `workflow_agent` del JSON final por agentId.
fn progreso_final(f: &Fuentes) -> HashMap<String, Value> {
    f.final_json
        .and_then(|j| j.get("workflowProgress"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("workflow_agent"))
        .filter_map(|p| Some((p.get("agentId")?.as_str()?.to_string(), p.clone())))
        .collect()
}

fn estado_agente(i: &Intento, fin: Option<&Value>, run: WorkflowStatus) -> WfAgentStatus {
    if fin.and_then(|p| p.get("cached")).and_then(Value::as_bool) == Some(true) {
        return WfAgentStatus::Cached;
    }
    match i.estado {
        EstadoJournal::Hecho => WfAgentStatus::Done,
        EstadoJournal::Fallido => WfAgentStatus::Failed,
        EstadoJournal::Abierto if run == WorkflowStatus::Running => WfAgentStatus::Running,
        EstadoJournal::Abierto => match fin.and_then(|p| p.get("state")).and_then(Value::as_str) {
            Some("done") if run == WorkflowStatus::Completed => WfAgentStatus::Done,
            _ => WfAgentStatus::Stopped,
        },
    }
}

/// `s` o, si está vacío, `otro`.
fn o_si_vacio(s: &str, otro: &str) -> String {
    if s.is_empty() { otro } else { s }.to_string()
}

fn agente(i: &Intento, f: &Fuentes, fin: Option<&Value>, run: WorkflowStatus) -> WorkflowAgent {
    let act = f.actividad.get(&i.agent_id);
    let meta = f.metas.get(&i.agent_id);
    let num = |k: &str| fin.and_then(|p| p.get(k)).and_then(Value::as_u64);
    let started_at = act.and_then(|a| a.primero_ms).or_else(|| num("startedAt"));
    let last_at = act
        .and_then(|a| a.ultimo_ms)
        .or_else(|| num("lastProgressAt"));
    let status = estado_agente(i, fin, run);
    let duracion = match status {
        WfAgentStatus::Running => None,
        _ => num("durationMs").or_else(|| Some(last_at?.saturating_sub(started_at?))),
    };
    let ultima_final = fin
        .and_then(|p| p.get("lastToolName"))
        .and_then(Value::as_str)
        .map(str::to_string);
    WorkflowAgent {
        key: i.key.clone(),
        agent_id: i.agent_id.clone(),
        label: o_si_vacio(&i.label, &i.agent_id),
        phase: o_si_vacio(&i.phase, SIN_FASE),
        status,
        attempt: i.attempt.max(num("attempt").unwrap_or(0) as u32),
        agent_type: meta.and_then(|m| m.agent_type.clone()),
        model: meta.and_then(|m| m.model.clone()),
        started_at,
        last_at,
        duration_ms: duracion,
        context_tokens: act.and_then(|a| a.contexto).or_else(|| num("tokens")),
        tool_calls: act
            .map(Actividad::llamadas)
            .filter(|n| *n > 0)
            .or_else(|| num("toolCalls")),
        last_activity: act.and_then(|a| a.ultima.clone()).or(ultima_final),
        result_preview: i.resultado.clone().or_else(|| {
            fin.and_then(|p| p.get("resultPreview"))
                .and_then(vista_resultado)
        }),
    }
}

/// Fases en el orden del meta; las del journal que no estén, al final.
pub fn progreso_fases(
    declaradas: &[(String, Option<String>)],
    agentes: &[WorkflowAgent],
) -> Vec<WorkflowPhase> {
    let mut fases: Vec<(String, Option<String>)> = declaradas.to_vec();
    for a in agentes {
        if !fases.iter().any(|(t, _)| *t == a.phase) {
            fases.push((a.phase.clone(), None));
        }
    }
    fases
        .into_iter()
        .enumerate()
        .map(|(n, (title, detail))| {
            let de = |s: WfAgentStatus| {
                agentes
                    .iter()
                    .filter(|a| a.phase == title && a.status == s)
                    .count() as u32
            };
            WorkflowPhase {
                index: n as u32 + 1,
                total: agentes.iter().filter(|a| a.phase == title).count() as u32,
                done: de(WfAgentStatus::Done) + de(WfAgentStatus::Cached),
                failed: de(WfAgentStatus::Failed),
                running: de(WfAgentStatus::Running),
                title,
                detail,
            }
        })
        .collect()
}

/// Fases declaradas: las del script o, sin él, las del JSON final.
fn fases_declaradas(f: &Fuentes) -> Vec<(String, Option<String>)> {
    if let Some(m) = f.meta.filter(|m| !m.phases.is_empty()) {
        return m.phases.clone();
    }
    f.final_json
        .and_then(|j| j.get("phases"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let t = p.get("title")?.as_str()?.to_string();
            Some((
                t,
                p.get("detail").and_then(Value::as_str).map(str::to_string),
            ))
        })
        .collect()
}

/// Compone el run a partir de sus fuentes.
pub fn componer(f: &Fuentes) -> WorkflowRun {
    let status = estado_run(f);
    let fin = progreso_final(f);
    let agents: Vec<WorkflowAgent> = f
        .journal
        .intentos
        .iter()
        .map(|i| agente(i, f, fin.get(&i.agent_id), status))
        .collect();
    let j = f.final_json;
    let num = |k: &str| j.and_then(|j| j.get(k)).and_then(Value::as_u64);
    let txt = |k: &str| {
        j.and_then(|j| j.get(k))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let started_at = num("startTime")
        .or(f.inicio_ms)
        .or_else(|| agents.iter().filter_map(|a| a.started_at).min());
    let duration_ms = num("durationMs");
    WorkflowRun {
        run_id: f.run_id.to_string(),
        name: f
            .meta
            .and_then(|m| m.name.clone())
            .or_else(|| txt("workflowName").map(str::to_string))
            .unwrap_or_else(|| f.run_id.to_string()),
        description: f
            .meta
            .and_then(|m| m.description.clone())
            .or_else(|| txt("summary").map(str::to_string))
            .unwrap_or_default(),
        status,
        started_at,
        ended_at: num("startTime").zip(duration_ms).map(|(a, d)| a + d),
        duration_ms,
        phases: progreso_fases(&fases_declaradas(f), &agents),
        agents,
        total_tokens: num("totalTokens"),
        total_tool_calls: num("totalToolCalls"),
        result_preview: j.and_then(|j| j.get("result")).and_then(vista_resultado),
        error: txt("error")
            .and_then(|e| e.lines().next())
            .map(|l| recortar(l.trim(), 300)),
    }
}

#[cfg(test)]
#[path = "tests_workflows.rs"]
mod tests;
