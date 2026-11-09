// sesiones/types_estado.rs — Tipos del contrato de estabilidad (§7.3) que
// pertenecen a WP-ESTADO: estado de la sesión, cola, comandos, ajustes y
// eventos. Se reexportan desde `types.rs`, así que la ruta pública sigue
// siendo `super::types::X`.
//
// Propiedad: WP-ESTADO.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{DialogOption, Usage};

/// Modo de permisos de Claude Code (`--permission-mode`, `permission_mode`
/// de los hooks clásicos, línea `permission-mode` del transcript).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
    Auto,
    DontAsk,
}

/// Última clasificación de la pantalla del PTY (`pantalla.rs`).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScreenState {
    #[default]
    Unknown,
    Prompt,
    Busy,
    Dialog,
    Trust,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WaitKind {
    Question,
    Permission,
    Plan,
    Menu,
    Trust,
}

/// Detalle de `status = waiting` (§1.1).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WaitInfo {
    pub kind: WaitKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask_id: Option<String>,
    pub label: String,
    pub since: String,
    /// Solo en `menu` y `trust`, leídas de la pantalla.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<DialogOption>>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StallReason {
    NoEvents,
    ToolOverdue,
    TuiFrozen,
    NoTurnStart,
    /// `starting` sin llegar al prompt en 30 s (pantalla sin reconocer y sin
    /// `hello` del puente): la salida es reiniciar.
    StartupTimeout,
}

/// Subcondición de `working` (§1.5) y, con `startupTimeout`, de `starting`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StallInfo {
    pub reason: StallReason,
    pub since: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    pub detail: String,
}

/// Por qué la cola de ULTRON no drena sola.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QueuePauseReason {
    /// Turno cerrado por plazo con puente, sin su `turnEnd`.
    Deadline,
    /// El usuario interrumpió o el turno quedó cortado al reabrir: la cola
    /// espera a «Enviar ahora» o a un prompt suyo.
    Interrupted,
    /// Límite de uso de Claude: la cola espera a la vuelta del cupo.
    UsageLimit,
}

/// Pausa de la cola visible en la línea de estado (`SessionInfo.queuePause`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueuePause {
    pub reason: QueuePauseReason,
    /// ISO 8601 del inicio de la pausa.
    pub since: String,
}

/// Clase de un `ChatMessage` (§5.1).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageKind {
    Prompt,
    Answer,
    Command,
    Bash,
    Interrupted,
    CompactSummary,
    TaskNotification,
    /// Metadatos y resultados de herramienta: nunca abren turno.
    Meta,
    #[allow(
        dead_code,
        reason = "clase genérica del cable (types.ts); el transcript usa las clases finas"
    )]
    System,
}

/// Salida de un comando local en el chat (`ChatMessage.command`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub name: String,
    pub args: String,
    /// Sin secuencias ANSI.
    pub stdout: String,
    pub is_error: bool,
}

/// Interacción de un comando en la TUI (§2.1 y cambio de diseño del
/// 2026-10-08: todos los slash commands desde el chat).
///
/// Clases vigentes: `prompt`, `local`, `menu`, `exit` y, solo con
/// imposibilidad real, `unsupported`. `panel` y `terminal` quedan por
/// compatibilidad del cable con la fase 0 y el catálogo ya no los produce.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CommandKind {
    Prompt,
    Local,
    /// Abre un menú, selector o diálogo de la TUI: se pinta como bloque de
    /// menú en el chat (`waiting{menu}`).
    Menu,
    /// Cierra la CLI (`/exit`): confirmación en la UI y `exited`.
    Exit,
    Panel,
    Terminal,
    Unsupported,
}

/// Panel nativo de Sessions que sustituye a un menú de la TUI (§2.4).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PanelId {
    Model,
    Effort,
    Config,
    Status,
    Usage,
    Context,
    Permissions,
    Hooks,
    Memory,
    Resume,
    Rename,
    Exit,
    Copy,
    AddDir,
    Help,
    Agentes,
    Git,
    Uso,
    Mcp,
    Plugins,
    Export,
    Autocompact,
    Advisor,
    Auth,
    Branch,
    Engines,
    Skills,
    Tasks,
}

/// Entrada de la lista viva `$.command.list()` del mod (evento `commands`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "fase 0a: lo lee WP-ESTADO (puente_eventos.rs)")]
pub struct CommandInfoLive {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// `builtin` | `plugin` | `user` | `mcp` (texto libre: se toleran
    /// valores nuevos).
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub immediate: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QueueState {
    Queued,
    Sending,
    CliQueued,
    Absorbed,
    Delivered,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QueueItemKind {
    Prompt,
    Command,
    Bash,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QueueOrigin {
    Ultron,
    Cli,
}

/// Elemento de la cola única de la sesión en el backend (§5.2).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub client_id: String,
    pub text: String,
    pub attachments: Vec<String>,
    pub delegate: bool,
    pub kind: QueueItemKind,
    pub origin: QueueOrigin,
    pub state: QueueState,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_uuid: Option<String>,
}

/// Alta en la cola (`sesiones_queue_enqueue`).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueItemInput {
    pub client_id: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub delegate: bool,
    pub kind: QueueItemKind,
}

/// Edición de un elemento (`sesiones_queue_update`).
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueItemPatch {
    pub text: Option<String>,
    pub attachments: Option<Vec<String>>,
    pub delegate: Option<bool>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SendMode {
    #[default]
    Auto,
    Now,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SendDisposition {
    Written,
    #[allow(dead_code, reason = "fase 0a: lo devuelve WP-ESTADO (cola.rs)")]
    Queued,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub client_id: String,
    pub disposition: SendDisposition,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CommandDisposition {
    Written,
    Queued,
    /// Escrito en el PTY y la TUI abrirá un menú: el chat inserta el bloque
    /// de menú en su posición cronológica.
    Menu,
    #[allow(dead_code, reason = "compatibilidad del cable con la fase 0")]
    Panel,
    #[allow(dead_code, reason = "compatibilidad del cable con la fase 0")]
    Terminal,
    Unsupported,
}

/// Respuesta de `sesiones_run_command` (§2.2).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    pub disposition: CommandDisposition,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panel: Option<PanelId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Resultado de una operación del buzón o de un ajuste (§2.5, §6.4).
/// `pending` con `opId`: el resultado final llega por `sesiones://op-result`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Valor de una fila de `/config` (`ConfigValue` de la API de mods).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ConfigValue {
    Bool(bool),
    Number(f64),
    Text(String),
    List(Vec<String>),
}

/// Payload de `sesiones://turn` al cerrar un turno principal (§7.2).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "fase 0a: lo emite WP-ESTADO (registro.rs)")]
pub struct TurnPayload {
    pub id: String,
    pub turn_id: String,
    pub started_at: String,
    pub ended_at: String,
    pub duration_ms: u64,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub subagent_usage: Vec<Usage>,
}

/// Preferencias de lanzamiento de sesiones nuevas (`sesiones_prefs_get/set`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPrefs {
    pub launch_permission_mode: PermissionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_effort: Option<String>,
    /// Umbral de `stalled.noEvents` en segundos (60-600).
    pub stall_seconds: u32,
    #[serde(default = "default_true")]
    pub automatic_relay: bool,
}

fn default_true() -> bool {
    true
}

impl Default for SessionPrefs {
    fn default() -> Self {
        Self {
            launch_permission_mode: PermissionMode::BypassPermissions,
            launch_model: None,
            launch_effort: None,
            stall_seconds: 120,
            automatic_relay: true,
        }
    }
}

/// Payload de `sesiones://stream` (§5.3, §7.2).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "fase 0a: lo emite WP-ESTADO (puente_eventos.rs)")]
pub struct StreamPayload {
    pub id: String,
    pub agent_id: Option<String>,
    pub turn_id: String,
    pub step: u32,
    pub block: u32,
    pub text: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub thinking: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub step_done: bool,
    pub done: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub aborted: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "fase 0a: lo emite WP-ESTADO (preguntas.rs)")]
pub enum AskOutcome {
    Answered,
    Cancelled,
}

/// Motivo de cancelación de un ask (§4.1).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "fase 0a: lo emite WP-ESTADO (preguntas.rs)")]
pub enum AskCancelReason {
    Interrupted,
    TurnEnded,
    SessionExited,
    ModAborted,
    Restart,
    Unknown,
}

/// Payload de `sesiones://ask-resolved` (§7.2).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "fase 0a: lo emite WP-ESTADO (preguntas.rs)")]
pub struct AskResolved {
    pub ask_id: String,
    pub id: String,
    pub outcome: AskOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<AskCancelReason>,
}
