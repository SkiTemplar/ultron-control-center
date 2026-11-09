// Tipos de la ventana «ULTRON Sessions». Réplica del contrato
// (docs/sesiones/CONTRATO.md v0.1, CONTRATO-v2.md v0.2 y el contrato de
// estabilidad v3 de 2026-10-08, §7.3). Si el contrato cambia, este fichero
// cambia con él.

import type { AgentNode } from "./agent-node";
import type { WorkflowEvent } from "./workflows";

export type SessionId = string;

/** Proyecto registrado en ULTRON donde se puede abrir una sesión. */
export interface ProjectRef {
  id: string;
  name: string;
  path: string;
  /** Último uso (ISO) en `projects.json`; ordena los recientes de «+ Claude». */
  lastActive?: string;
}
export type Engine = "claude" | EngineId;
export type EngineId = "codex" | "gemini" | "opencode";
export type SessionStatus = "starting" | "idle" | "working" | "waiting" | "exited";

export interface SessionInfo {
  id: SessionId;
  projectId: string | null;
  projectName: string;
  cwd: string;
  title: string;
  claudeSessionId: string | null;
  status: SessionStatus;
  model: string | null;
  startedAt: string;
  bridgeConnected: boolean;
  // --- v3 (§1.1) ---
  /** Solo con `status=waiting`. */
  waiting: WaitInfo | null;
  /** Subcondición de `working` (y de `starting` con `startupTimeout`), no un sexto estado. */
  stalled: StallInfo | null;
  /** ISO; se conserva en waiting y stalled, se borra en idle y exited. */
  workingSince: string | null;
  /** ISO del último evento del puente, línea del transcript o progreso de pantalla. */
  lastActivityAt: string;
  /** Turno principal abierto según el puente. */
  turnId: string | null;
  screen: ScreenState;
  /** Modo real (§2.4); null hasta la primera lectura. */
  permissionMode: PermissionMode | null;
  /** Modo efectivo del último lanzamiento (también tras un reinicio con otro modo). */
  launchPermissionMode: PermissionMode;
  exitCode: number | null;
  /** 0 sin hello; 1 mod antiguo; 2 contrato v3. */
  bridgeProtocol: 0 | 1 | 2;
  /** La terminal del bloque de menú sigue enganchada al PTY: la cola no drena. */
  terminalAttached?: boolean;
  /** Por qué la cola no drena sola (solo viaja con pausa; `pausa_visible` en maquina.rs). */
  queuePause?: QueuePause | null;
  /** Herramienta del hilo principal en primer plano (§3.4); solo viaja con una abierta. */
  foregroundTool?: ForegroundTool | null;
  /** Sesión de motor (Codex, Gemini u OpenCode) sin Claude; ausente en las de Claude. */
  engine?: EngineId;
}

/** Herramienta en primer plano según el puente (la más reciente de las abiertas). */
export interface ForegroundTool {
  toolUseId: string;
  name: string;
  /** ISO del `start`. */
  since: string;
  /** Ctrl+B la puede pasar a segundo plano (Bash, PowerShell, Agent, Task, MCP). */
  backgroundable: boolean;
}

/**
 * Motivo de la pausa de la cola: `deadline` = turno cerrado por plazo sin el `turnEnd` del
 * puente; `interrupted` = turno interrumpido o cortado al reabrir; `usageLimit` = límite de
 * uso de Claude, hasta que vuelva el cupo.
 */
export type QueuePauseReason = "deadline" | "interrupted" | "usageLimit";

export interface QueuePause {
  reason: QueuePauseReason;
  /** ISO del inicio de la pausa. */
  since: string;
}

export interface PastSession {
  claudeSessionId: string;
  cwd: string;
  projectName: string;
  preview: string;
  lastActivity: string;
}

export type { EngineSessionPast } from "./engine-session";

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "image"; mediaType: string; dataUrl?: string; path?: string }
  | { kind: "toolUse"; id: string; name: string; input: unknown; summary: string }
  | { kind: "toolResult"; toolUseId: string; isError: boolean; text: string; images?: string[] };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // --- v3 (USO-02) ---
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** Velocidad del modelo según el transcript (`speed`), p. ej. el modo rápido. */
  speed?: string;
  /** Solo en `subagentUsage`: modelo del subagente, si el puente lo manda. */
  model?: string;
}

export interface ChatMessage {
  uuid: string;
  role: "user" | "assistant" | "system";
  timestamp: string;
  blocks: Block[];
  agentId: string | null;
  model?: string;
  usage?: Usage;
  // --- v3 (§5.1) ---
  /** Clasificación del transcript; ausente en mensajes sintéticos del cliente. */
  kind?: MessageKind;
  /** Absorbido a mitad de turno: no abre turno. */
  queued?: true;
  /** Identidad del envío emparejado por la cola del backend. */
  clientId?: string;
  /** `turnId:agentId|main:step:block`; retira la burbuja en vivo por identidad. */
  streamKey?: string;
  /** Tarjeta de comando con la salida sin ANSI. */
  command?: { name: string; args: string; stdout: string; isError: boolean };
}

/** Página del historial (`sesiones_history`, §7): `hasMore` = quedan mensajes antes. */
export interface HistoryPage {
  messages: ChatMessage[];
  hasMore: boolean;
}

export type { AgentNode } from "./agent-node";

/** §4.5. El backend sigue aceptando `{kind:"plan", approve}` del protocolo 1. */
export type AskAnswer =
  | { kind: "permission"; decision: "allow" | "allowAlways" | "deny"; reason?: string }
  | { kind: "question"; answers: Record<string, string>; rejected?: false }
  | { kind: "question"; rejected: true }
  | { kind: "plan"; decision: "approve" | "keepPlanning"; mode?: PermissionMode; feedback?: string };

export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/** Dónde guarda Claude Code una regla de permiso (`PermissionUpdateDestination`). */
export type PermissionRuleDestination = "session" | "localSettings" | "projectSettings" | "userSettings";

/**
 * Regla que se guardará si se elige «Permitir siempre». La anuncia el backend
 * al abrir el ask (`sesiones/permiso_siempre.rs`): con destino `localSettings`
 * la añade él a `permissions.allow` de `<cwd>/.claude/settings.local.json`
 * antes de contestar, y si no puede, `sesiones_answer` falla con el motivo y
 * la petición sigue abierta. `session` y `userSettings` (solo si el puente
 * trajera su propio `always`) no los aplica hoy nadie: `sesiones_answer` falla
 * con el motivo. Sin este campo no hay regla concreta y la tarjeta no ofrece
 * «Permitir siempre».
 */
export interface PermissionAlways {
  rules: string[];
  destination: PermissionRuleDestination;
}

export type Ask =
  | {
      askId: string;
      id: SessionId;
      kind: "permission";
      tool: string;
      input: unknown;
      summary: string;
      reason?: string;
      agentId: string | null;
      always?: PermissionAlways;
    }
  | { askId: string; id: SessionId; kind: "question"; questions: AskQuestion[] }
  | { askId: string; id: SessionId; kind: "plan"; plan: string };

/** Payload de `sesiones://ask` (v3). */
export type AskEvent = Ask & { createdAt: string };

export type AskCancelReason = "interrupted" | "turnEnded" | "sessionExited" | "modAborted" | "restart" | "unknown";

export interface AskResolvedPayload {
  askId: string;
  id: SessionId;
  outcome: "answered" | "cancelled";
  reason?: AskCancelReason;
}

export type CodexMode = "local" | "cloud";

export interface EngineEvent {
  /** `warning`: aviso del motor que no corta el turno (p. ej. Codex recortando descripciones). */
  kind: "message" | "command" | "patch" | "error" | "warning";
  text: string;
}

/** `review`: segunda opinión automática de Codex sobre un turno que editó muchos ficheros. */
/** `chat`: turno de una sesión de motor (`sesiones_engine_session_send`); no es una intervención. */
export type EngineTaskKind = "task" | "opinion" | "review" | "relay" | "chat";

export interface RelayState {
  sessionId: SessionId;
  activeEngine: "opencode" | "codex" | "gemini";
  since: string;
  /** Vuelta automática a Claude; sin ella, la vuelta es manual. */
  returnAt?: string;
  /** Ventana agotada: la de 5 h o la semanal. */
  limitKind?: "session" | "weekly";
  taskIds: string[];
  failedPrompt: string;
  error?: string;
}

/** Tokens que consumió una tarea (`turn.completed` de Codex; agy no los da). */
export interface EngineUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** v0.2: generaliza `CodexTask` de v0.1 a cualquier motor consultor. */
export interface EngineTask {
  id: string;
  engine: EngineId;
  kind: EngineTaskKind;
  mode: CodexMode;
  cwd: string;
  prompt: string;
  status: "running" | "done" | "error" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  events: EngineEvent[];
  summary?: string;
  cloudTaskId?: string;
  sessionId?: SessionId;
  /** Hilo de Codex o `conversation_id` de agy (backend v0.2). */
  threadId?: string;
  /** Caracteres del paquete de contexto enviado (0 sin paquete). */
  contextChars?: number;
  /** Modelo pedido al motor (ausente = el predeterminado de su CLI). */
  model?: string;
  /** Hora en que el resultado se pegó en Claude; el botón deja de ofrecerse. */
  broughtAt?: string;
  // <WP-MOTORES>
  /** Último mensaje del hilo al lanzar (§5.6): ancla del bloque en la línea de tiempo. */
  anchorMessageUuid?: string;
  // </WP-MOTORES>
  /** Tokens del turno, si el motor los da. */
  usage?: EngineUsage;
  /** Tribunal: las tareas lanzadas juntas comparten este id. */
  group?: string;
}

/** §3.2: Esc y Ctrl+C solo salen por `recover`; la terminal escribe con `terminalInput`. */
export type KeyName = "shiftTab" | "up" | "down" | "enter" | "tab";

// ---------------------------------------------------------------------------
// Payloads de eventos
// ---------------------------------------------------------------------------

export interface StreamPayload {
  id: SessionId;
  agentId: string | null;
  turnId: string;
  /** v3: cada (step, block) es una entrada distinta (§5.3). */
  step: number;
  block: number;
  /** Delta del bloque: respuesta o, con `thinking`, razonamiento. */
  text: string;
  /** Bandera del backend (`StreamPayload.thinking: bool`): el delta de `text` es razonamiento. */
  thinking?: boolean;
  stepDone?: boolean;
  done: boolean;
  aborted?: boolean;
}

export interface ToolPayload {
  id: SessionId;
  agentId: string | null;
  toolUseId: string;
  name: string;
  summary: string;
  phase: "start" | "end";
  isError?: boolean;
}

export interface StatusPayload {
  id: SessionId;
  model: string;
  contextTokens: number;
  contextWindow: number;
  costUsd?: number;
  /** v3: modo de permisos real. */
  mode?: PermissionMode;
}

export interface SesionesEvents {
  "sesiones://sessions": SessionInfo[];
  "sesiones://messages": { id: SessionId; messages: ChatMessage[] };
  "sesiones://stream": StreamPayload;
  "sesiones://tool": ToolPayload;
  "sesiones://agents": { id: SessionId; agents: AgentNode[] };
  /** Run de `Workflow` que cambió (tarjeta del chat). */
  "sesiones://workflow": WorkflowEvent;
  "sesiones://ask": AskEvent;
  "sesiones://ask-resolved": AskResolvedPayload;
  "sesiones://status": StatusPayload;
  "sesiones://engine": EngineTask;
  /** Lista entera tras «Limpiar» en cualquier ventana. */
  "sesiones://engine-list": EngineTask[];
  "sesiones://relay": { id: SessionId; relay: RelayState | null };
  "sesiones://focus-project": { projectId: string };
  /** La mascota pide esta sesión en el panel con foco (clic en Pupus con un aviso). */
  "sesiones://focus-session": { sessionId: SessionId };
  /** Sesión nueva de Claude en esta carpeta (`--sesiones-cwd` con la ventana abierta). */
  "sesiones://new-in-cwd": { cwd: string };
  // --- v3 (§7.2) ---
  "sesiones://queue": { id: SessionId; items: QueueItem[] };
  "sesiones://turn": TurnPayload;
  "sesiones://stream-matched": { id: SessionId; streamKey: string; messageUuid: string };
  "sesiones://composer-fill": { id: SessionId; text: string; mode: ComposerFillMode; from: string };
  "sesiones://reset": { id: SessionId; claudeSessionId: string };
  "sesiones://commands": { id: SessionId; items: CommandDef[] };
  "sesiones://notice": { id: SessionId; level: NoticeLevel; text: string };
  /** Prompt de continuación de una sesión cortada a mitad de turno: va a la caja, nunca se envía. */
  "sesiones://continuation": { id: SessionId; text: string };
  "sesiones://op-result": { id: SessionId; opId: string; ok: boolean; value?: unknown; error?: string };
}

export type SesionesEventName = keyof SesionesEvents;

// ---------------------------------------------------------------------------
// Comandos reutilizados del Control Center (git_ops.rs, sin rename_all)
// ---------------------------------------------------------------------------

export interface GitRepoState {
  is_repo: boolean;
  branch: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  dirty_count: number;
  path: string;
}

export interface GitFileChange {
  path: string;
  index_status: string;
  worktree_status: string;
  staged: boolean;
  untracked: boolean;
}

export interface GitRepoSnapshot {
  state: GitRepoState;
  changes: GitFileChange[];
}

export interface GitCommitInfo {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

/** Uso del plan normalizado (el backend puede devolver la forma de plan_limits.rs). */
export interface PlanWindowUsage {
  percent: number;
  resetsAt: string | null;
}

/** Ventana del plan según el puente del mod ultron-uso (`sesiones_usage_pace`). */
export interface UsoWindow {
  kind: string;
  used: number;
  /** % del tiempo de la ventana vivido según el horario (semanal) o lineal. */
  elapsedPct: number;
  linearElapsedPct: number;
  /** Ritmo: 100 = llegar al reset justo en el límite. */
  projectedPct: number | null;
  isScheduled: boolean;
  isAlert: boolean;
  resetsAtMs: number;
  /** Hora estimada de llegar al 100 % al ritmo actual; null si no llega. */
  runsOutLabel: string | null;
}

export interface UsoPace {
  windows: UsoWindow[];
  /** Cuánto vale la semana en % de una ventana de 5 h (null sin histórico). */
  weekInFiveHourPct: number | null;
}

/** Ventana de la suscripción de otro motor (`sesiones_engines_usage`). */
export interface EnginePlanWindow {
  /** `five_hour`, `seven_day` u otra (`w<min>m`). */
  kind: string;
  /** Grupo de modelos con cuota propia (agy); null en Codex. */
  group: string | null;
  /** null si la ventana se reinició después de la lectura: uso desconocido. */
  usedPct: number | null;
  resetsAtMs: number | null;
  expired: boolean;
}

export interface EnginePlanActivity {
  turns: number;
  tokens: number;
}

/** Uso de un motor: cuota real (`windows`) o, sin ella, actividad sin límite conocido. */
export interface EnginePlanUsage {
  id: string;
  label: string;
  /** `none`: no hay dato (motor no instalado o sin lecturas); `error`: falló la lectura. */
  status: "ok" | "none" | "error";
  /** `rollout` (Codex), `agy-usage` (`agy -p /usage`) o `activity` (transcripts de agy). */
  source: "rollout" | "agy-usage" | "activity" | null;
  /** Instante de la lectura en ms Unix. */
  readAtMs: number | null;
  plan: string | null;
  windows: EnginePlanWindow[];
  activity: { fiveHour: EnginePlanActivity; sevenDay: EnginePlanActivity } | null;
  note: string | null;
}

/** Saldo de DeepSeek (GET /user/balance; `uso_externo.rs`). */
export interface DeepseekBalanceUsage {
  /** `none` = sin DEEPSEEK_API_KEY. */
  status: "ok" | "none" | "error";
  available: boolean | null;
  balances: { currency: string; total: string }[];
  note: string | null;
  readAtMs: number | null;
}

/** Delegaciones de un motor según cockpit/delegations.jsonl. */
export interface DelegationEngineUsage {
  engine: string;
  attempts: number;
  ok: number;
  successPct: number;
  costUsd: number | null;
}

export interface EnginesPlanUsage {
  generatedAtMs: number;
  engines: EnginePlanUsage[];
  /** Ausente en un backend anterior. */
  deepseek?: DeepseekBalanceUsage | null;
  delegations?: DelegationEngineUsage[] | null;
  delegationsError?: string | null;
}

export interface PlanUsage {
  fiveHour: PlanWindowUsage | null;
  weekly: PlanWindowUsage | null;
  stale: boolean;
}

export interface SavedAttachment {
  path: string;
  /** null si el fichero no es una imagen. */
  previewDataUrl: string | null;
}

/** Estado en disco de una ruta citada en la sesión (`sesiones_paths_status`). */
export interface PathStatus {
  /** Ruta tal como se consultó. */
  path: string;
  /** Ruta canónica, si existe y está permitida. */
  abs: string | null;
  /** Existe y está bajo el directorio personal. */
  exists: boolean;
  isFile: boolean;
  /** «Abrir» con la app del sistema permitido para su tipo (no ejecutables ni scripts). */
  canOpen: boolean;
  size: number | null;
  /** Motivo cuando no existe, no es un fichero o no está permitida. */
  error: string | null;
}

export interface CreateSessionArgs {
  projectId?: string;
  cwd: string;
  resume?: string;
  model?: string;
  effort?: Effort;
  /** v3: `/branch` → `--resume <sid> --fork-session`. */
  forkFrom?: string;
  /** v3: sustituye a `SessionPrefs.launchPermissionMode` solo en esta sesión. */
  permissionMode?: PermissionMode;
}

export type SendTarget = "claude" | "codexLocal" | "codexCloud" | "gemini" | "opencode";

// ---------------------------------------------------------------------------
// v0.2 (CONTRATO-v2.md, sección 1)
// ---------------------------------------------------------------------------

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type SocraticMode = "strict" | "light" | "off" | "uni";

export interface SessionSettings {
  model: string | null;
  effort: Effort | null;
  /** v3: modo real (§2.5). */
  permissionMode: PermissionMode | null;
  socratic: SocraticMode | null;
  projectId: string | null;
  /** v3: modo efectivo del último lanzamiento. */
  launchPermissionMode: PermissionMode;
}

/** `plugin` y `mcp` llegan con la lista viva del puente (§2.3). */
export type CommandSource = "builtin" | "mod" | "skill" | "user" | "project" | "plugin" | "mcp";

export interface CommandDef {
  /** Sin la barra: `compact`, `mejorar`. */
  name: string;
  description: string;
  argHint?: string;
  source: CommandSource;
  /** Nombre del mod o de la skill. */
  origin?: string;
  // --- v3 (§2.1) ---
  kind: CommandKind;
  /** Solo con `kind=panel`. */
  panel?: PanelId;
  needsArgs: boolean;
  /** La TUI lo ejecuta al momento aunque haya un turno en curso. */
  immediate: boolean;
  /** Explicación para `unsupported` o `terminal`. */
  note?: string;
  aliases?: string[];
}

export interface ModInfo {
  name: string;
  description: string;
  version: string | null;
  path: string;
  enabled: boolean;
  commands: string[];
}

export interface Bitacora {
  resumen: string;
  pendientes: string[];
  decisiones: string[];
  gotchas: string[];
  updatedAt: string | null;
}

export interface EngineStatus {
  id: EngineId;
  available: boolean;
  reason?: string;
  version?: string;
  /** Aviso aunque esté disponible (qué CLI de Gemini funciona). */
  note?: string;
}

export interface EngineRunArgs {
  sessionId: SessionId;
  engine: EngineId;
  prompt: string;
  kind: EngineTaskKind;
  includeContext: boolean;
  mode?: CodexMode;
  /** Modelo del motor; ausente = el predeterminado de su CLI. */
  model?: string;
  /** Id del Tribunal (Codex y Gemini con el mismo encargo). */
  group?: string;
  /** Clave idempotente: con el mismo `turnId` el backend devuelve la tarea ya lanzada. */
  turnId?: string;
}

/** Modelo que ofrece la CLI de un motor (`sesiones_engine_models`). */
export interface EngineModel {
  id: string;
  label: string;
}

// ---------------------------------------------------------------------------
// v3: contrato de estabilidad 2026-10-08 (§7.3). Interfaz congelada en la fase 0b.
// ---------------------------------------------------------------------------

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "auto" | "dontAsk";

/** Última clasificación de la pantalla del PTY (§1.1). */
export type ScreenState = "unknown" | "prompt" | "busy" | "dialog" | "trust";

/** Opción de un menú o del diálogo de confianza leída de la pantalla (§4.6). */
export interface DialogOption {
  index: number;
  label: string;
  selected: boolean;
}

export type WaitKind = "question" | "permission" | "plan" | "menu" | "trust";

export interface WaitInfo {
  kind: WaitKind;
  askId?: string;
  label: string;
  /** ISO. */
  since: string;
  /** Solo en `menu`: opciones de la pantalla en el momento de proyectar. */
  options?: DialogOption[];
}

/** `startupTimeout` va en `starting` (30 s sin llegar al prompt); el resto, en `working`. */
export type StallReason = "noEvents" | "toolOverdue" | "tuiFrozen" | "noTurnStart" | "startupTimeout";

export interface StallInfo {
  reason: StallReason;
  /** ISO. */
  since: string;
  tool?: string;
  detail: string;
}

export type MessageKind =
  | "prompt" | "answer" | "command" | "bash" | "interrupted"
  | "compactSummary" | "taskNotification" | "meta" | "system";

/**
 * §2.1 más el cambio de diseño del 2026-10-08 (todos los slash commands desde el
 * chat): `menu` abre el bloque de menú en el chat y `exit` cierra la CLI con
 * confirmación. `panel` y `terminal` siguen en el cable por compatibilidad con
 * la fase 0a y el chat los trata igual que `menu`.
 */
export type CommandKind = "prompt" | "local" | "menu" | "exit" | "panel" | "terminal" | "unsupported";

export type PanelId =
  | "model" | "effort" | "config" | "status" | "usage" | "context" | "permissions" | "hooks" | "memory"
  | "resume" | "rename" | "exit" | "copy" | "addDir" | "help" | "agentes" | "git" | "uso" | "mcp" | "plugins"
  | "export" | "autocompact" | "advisor" | "auth" | "branch" | "engines" | "skills" | "tasks";

/** Entrada de la lista viva `$.command.list()` del puente (evento `commands`, §6.3). */
export interface CommandInfoLive {
  name: string;
  description: string;
  source: "builtin" | "plugin" | "user" | "mcp";
  plugin?: string;
  immediate?: boolean;
}

export type RecoverAction = "interrupt" | "exitMenu" | "restart";

/** Solo con `restart` (§3.3). */
export interface RecoverOptions {
  permissionMode?: PermissionMode;
}

export interface RecoverOutcome {
  ok: boolean;
  action: RecoverAction;
  steps: string[];
  status: SessionStatus;
}

export type SendMode = "auto" | "now";

/** Resultado de `sesiones_background` (§3.4): `ok` solo si el puente cerró la herramienta tras el Ctrl+B. */
export interface BackgroundOutcome {
  ok: boolean;
  toolUseId: string;
  tool: string;
  evidence: "toolEnd" | "none";
  steps: string[];
  /** Con `ok: false`, por qué no se confirmó. */
  reason?: string;
}

/** Resultado de `sesiones_interrupt_send` (§3.4). */
export interface InterruptSendOutcome {
  interrupted: boolean;
  /** El mensaje salió ya; si no, sigue el primero de la cola. */
  sent: boolean;
  steps: string[];
  item: QueueItem;
}

export interface SendOutcome {
  clientId: string;
  disposition: "written" | "queued";
}

export interface CommandOutcome {
  disposition: "written" | "queued" | "panel" | "terminal" | "unsupported";
  panel?: PanelId;
  note?: string;
  text?: string;
}

/** Resultado de una operación del buzón (§6.4); `pending` llega después por `sesiones://op-result`. */
export interface OpResult {
  ok: boolean;
  text?: string;
  pending?: boolean;
  opId?: string;
  value?: unknown;
  error?: string;
}

export type QueueState = "queued" | "sending" | "cliQueued" | "absorbed" | "delivered" | "failed";
export type QueueItemKind = "prompt" | "command" | "bash";

/** Elemento de la cola única del backend (§5.2). */
export interface QueueItem {
  clientId: string;
  text: string;
  attachments: string[];
  delegate: boolean;
  kind: QueueItemKind;
  origin: "ultron" | "cli";
  state: QueueState;
  createdAt: string;
  sentAt?: string;
  error?: string;
  messageUuid?: string;
}

export interface QueueItemInput {
  clientId: string;
  text: string;
  attachments: string[];
  delegate: boolean;
  kind: QueueItemKind;
}

export interface QueueItemPatch {
  text?: string;
  attachments?: string[];
  delegate?: boolean;
}

/** Valor de una fila de `/config` (`ConfigValue` de la API de mods 2.1.293). */
export type ConfigValue = boolean | string | number | readonly string[];

/** Fila de `$.config.list()` (§2.5). */
export interface ConfigRow {
  key: string;
  label: string;
  description?: string;
  kind: "boolean" | "choice" | "text" | "number";
  value: ConfigValue;
  options?: readonly string[];
  /** Dueño de la fila: el motor o el plugin. */
  provider: { kind: string; name?: string };
  isLocked: boolean;
}

export type ConfigSetOutcome = { value: ConfigValue } | { deny: string };

/** Respuesta de `$.session.usage()` tal cual (§7.1); la forma detallada es del motor. */
export interface SessionUsageInfo {
  startedAt: number;
  context: Record<string, unknown>;
  rateLimits: Record<string, unknown>[];
  cost?: Record<string, unknown>;
}

export type TurnEndReason = "answer" | "aborted" | "refusal" | "error";

/** Payload de `sesiones://turn` (§7.2). */
export interface TurnPayload {
  id: SessionId;
  turnId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  reason: TurnEndReason;
  usage?: Usage;
  /** `usage` de los `turnEnd` de subagentes llegados durante el turno principal (R17). */
  subagentUsage?: Usage[];
}

export interface SessionPrefs {
  launchPermissionMode: PermissionMode;
  launchModel?: string;
  launchEffort?: Effort;
  /** Umbral de `stalled.noEvents` en segundos (60-600). */
  stallSeconds: number;
  automaticRelay?: boolean;
}

export type SettingsScope = "user" | "project" | "local";

export interface MemoryFile {
  scope: SettingsScope;
  path: string;
  exists: boolean;
}

/** Reglas de permisos de un settings.json, en solo lectura. */
export interface PermissionRules {
  scope: SettingsScope;
  path: string;
  allow: string[];
  ask: string[];
  deny: string[];
}

export type ComposerFillMode = "replace" | "append" | "insert";
export type NoticeLevel = "info" | "warn" | "error";

// <WP-MOTORES>
/** Effort guardado de Codex (`model_reasoning_effort`) y niveles elegibles. */
export interface EngineEffort {
  /** `null` = el de `~/.codex/config.toml`. */
  effort: string | null;
  /** Niveles del modelo pedido (o de todos, si no se conoce). */
  levels: string[];
}
// </WP-MOTORES>

/** Formato de `sesiones_export`. */
export type ExportFormat = "md" | "html";

/** Fichero escrito por `sesiones_export`. */
export interface ExportResult {
  path: string;
  /** Mensajes del transcript leídos (la conversación completa, no la vista). */
  messages: number;
  bytes: number;
}
