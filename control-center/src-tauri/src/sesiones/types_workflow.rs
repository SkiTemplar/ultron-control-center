// sesiones/types_workflow.rs — Tipos de la tarjeta en vivo de los `Workflow`
// de Claude Code (evento `sesiones://workflow` y comando `sesiones_workflows`).
//
// Las marcas de tiempo van en milisegundos desde la época UNIX: el journal
// no las trae y salen de los transcripts de agente, de las fechas de los
// ficheros o del JSON final del run.

use serde::Serialize;

/// Estado de un run completo.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowStatus {
    Running,
    Completed,
    Failed,
    Killed,
    /// Sin JSON final y sin proceso de Claude: el run no terminó por su pie.
    Stopped,
}

/// Estado de un agente (el último intento de su clave).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WfAgentStatus {
    Running,
    Done,
    Failed,
    /// Resultado reutilizado de un run anterior (`resumeFromRunId`).
    Cached,
    /// El run acabó (o se perdió el proceso) con el agente aún abierto.
    Stopped,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPhase {
    pub index: u32,
    pub title: String,
    pub detail: Option<String>,
    /// Agentes vistos hasta ahora en la fase (no se sabe cuántos faltan).
    pub total: u32,
    pub done: u32,
    pub failed: u32,
    pub running: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAgent {
    /// Clave del journal (`v2:<sha256>`): la comparten los reintentos.
    pub key: String,
    /// Agente del último intento.
    pub agent_id: String,
    pub label: String,
    pub phase: String,
    pub status: WfAgentStatus,
    /// 1 en el primer intento; sube con cada `started` repetido.
    pub attempt: u32,
    pub agent_type: Option<String>,
    pub model: Option<String>,
    pub started_at: Option<u64>,
    pub last_at: Option<u64>,
    pub duration_ms: Option<u64>,
    /// Contexto del último mensaje (entrada + caché + salida).
    pub context_tokens: Option<u64>,
    pub tool_calls: Option<u64>,
    /// `Herramienta: detalle` de la última llamada, o la primera línea del último texto.
    pub last_activity: Option<String>,
    pub result_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub run_id: String,
    pub name: String,
    pub description: String,
    pub status: WorkflowStatus,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
    pub duration_ms: Option<u64>,
    pub phases: Vec<WorkflowPhase>,
    pub agents: Vec<WorkflowAgent>,
    pub total_tokens: Option<u64>,
    pub total_tool_calls: Option<u64>,
    pub result_preview: Option<String>,
    /// Primera línea del error del run (la pila no se envía).
    pub error: Option<String>,
}
