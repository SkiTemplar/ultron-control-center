// sesiones/types.rs — Tipos compartidos con la ventana «ULTRON Sesiones».
//
// Réplica en Rust de los tipos de la sección 1 de
// docs/sesiones/CONTRATO.md, ampliada con los del contrato de estabilidad
// (§7.3, fase 0a). Todo se serializa en camelCase.
//
// Propiedad: WP-ESTADO. WP-PTY y WP-MOTORES solo editan dentro de su zona
// `// <WP-x>` … `// </WP-x>`. Los tipos de la fase 0a que aún no tienen
// consumidor llevan `allow(dead_code)` con el paquete que los cablea.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Nombres de los eventos emitidos a la ventana `sesiones`.
pub mod ev {
    // <WP-ESTADO> eventos nuevos del contrato de estabilidad (§7.2)
    #![allow(dead_code, reason = "fase 0a: los emite WP-ESTADO")]
    pub const QUEUE: &str = "sesiones://queue";
    pub const TURN: &str = "sesiones://turn";
    pub const STREAM_MATCHED: &str = "sesiones://stream-matched";
    pub const COMPOSER_FILL: &str = "sesiones://composer-fill";
    pub const RESET: &str = "sesiones://reset";
    pub const COMMANDS: &str = "sesiones://commands";
    pub const NOTICE: &str = "sesiones://notice";
    pub const OP_RESULT: &str = "sesiones://op-result";
    // </WP-ESTADO>

    pub const SESSIONS: &str = "sesiones://sessions";
    pub const MESSAGES: &str = "sesiones://messages";
    pub const STREAM: &str = "sesiones://stream";
    pub const TOOL: &str = "sesiones://tool";
    pub const AGENTS: &str = "sesiones://agents";
    /// Run de un `Workflow` que cambió (`{ id, run }`).
    pub const WORKFLOW: &str = "sesiones://workflow";
    pub const ASK: &str = "sesiones://ask";
    pub const ASK_RESOLVED: &str = "sesiones://ask-resolved";
    pub const STATUS: &str = "sesiones://status";
    pub const ENGINE: &str = "sesiones://engine";
    /// Lista entera de tareas de motores tras borrar (`motor::limpiar`).
    pub const ENGINE_LIST: &str = "sesiones://engine-list";
    pub const RELAY: &str = "sesiones://relay";
    pub const FOCUS_PROJECT: &str = "sesiones://focus-project";
    /// La mascota pide poner una sesión en el panel con foco (`{ sessionId }`).
    pub const FOCUS_SESSION: &str = "sesiones://focus-session";
    /// Sesión nueva de Claude en una carpeta (`{ cwd }`), desde
    /// `--sesiones-cwd` con la ventana ya abierta (`abrir_carpeta.rs`).
    pub const NEW_IN_CWD: &str = "sesiones://new-in-cwd";

    /// Evento de bytes del PTY de una sesión.
    pub fn pty(id: &str) -> String {
        format!("sesiones://pty/{id}")
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Starting,
    Idle,
    Working,
    Waiting,
    Exited,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub project_id: Option<String>,
    pub project_name: String,
    pub cwd: String,
    pub title: String,
    pub claude_session_id: Option<String>,
    pub status: SessionStatus,
    pub model: Option<String>,
    pub started_at: String,
    pub bridge_connected: bool,
    // -- contrato de estabilidad, §1.1 --
    /// Solo con `status = waiting`.
    pub waiting: Option<WaitInfo>,
    /// Solo con `status = working`: subcondición, no un sexto estado.
    pub stalled: Option<StallInfo>,
    pub working_since: Option<String>,
    pub last_activity_at: String,
    /// Turno principal abierto según el puente.
    pub turn_id: Option<String>,
    pub screen: ScreenState,
    /// Modo de permisos real (gana el cambio más reciente, §2.5).
    pub permission_mode: Option<PermissionMode>,
    /// Modo efectivo del último lanzamiento (también tras un reinicio).
    pub launch_permission_mode: PermissionMode,
    pub exit_code: Option<i32>,
    /// 0 sin hello; 1 mod antiguo; 2 este contrato.
    pub bridge_protocol: u8,
    /// Terminal del bloque de menú enganchada: la cola no drena (#31). Solo
    /// viaja cuando es `true`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub terminal_attached: bool,
    /// Cola de ULTRON retenida tras un cierre de turno por plazo: no drena
    /// hasta un `turnEnd` real, prompt estable 30 s o «Enviar ahora». Solo
    /// viaja cuando hay pausa.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_pause: Option<QueuePause>,
    /// Herramienta del hilo principal en primer plano (§3.4). Solo viaja
    /// con una herramienta abierta.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground_tool: Option<ForegroundTool>,
    /// Sesión de motor (`codex` | `gemini`, `motor_sesion.rs`); `None` en las
    /// de Claude. Solo viaja en las de motor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
}

impl SessionInfo {
    /// Sesión recién lanzada en `starting`, sin proyecto, conversación ni
    /// estado de la máquina; el llamador sobrescribe lo que sepa.
    pub fn nueva(id: &str, cwd: &str, launch_permission_mode: PermissionMode) -> Self {
        Self {
            id: id.to_string(),
            project_id: None,
            project_name: String::new(),
            cwd: cwd.to_string(),
            title: String::new(),
            claude_session_id: None,
            status: SessionStatus::Starting,
            model: None,
            started_at: now_iso(),
            bridge_connected: false,
            waiting: None,
            stalled: None,
            working_since: None,
            last_activity_at: now_iso(),
            turn_id: None,
            screen: ScreenState::Unknown,
            permission_mode: None,
            launch_permission_mode,
            exit_code: None,
            bridge_protocol: 0,
            terminal_attached: false,
            queue_pause: None,
            foreground_tool: None,
            engine: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSession {
    pub claude_session_id: String,
    pub cwd: String,
    pub project_name: String,
    pub preview: String,
    pub last_activity: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Block {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        media_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        data_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ToolUse {
        id: String,
        name: String,
        input: Value,
        summary: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        tool_use_id: String,
        is_error: bool,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<String>>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// `cache_creation.ephemeral_5m_input_tokens` (`USO-02`).
    pub cache_write_5m: u64,
    /// `cache_creation.ephemeral_1h_input_tokens` (`USO-02`).
    pub cache_write_1h: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    /// Modelo que gastó este uso; solo en el de un subagente (`subagentUsage`),
    /// cuando el puente lo manda. Sin él se valora con el modelo de la sesión.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub uuid: String,
    /// `user` | `assistant` | `system`.
    pub role: String,
    pub timestamp: String,
    pub blocks: Vec<Block>,
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    // -- contrato de estabilidad, §5.1 --
    pub kind: MessageKind,
    /// Absorbido a mitad de turno: no abre turno.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    #[serde(default)]
    pub queued: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<CommandOutput>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentNode {
    pub agent_id: String,
    pub parent_agent_id: Option<String>,
    #[serde(rename = "type")]
    pub agent_type: String,
    pub description: String,
    /// `running` | `done` | `error` | `stale`: `stale` es un transcript sin
    /// escrituras y sin fin de turno; puede seguir con una orden larga o haber
    /// muerto, así que no se pinta como terminado.
    pub status: String,
    pub started_at: String,
    pub turns: u32,
    pub tokens: u64,
    /// Tope de turnos (`maxTurns`) del frontmatter de
    /// `~/.claude/agents/<tipo>.md`; `None` si el agente no lo declara.
    pub max_turns: Option<u32>,
    /// Run de `Workflow` al que pertenece (`subagents/workflows/<runId>`).
    pub workflow_run: Option<String>,
    /// Última escritura del transcript, en ms desde la época.
    #[serde(skip)]
    pub last_write_ms: u64,
    /// Cuándo notificó el puente el fin del agente, en ms desde la época.
    #[serde(skip)]
    pub ended_at_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionDecision {
    Allow,
    AllowAlways,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AskAnswer {
    Permission {
        decision: PermissionDecision,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// `rejected: true` = el usuario rechaza responder (sin `answers`).
    Question {
        #[serde(default)]
        answers: std::collections::BTreeMap<String, String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        rejected: bool,
    },
    Plan(PlanAnswer),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlanDecision {
    Approve,
    KeepPlanning,
}

/// Respuesta a un plan (§4.5). Acepta también la forma del protocolo 1
/// (`{approve: bool}`) y serializa además `approve`, campo aditivo que lee el
/// mod mientras siga en el protocolo 1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "PlanAnswerWire", into = "PlanAnswerWire")]
pub struct PlanAnswer {
    pub decision: PlanDecision,
    pub mode: Option<PermissionMode>,
    pub feedback: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanAnswerWire {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    decision: Option<PlanDecision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approve: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    feedback: Option<String>,
}

impl TryFrom<PlanAnswerWire> for PlanAnswer {
    type Error = String;

    fn try_from(w: PlanAnswerWire) -> Result<Self, Self::Error> {
        let decision = match (w.decision, w.approve) {
            (Some(d), _) => d,
            (None, Some(true)) => PlanDecision::Approve,
            (None, Some(false)) => PlanDecision::KeepPlanning,
            (None, None) => return Err("respuesta de plan sin 'decision' ni 'approve'".into()),
        };
        Ok(Self {
            decision,
            mode: w.mode,
            feedback: w.feedback,
        })
    }
}

impl From<PlanAnswer> for PlanAnswerWire {
    fn from(p: PlanAnswer) -> Self {
        Self {
            decision: Some(p.decision),
            approve: Some(p.decision == PlanDecision::Approve),
            mode: p.mode,
            feedback: p.feedback,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexEvent {
    /// `message` | `command` | `patch` | `error`.
    pub kind: String,
    pub text: String,
}

/// Tarea de un motor externo (Codex o Gemini) lanzada desde una sesión
/// (contrato v0.2, E8). Sustituye a `CodexTask` de la v0.1.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineTask {
    pub id: String,
    /// `codex` | `gemini`.
    pub engine: String,
    /// `task` | `opinion`.
    pub kind: String,
    /// `local` | `cloud` (Gemini solo `local`).
    pub mode: String,
    pub cwd: String,
    /// Prompt escrito por el usuario (sin el paquete de contexto).
    pub prompt: String,
    /// `running` | `done` | `error` | `cancelled`.
    pub status: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub events: Vec<CodexEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud_task_id: Option<String>,
    /// Sesión desde la que se lanzó (para «Traer a Claude»).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Hilo del motor (`thread_id` de Codex, `conversation_id` de agy).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// Caracteres del paquete de contexto enviado (0 si no se incluyó).
    pub context_chars: usize,
    /// Modelo pedido al motor (`None` = el predeterminado de su CLI).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Momento en que el resultado se pegó en la sesión de Claude.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brought_at: Option<String>,
    // <WP-MOTORES>
    /// Último mensaje del hilo al lanzar la tarea (`registro::ultimo_uuid`):
    /// ancla del bloque del motor en la línea de tiempo (§5.6).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_message_uuid: Option<String>,
    // </WP-MOTORES>
    /// Tokens del turno (`turn.completed` de Codex); `None` si el motor no
    /// los da (agy no los imprime).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<EngineUsage>,
    /// Tribunal: las tareas lanzadas juntas (Codex y Gemini con el mismo
    /// encargo) comparten este id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

/// Tokens que consumió una tarea de un motor.
#[derive(Debug, Clone, Copy, Default, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineUsage {
    pub input_tokens: u64,
    #[serde(default)]
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Porcentaje consumido, 0-100.
    pub percent: f64,
    pub resets_at: Option<String>,
}

/// Uso del plan para la barra superior y el inspector (`sesiones_usage`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    pub subscription_type: Option<String>,
    /// true si la llamada en vivo falló y son cifras en caché.
    pub stale: bool,
    /// De dónde salen las cifras: la línea de estado local o el endpoint OAuth.
    pub source: UsageSource,
    /// Instante de la lectura (ms Unix): la muestra local o la respuesta.
    pub fetched_at_ms: u64,
    /// Motivo del último fallo del endpoint cuando `stale`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// Fuente del uso del plan (`PlanUsage::source`).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UsageSource {
    /// `logs/usage-history.jsonl`, que escribe `cockpit/statusline.js` con el
    /// `rate_limits` de Claude Code.
    Local,
    /// `api.anthropic.com/api/oauth/usage` (o su caché).
    Oauth,
}

/// Instante actual en ISO 8601 UTC con milisegundos.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------
// Contrato v0.2 (docs/sesiones/CONTRATO-v2.md, sección 1)
// ---------------------------------------------------------------------------

/// Ajustes que muestra la línea de estado y que no llegan por el puente.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettings {
    pub model: Option<String>,
    /// `low` | `medium` | `high` | `xhigh` | `max`.
    pub effort: Option<String>,
    /// `skip` si la sesión va con `--dangerously-skip-permissions`.
    pub permission_mode: Option<String>,
    /// `strict` | `light` | `off` | `uni`.
    pub socratic: Option<String>,
    pub project_id: Option<String>,
    /// Modo con el que se lanzó la sesión (contrato de estabilidad, §7.1).
    pub launch_permission_mode: Option<PermissionMode>,
}

/// Comando de la paleta `/`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandDef {
    /// Sin la barra: `compact`, `mejorar`.
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arg_hint: Option<String>,
    /// `builtin` | `mod` | `skill` | `user` | `project`.
    pub source: String,
    /// Nombre del mod o de la skill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    // -- contrato de estabilidad, §2.1 --
    pub kind: CommandKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panel: Option<PanelId>,
    pub needs_args: bool,
    pub immediate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
}

/// Bitácora del proyecto (`cockpit/projects/<id>/estado.json`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bitacora {
    pub resumen: String,
    pub pendientes: Vec<String>,
    pub decisiones: Vec<String>,
    pub gotchas: Vec<String>,
    pub updated_at: Option<String>,
}

/// Disponibilidad de un motor externo.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// `codex` | `gemini`.
    pub id: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Aviso sobre el motor aunque esté disponible (qué CLI de Gemini
    /// funciona).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

// ===========================================================================
// Contrato de estabilidad (docs/sesiones/CONTRATO-v3.md, §7.3)
// ===========================================================================

// <WP-ESTADO>
#[path = "types_estado.rs"]
mod estado;
pub use estado::*;
// </WP-ESTADO>

// <WP-PTY>
#[path = "types_forzar.rs"]
mod forzar;
pub use forzar::*;

/// Teclas que admite `sesiones_key` (§3.2): Esc y Ctrl+C solo salen por
/// `sesiones_recover`.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum KeyName {
    ShiftTab,
    Up,
    Down,
    Enter,
    Tab,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecoverAction {
    Interrupt,
    ExitMenu,
    Restart,
}

/// Opciones de `sesiones_recover` (solo con `restart`).
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoverOptions {
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoverOutcome {
    pub ok: bool,
    pub action: RecoverAction,
    pub steps: Vec<String>,
    pub status: SessionStatus,
}

/// Opción de un diálogo de la TUI leída de la pantalla (§4.6).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DialogOption {
    pub index: u32,
    pub label: String,
    pub selected: bool,
}

// </WP-PTY>

// <WP-MOTORES>
#[path = "types_workflow.rs"]
mod workflow;
pub use workflow::*;
// </WP-MOTORES>

#[cfg(test)]
#[path = "tests_types.rs"]
mod tests;
