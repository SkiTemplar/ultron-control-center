// Estado por sesión del store y las operaciones puras sobre las herramientas
// en vivo (§5.4, `chat-orden:M1`, `EST-06`): un id ya persistido en el
// transcript nunca vuelve a pintarse «en vivo», un `end` de un id desconocido se
// ignora y el hilo principal se vacía al cerrar el turno o al pasar a idle.

import type { Echo } from "./echo";
import type { WorkflowRun } from "./workflows";
import type {
  AgentNode, ChatMessage, CommandDef, NoticeLevel, QueueItem, SavedAttachment, StatusPayload, ToolPayload, TurnPayload,
} from "./types";

/** Nota del chat generada por el cliente o por `sesiones://notice` (nunca un no-op silencioso). */
export interface ChatNote {
  id: string;
  /** ISO: la nota va en su posición cronológica. */
  at: string;
  level: NoticeLevel;
  text: string;
  /** Repeticiones seguidas de la misma nota (se pinta «×2»); sin campo, 1. */
  count?: number;
}

export interface LiveTool {
  toolUseId: string;
  agentId: string | null;
  name: string;
  summary: string;
  phase: "start" | "end";
  isError?: boolean;
  /** Instante (ms) del primer `start` visto en esta ventana. */
  startedAt?: number;
}

/** Paginación de un hilo (§7). */
export interface ThreadPaging {
  /** Quedan mensajes anteriores en el transcript (o se soltaron por la cota en vivo). */
  hasMore: boolean;
  /** Hay una página anterior en vuelo. */
  loading: boolean;
  /** El usuario lee lejos del final: la cota en vivo se relaja para no moverle el contenido. */
  pinned: boolean;
  /** Fallo de la última carga del historial desde el final: el chat lo enseña con «Reintentar». */
  loadError?: string | null;
}

export const NO_PAGING: ThreadPaging = { hasMore: false, loading: false, pinned: false };

/** Clave del hilo en `paging`: "" el principal, el `agentId` en los subagentes. */
export function threadOf(agentId: string | null): string {
  return agentId ?? "";
}

export function pagingOf(s: SessionState, agentId: string | null): ThreadPaging {
  return s.paging[threadOf(agentId)] ?? NO_PAGING;
}

export interface SessionState {
  messages: ChatMessage[];
  agentMessages: Record<string, ChatMessage[]>;
  /** Hilos de subagente en memoria, del menos al más reciente (LRU de la cota de hilos). */
  agentLru: string[];
  agents: AgentNode[];
  /** Runs de `Workflow` por runId (tarjeta del chat). */
  workflows: Record<string, WorkflowRun>;
  /** Ya se pidió la lista completa al backend: un runId que no esté es que no existe en disco. */
  workflowsLoaded: boolean;
  liveTools: LiveTool[];
  /**
   * Herramienta del hilo principal en curso para la línea de estado: a diferencia
   * de `liveTools`, no sale al persistirse su `tool_use` (se escribe al empezar),
   * solo con su `end`, su `toolResult` o el cierre del turno.
   */
  mainRunning: LiveTool | null;
  /** Ids de `tool_use` ya vistos en el transcript (mensajes e historial). */
  persistedToolIds: ReadonlySet<string>;
  status: StatusPayload | null;
  attachments: SavedAttachment[];
  historyLoaded: boolean;
  /** Eco optimista de lo enviado hasta que llega su mensaje (§5.2). */
  echoes: Echo[];
  /** Instantánea de la cola única del backend. */
  queue: QueueItem[];
  /** `clientId` de envíos de una conversación anterior (/clear) que la cola aún retiene: no vuelven como eco. */
  retiredEchoes: string[];
  /** Turnos principales cerrados (`sesiones://turn`), del más antiguo al más reciente. */
  turns: TurnPayload[];
  notes: ChatNote[];
  /** Catálogo vivo de la sesión (`sesiones://commands`); null sin lista viva. */
  commands: CommandDef[] | null;
  /** Paginación por hilo (clave de `threadOf`). */
  paging: Record<string, ThreadPaging>;
  /** Generación de la conversación: sube con cada `sesiones://reset`; una carga de otra generación se descarta. */
  generation: number;
}

const NO_IDS: ReadonlySet<string> = new Set();

export const emptySession: SessionState = {
  messages: [],
  agentMessages: {},
  agentLru: [],
  agents: [],
  workflows: {},
  workflowsLoaded: false,
  liveTools: [],
  mainRunning: null,
  persistedToolIds: NO_IDS,
  status: null,
  attachments: [],
  historyLoaded: false,
  echoes: [],
  queue: [],
  retiredEchoes: [],
  turns: [],
  notes: [],
  commands: null,
  paging: {},
  generation: 0,
};

/** Tope de ids persistidos por sesión; al pasarlo se quedan los `PERSISTED_KEEP` más recientes. */
export const PERSISTED_MAX = 5000;
export const PERSISTED_KEEP = 4000;

/**
 * Añade los ids de `tool_use` de los mensajes; devuelve el mismo Set si no hay
 * ninguno nuevo. Con tope: los más antiguos (orden de inserción) salen primero;
 * un evento `tool` de una herramienta de hace miles de llamadas no llega.
 */
export function collectToolIds(prev: ReadonlySet<string>, messages: readonly ChatMessage[]): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind !== "toolUse" || prev.has(b.id) || next?.has(b.id)) continue;
      next ??= new Set(prev);
      next.add(b.id);
    }
  }
  if (!next) return prev;
  return next.size > PERSISTED_MAX ? new Set([...next].slice(-PERSISTED_KEEP)) : next;
}

const LIVE_MAX = 30;

/** Fija o retira `mainRunning` con el evento `tool` del hilo principal. */
function trackMainRunning(s: SessionState, p: ToolPayload, now: number): SessionState {
  if (p.agentId !== null) return s;
  const current = s.mainRunning;
  if (p.phase === "end") return current?.toolUseId === p.toolUseId ? { ...s, mainRunning: null } : s;
  if (current?.toolUseId === p.toolUseId) return s;
  return { ...s, mainRunning: { toolUseId: p.toolUseId, agentId: null, name: p.name, summary: p.summary, phase: "start", startedAt: now } };
}

export function applyTool(s: SessionState, p: ToolPayload, now: number = Date.now()): SessionState {
  const next = trackMainRunning(s, p, now);
  if (next.persistedToolIds.has(p.toolUseId)) return next;
  const at = next.liveTools.findIndex((t) => t.toolUseId === p.toolUseId);
  if (at === -1 && p.phase === "end") return next;
  const tool: LiveTool = { toolUseId: p.toolUseId, agentId: p.agentId, name: p.name, summary: p.summary, phase: p.phase, isError: p.isError };
  const liveTools = at === -1
    ? [...next.liveTools, { ...tool, startedAt: now }].slice(-LIVE_MAX)
    : next.liveTools.map((t, i) => (i === at ? { ...t, ...tool, summary: tool.summary || t.summary } : t));
  return { ...next, liveTools };
}

/** Retira `mainRunning` si llega el `toolResult` de esa herramienta. */
export function settleMainRunning(s: SessionState, messages: readonly ChatMessage[]): SessionState {
  const id = s.mainRunning?.toolUseId;
  if (!id) return s;
  const done = messages.some((m) => m.agentId === null && m.blocks.some((b) => b.kind === "toolResult" && b.toolUseId === id));
  return done ? { ...s, mainRunning: null } : s;
}

export function clearMainTools(s: SessionState): SessionState {
  const hasLive = s.liveTools.some((t) => t.agentId === null);
  if (!hasLive && !s.mainRunning) return s;
  return { ...s, liveTools: hasLive ? s.liveTools.filter((t) => t.agentId !== null) : s.liveTools, mainRunning: null };
}
