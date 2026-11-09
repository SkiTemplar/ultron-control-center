// sesiones/types_forzar.rs — Tipos de «Interrumpir y enviar» y «Segundo
// plano» (CONTRATO-v3, §3.4): la herramienta en primer plano que se proyecta
// en `SessionInfo.foregroundTool` y los resultados de `sesiones_background` y
// `sesiones_interrupt_send`. Se reexportan desde `types.rs`, así que la ruta
// pública sigue siendo `super::types::X`.
//
// Propiedad: WP-PTY.

use serde::Serialize;

use super::QueueItem;

/// Herramienta del hilo principal en primer plano (la más reciente de las
/// abiertas según el puente).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundTool {
    pub tool_use_id: String,
    pub name: String,
    /// ISO del `start` de la herramienta.
    pub since: String,
    /// Ctrl+B la puede pasar a segundo plano (Bash, PowerShell, Agent, Task
    /// y herramientas MCP).
    pub backgroundable: bool,
}

/// Prueba de que la herramienta dejó el primer plano tras el Ctrl+B.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundEvidence {
    /// El puente cerró la herramienta (pasó a segundo plano o terminó justo
    /// entonces).
    ToolEnd,
    /// Sin cierre en el plazo.
    None,
}

/// Resultado de `sesiones_background`. Con `ok: false`, `reason` explica por
/// qué no se pudo confirmar.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundOutcome {
    pub ok: bool,
    pub tool_use_id: String,
    pub tool: String,
    pub evidence: BackgroundEvidence,
    pub steps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Resultado de `sesiones_interrupt_send`: si se interrumpió el turno, si el
/// mensaje salió ya y el elemento de la cola tal como quedó.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InterruptSendOutcome {
    pub interrupted: bool,
    pub sent: bool,
    pub steps: Vec<String>,
    pub item: QueueItem,
}
