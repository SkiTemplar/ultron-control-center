// Reducer puro del estado de la ventana. Nunca muta: cada acción devuelve
// un objeto nuevo y conserva las referencias de lo que no cambia, para que los
// selectores de `useSyncExternalStore` no provoquen renders de más.

import { absorbEchoes, addEcho, dropEcho, pruneRetired, reconcileEchoes, retireSettled, type Echo } from "./echo";
import { DISMISSED_CAP, loadDismissed } from "./engine-dismissed";
import { capThread, placeLastPage, prependPage } from "./paging";
import type { WorkflowRun } from "./workflows";
import { mergeMessages } from "./parse";
import { BYTE_CAP, BYTE_KEEP, capBytes, evictableAgents, threadWeight, touchLru } from "./thread-memory";
import {
  applyTool, clearMainTools, collectToolIds, emptySession, pagingOf, settleMainRunning, threadOf, type ChatNote, type SessionState, type ThreadPaging,
} from "./session-state";
import type {
  AgentNode,
  Ask,
  ChatMessage,
  CommandDef,
  EngineStatus,
  EngineTask,
  PlanUsage,
  RelayState,
  QueueItem,
  SavedAttachment,
  SessionId,
  SessionInfo,
  SessionSettings,
  StatusPayload,
  ToolPayload,
  TurnPayload,
} from "./types";

export { emptySession, type ChatNote, type LiveTool, type SessionState, type ThreadPaging } from "./session-state";

export interface State {
  ready: boolean;
  isMock: boolean;
  sessions: SessionInfo[];
  /** Instante (ms) en que cada sesión pasó a `working`; sobrevive a abrir o cambiar de chat. */
  workingSince: Record<SessionId, number>;
  bySession: Record<SessionId, SessionState>;
  asks: Ask[];
  /** Preguntas que la ventana oculta al pulsar Interrumpir hasta que llega `ask-resolved`. */
  interruptingAsks: string[];
  /** Intervenciones de Codex y Gemini (v0.2; antes `codex`). */
  engines: EngineTask[];
  /** Ids de intervenciones descartadas del hilo (no se borran del inspector). */
  dismissed: string[];
  engineStatus: EngineStatus[] | null;
  relays: Record<SessionId, RelayState>;
  settings: Record<SessionId, SessionSettings>;
  usage: PlanUsage | null;
  focusProjectId: string | null;
  error: string | null;
  /** Hilos de subagente abiertos en algún panel, por sesión: la cota de hilos nunca los suelta. */
  openAgents: Record<SessionId, string[]>;
}

export type Action =
  | { type: "ready"; isMock: boolean }
  | { type: "sessions"; sessions: SessionInfo[]; at?: number }
  /** Última página (§7). `generation` distinta de la del store: respuesta de otra conversación, se descarta. */
  | { type: "history"; id: SessionId; agentId: string | null; messages: ChatMessage[]; hasMore?: boolean; generation?: number; replace?: boolean }
  /** Página anterior al primer mensaje del hilo: se antepone sin duplicar. */
  | { type: "historyOlder"; id: SessionId; agentId: string | null; messages: ChatMessage[]; hasMore: boolean; generation: number }
  | { type: "historyPaging"; id: SessionId; agentId: string | null; patch: Partial<ThreadPaging>; generation?: number }
  | { type: "messages"; id: SessionId; messages: ChatMessage[] }
  | { type: "agents"; id: SessionId; agents: AgentNode[] }
  /** Un run que cambió (evento en vivo). */
  | { type: "workflow"; id: SessionId; run: WorkflowRun }
  /** Lista completa desde disco: lo que ya llegó en vivo manda. */
  | { type: "workflows"; id: SessionId; runs: WorkflowRun[] }
  | { type: "tool"; payload: ToolPayload }
  | { type: "ask"; ask: Ask }
  | { type: "asks"; id?: SessionId; asks: Ask[] }
  | { type: "askResolved"; askId: string }
  | { type: "askInterrupting"; askIds: string[] }
  | { type: "askInterruptFailed"; askIds: string[] }
  | { type: "status"; payload: StatusPayload }
  | { type: "engine"; task: EngineTask }
  | { type: "engineList"; tasks: EngineTask[] }
  | { type: "engineDismiss"; taskId: string }
  | { type: "engineStatus"; engines: EngineStatus[] }
  | { type: "relay"; id: SessionId; relay: RelayState | null }
  | { type: "relayList"; relays: RelayState[] }
  | { type: "settings"; id: SessionId; settings: SessionSettings }
  | { type: "usage"; usage: PlanUsage }
  | { type: "attachment"; id: SessionId; attachment: SavedAttachment }
  | { type: "focusProject"; projectId: string | null }
  | { type: "error"; message: string | null }
  // --- v3 (§5) ---
  | { type: "reset"; id: SessionId }
  | { type: "echo"; id: SessionId; echo: Omit<Echo, "seen" | "state"> }
  | { type: "echoDrop"; id: SessionId; clientId: string }
  | { type: "queue"; id: SessionId; items: QueueItem[] }
  | { type: "turn"; payload: TurnPayload }
  | { type: "note"; id: SessionId; note: ChatNote }
  | { type: "commands"; id: SessionId; items: CommandDef[] }
  /** Hilos de subagente abiertos en los paneles de esta ventana (los publica `open-agents.ts`). */
  | { type: "openAgents"; open: Record<SessionId, string[]> };

export const initialState: State = {
  ready: false,
  isMock: false,
  sessions: [],
  workingSince: {},
  bySession: {},
  asks: [],
  interruptingAsks: [],
  engines: [],
  dismissed: loadDismissed(),
  engineStatus: null,
  relays: {},
  settings: {},
  usage: null,
  focusProjectId: null,
  error: null,
  openAgents: {},
};

const MAX_TURNS = 200;
// Las notas sobreviven a los resets (son de la sesión de ULTRON): la cota es más holgada que la de turnos.
const MAX_NOTES = 500;
/** Intervenciones en memoria: las que siguen en marcha y las más recientes hasta este tope. */
export const MAX_ENGINES = 200;
export const MAX_DISMISSED = DISMISSED_CAP;

function patchSession(state: State, id: SessionId, fn: (s: SessionState) => SessionState): State {
  const prev = state.bySession[id] ?? emptySession;
  const next = fn(prev);
  if (next === prev) return state;
  return { ...state, bySession: { ...state.bySession, [id]: next } };
}

function setPaging(s: SessionState, agentId: string | null, patch: Partial<ThreadPaging>): SessionState {
  const prev = pagingOf(s, agentId);
  const keys = Object.keys(patch) as (keyof ThreadPaging)[];
  if (keys.every((k) => patch[k] === undefined || patch[k] === prev[k])) return s;
  return { ...s, paging: { ...s.paging, [threadOf(agentId)]: { ...prev, ...patch } } };
}

const NO_OPEN: ReadonlySet<string> = new Set();

/** Suelta el hilo de un subagente (mensajes, paginación y LRU); se vuelve a pedir paginado al abrirlo. */
function dropAgent(s: SessionState, agentId: string): SessionState {
  const { [agentId]: _gone, ...agentMessages } = s.agentMessages;
  const { [threadOf(agentId)]: _paging, ...paging } = s.paging;
  return { ...s, agentMessages, paging, agentLru: s.agentLru.filter((x) => x !== agentId) };
}

/** Cota de hilos de subagente: los abiertos en algún panel más los `AGENT_THREADS_KEEP` más recientes. */
function pruneAgents(s: SessionState, open: ReadonlySet<string>): SessionState {
  return evictableAgents(s.agentLru, open).reduce(dropAgent, s);
}

function weightExcept(s: SessionState, agentId: string | null): number {
  let total = agentId === null ? 0 : threadWeight(s.messages);
  for (const [id, list] of Object.entries(s.agentMessages)) if (id !== agentId) total += threadWeight(list);
  return total;
}

/**
 * Tope en bytes por sesión: por encima de `BYTE_CAP`, primero se sueltan los hilos
 * de subagente cerrados (del menos reciente) y después lo más antiguo del propio
 * hilo, hasta `BYTE_KEEP`.
 */
function capSessionBytes(s: SessionState, agentId: string | null, list: ChatMessage[], open: ReadonlySet<string>): [SessionState, ChatMessage[]] {
  let others = weightExcept(s, agentId);
  if (others + threadWeight(list) <= BYTE_CAP) return [s, list];
  let next = s;
  for (const id of s.agentLru) {
    if (others + threadWeight(list) <= BYTE_KEEP) break;
    const gone = next.agentMessages[id];
    if (id === agentId || open.has(id) || !gone) continue;
    others -= threadWeight(gone);
    next = dropAgent(next, id);
  }
  return [next, capBytes(list, Math.max(0, BYTE_KEEP - others))];
}

/** Sustituye la lista de un hilo y, si la cota en vivo (cantidad o bytes) la recorta, marca `hasMore`. */
function withThread(s: SessionState, agentId: string | null, list: ChatMessage[], live: boolean, open: ReadonlySet<string> = NO_OPEN): SessionState {
  const counted = live ? capThread(list, pagingOf(s, agentId).pinned) : list;
  const [base, capped] = live ? capSessionBytes(s, agentId, counted, open) : [s, counted];
  const next = agentId === null ? { ...base, messages: capped } : { ...base, agentMessages: { ...base.agentMessages, [agentId]: capped } };
  return capped === list ? next : setPaging(next, agentId, { hasMore: true });
}

function appendMessages(s: SessionState, messages: ChatMessage[], open: ReadonlySet<string>): SessionState {
  const main = messages.filter((m) => m.agentId === null);
  const byAgent = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    if (m.agentId === null) continue;
    byAgent.set(m.agentId, [...(byAgent.get(m.agentId) ?? []), m]);
  }
  let next = byAgent.size === 0 ? s : { ...s, agentLru: touchLru(s.agentLru, [...byAgent.keys()]) };
  for (const [agentId, list] of byAgent) {
    next = withThread(next, agentId, mergeMessages(next.agentMessages[agentId] ?? [], list), true, open);
  }
  if (byAgent.size > 0) next = pruneAgents(next, open);
  if (main.length > 0) next = withThread(next, null, mergeMessages(next.messages, main), true, open);
  const persisted = collectToolIds(s.persistedToolIds, messages);
  return settleMainRunning({
    ...next,
    persistedToolIds: persisted,
    liveTools: s.liveTools.filter((t) => !persisted.has(t.toolUseId)),
    echoes: absorbEchoes(s.echoes, main),
  }, main);
}

type HistoryAction = Extract<Action, { type: "history" }>;

function applyHistory(s: SessionState, a: HistoryAction, open: ReadonlySet<string>): SessionState {
  if (a.generation !== undefined && a.generation !== s.generation) return s;
  const persisted = collectToolIds(s.persistedToolIds, a.messages);
  // Una carga buena (con `hasMore`) borra el fallo de la anterior.
  const clearError = pagingOf(s, a.agentId).loadError ? { loadError: null } : {};
  const paged = a.hasMore === undefined ? s : setPaging(s, a.agentId, { hasMore: a.hasMore, ...clearError });
  if (a.agentId !== null) {
    // F16: fusiona con lo llegado por evento durante la carga en vez de reemplazarlo.
    const merged = placeLastPage(s.agentMessages[a.agentId] ?? [], a.messages, a.replace);
    const agentLru = touchLru(s.agentLru, [a.agentId]);
    return pruneAgents({ ...paged, agentMessages: { ...s.agentMessages, [a.agentId]: merged }, agentLru, persistedToolIds: persisted }, open);
  }
  return settleMainRunning({
    ...paged,
    messages: placeLastPage(s.messages, a.messages, a.replace),
    historyLoaded: true,
    persistedToolIds: persisted,
    liveTools: s.liveTools.filter((t) => !persisted.has(t.toolUseId)),
    echoes: absorbEchoes(s.echoes, a.messages),
  }, a.messages);
}

type OlderAction = Extract<Action, { type: "historyOlder" }>;

function applyOlder(s: SessionState, a: OlderAction): SessionState {
  if (a.generation !== s.generation) return s;
  const current = a.agentId === null ? s.messages : s.agentMessages[a.agentId] ?? [];
  const next = withThread(s, a.agentId, prependPage(current, a.messages), false);
  return setPaging({ ...next, persistedToolIds: collectToolIds(s.persistedToolIds, a.messages) }, a.agentId, { hasMore: a.hasMore, loading: false });
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const at = list.findIndex((x) => x.id === item.id);
  return at === -1 ? [item, ...list] : list.map((x, i) => (i === at ? item : x));
}

/** Acota las intervenciones: nunca suelta una en marcha; del resto, las más recientes. */
export function capEngines(list: EngineTask[]): EngineTask[] {
  if (list.length <= MAX_ENGINES) return list;
  const running = list.filter((t) => t.status === "running");
  const room = Math.max(0, MAX_ENGINES - running.length);
  const recent = list.filter((t) => t.status !== "running").sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, room);
  const keep = new Set([...running, ...recent]);
  return list.filter((t) => keep.has(t));
}

/** Quita del store lo de las sesiones que ya no están en la lista (salidas y cerradas). */
function purgeGone(state: State, sessions: SessionInfo[]): State {
  const alive = new Set(sessions.map((s) => s.id));
  const gone = (rec: Record<SessionId, unknown>) => Object.keys(rec).some((id) => !alive.has(id));
  const keep = <T,>(rec: Record<SessionId, T>) => Object.fromEntries(Object.entries(rec).filter(([id]) => alive.has(id)));
  return {
    ...state,
    bySession: gone(state.bySession) ? keep(state.bySession) : state.bySession,
    settings: gone(state.settings) ? keep(state.settings) : state.settings,
  };
}

/** Conserva el inicio de las sesiones que siguen trabajando y fija `at` en las que empiezan. */
export function trackWorking(prev: Record<SessionId, number>, sessions: SessionInfo[], at: number): Record<SessionId, number> {
  const next: Record<SessionId, number> = Object.fromEntries(
    sessions.filter((s) => s.status === "working" || s.status === "waiting").map((s) => [s.id, prev[s.id] ?? at]),
  );
  const keys = Object.keys(next);
  // Sin cambios, la misma referencia: quien lo selecciona no se vuelve a pintar.
  return keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]) ? prev : next;
}

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Lista de sesiones con las entradas que no han cambiado conservando su objeto
 * (y la lista entera si nada cambió). El puente reemite la lista cada vez que
 * avanza `lastActivityAt` de una sesión; sin esto, cada emisión daba objetos
 * nuevos a todas y repintaba el chat de cada panel abierto.
 */
export function reuseSessions(prev: readonly SessionInfo[], next: SessionInfo[]): SessionInfo[] {
  const byId = new Map(prev.map((s) => [s.id, s]));
  const out = next.map((s) => {
    const old = byId.get(s.id);
    return old && sameJson(old, s) ? old : s;
  });
  return out.length === prev.length && out.every((s, i) => s === prev[i]) ? (prev as SessionInfo[]) : out;
}

/** ¿El estado de la línea de estado es el mismo? (llega repetido con cada lectura del puente). */
function sameStatus(a: StatusPayload | null, b: StatusPayload): boolean {
  if (!a) return false;
  const ka = Object.keys(a) as (keyof StatusPayload)[];
  const kb = Object.keys(b) as (keyof StatusPayload)[];
  return ka.length === kb.length && kb.every((k) => a[k] === b[k]);
}

/** Al pasar a idle o exited no queda ninguna herramienta «en vivo» del hilo principal. */
function settleSessions(state: State, sessions: SessionInfo[]): State {
  let next = state;
  for (const s of sessions) {
    if (s.status !== "idle" && s.status !== "exited") continue;
    next = patchSession(next, s.id, clearMainTools);
  }
  return next;
}

function resetSession(state: State, id: SessionId): State {
  const prev = state.bySession[id] ?? emptySession;
  // La cola se conserva (lo pendiente sigue vivo), pero lo ya entregado a la conversación
  // que se cierra queda retirado: la siguiente instantánea no lo resucita como eco.
  const fresh: SessionState = {
    ...emptySession, historyLoaded: true, notes: prev.notes, queue: prev.queue, commands: prev.commands, attachments: prev.attachments, status: prev.status,
    retiredEchoes: retireSettled(prev.retiredEchoes, prev.queue), generation: prev.generation + 1,
  };
  const asks = state.asks.filter((a) => a.id !== id);
  return { ...state, asks: asks.length === state.asks.length ? state.asks : asks, bySession: { ...state.bySession, [id]: fresh } };
}

/** Ventana en la que una nota idéntica a la anterior se cuenta en vez de repetirse. */
const NOTE_COALESCE_MS = 10_000;

/**
 * Añade la nota; si repite la última (mismo nivel y texto, hace < 10 s), sube su
 * `count` y su hora en vez de apilar otra igual (dos Esc seguidos, avisos repetidos).
 */
export function addNoteTo(notes: ChatNote[], note: ChatNote): ChatNote[] {
  const last = notes[notes.length - 1];
  const gap = last ? Date.parse(note.at) - Date.parse(last.at) : Number.NaN;
  if (last && last.level === note.level && last.text === note.text && gap >= 0 && gap < NOTE_COALESCE_MS) {
    return [...notes.slice(0, -1), { ...last, at: note.at, count: (last.count ?? 1) + 1 }];
  }
  return [...notes, note].slice(-MAX_NOTES);
}

function applyQueue(s: SessionState, items: QueueItem[]): SessionState {
  const retiredEchoes = pruneRetired(s.retiredEchoes, items);
  return { ...s, queue: items, retiredEchoes, echoes: reconcileEchoes(s.echoes, items, s.messages, new Set(retiredEchoes)) };
}

function openOf(state: State, id: SessionId): ReadonlySet<string> {
  const list = state.openAgents[id];
  return list && list.length > 0 ? new Set(list) : NO_OPEN;
}

/** Nuevos hilos abiertos: los que se cierran pasan al LRU y se sueltan si sobran. */
function applyOpenAgents(state: State, open: Record<SessionId, string[]>): State {
  if (sameJson(state.openAgents, open)) return state;
  let next: State = { ...state, openAgents: open };
  for (const id of Object.keys(state.bySession)) next = patchSession(next, id, (s) => pruneAgents(s, openOf(next, id)));
  return next;
}

function sessionReducer(state: State, action: Action): State | null {
  switch (action.type) {
    case "history":
      return patchSession(state, action.id, (s) => applyHistory(s, action, openOf(state, action.id)));
    case "historyOlder":
      return patchSession(state, action.id, (s) => applyOlder(s, action));
    case "historyPaging":
      return patchSession(state, action.id, (s) => (action.generation !== undefined && action.generation !== s.generation ? s : setPaging(s, action.agentId, action.patch)));
    case "messages":
      return patchSession(state, action.id, (s) => appendMessages(s, action.messages, openOf(state, action.id)));
    case "agents":
      return patchSession(state, action.id, (s) => ({ ...s, agents: action.agents }));
    case "workflow":
      return patchSession(state, action.id, (s) => ({ ...s, workflows: { ...s.workflows, [action.run.runId]: action.run } }));
    case "workflows":
      return patchSession(state, action.id, (s) => ({ ...s, workflows: { ...Object.fromEntries(action.runs.map((r) => [r.runId, r])), ...s.workflows }, workflowsLoaded: true }));
    case "tool":
      return patchSession(state, action.payload.id, (s) => applyTool(s, action.payload));
    case "status":
      return patchSession(state, action.payload.id, (s) => (sameStatus(s.status, action.payload) ? s : { ...s, status: action.payload }));
    case "attachment":
      return patchSession(state, action.id, (s) => ({ ...s, attachments: [...s.attachments, action.attachment] }));
    case "reset":
      return resetSession(state, action.id);
    case "echo":
      return patchSession(state, action.id, (s) => ({ ...s, echoes: addEcho(s.echoes, action.echo) }));
    case "echoDrop":
      return patchSession(state, action.id, (s) => ({ ...s, echoes: dropEcho(s.echoes, action.clientId) }));
    case "queue":
      return patchSession(state, action.id, (s) => applyQueue(s, action.items));
    case "turn":
      return patchSession(state, action.payload.id, (s) => clearMainTools({ ...s, turns: [...s.turns, action.payload].slice(-MAX_TURNS) }));
    case "note":
      return patchSession(state, action.id, (s) => ({ ...s, notes: addNoteTo(s.notes, action.note) }));
    case "commands":
      return patchSession(state, action.id, (s) => ({ ...s, commands: action.items }));
    case "openAgents":
      return applyOpenAgents(state, action.open);
    default:
      return null;
  }
}

function asksReducer(state: State, action: Action): State | null {
  switch (action.type) {
    case "ask":
      return state.asks.some((a) => a.askId === action.ask.askId) ? state : { ...state, asks: [...state.asks, action.ask] };
    case "asks": {
      const fresh = action.asks.filter((a) => !state.asks.some((x) => x.askId === a.askId));
      return fresh.length === 0 ? state : { ...state, asks: [...state.asks, ...fresh] };
    }
    case "askResolved":
      return {
        ...state,
        asks: state.asks.filter((a) => a.askId !== action.askId),
        interruptingAsks: state.interruptingAsks.filter((x) => x !== action.askId),
      };
    case "askInterrupting":
      return { ...state, interruptingAsks: [...new Set([...state.interruptingAsks, ...action.askIds])] };
    case "askInterruptFailed":
      return { ...state, interruptingAsks: state.interruptingAsks.filter((x) => !action.askIds.includes(x)) };
    default:
      return null;
  }
}

export function reducer(state: State, action: Action): State {
  const bySession = sessionReducer(state, action) ?? asksReducer(state, action);
  if (bySession) return bySession;
  switch (action.type) {
    case "ready":
      return { ...state, ready: true, isMock: action.isMock };
    case "sessions": {
      const sessions = reuseSessions(state.sessions, action.sessions);
      return settleSessions(purgeGone({
        ...state,
        sessions,
        workingSince: trackWorking(state.workingSince, sessions, action.at ?? Date.now()),
      }, sessions), sessions);
    }
    case "engine":
      return { ...state, engines: capEngines(upsertById(state.engines, action.task)) };
    case "engineList":
      return { ...state, engines: capEngines(action.tasks) };
    case "engineDismiss":
      return state.dismissed.includes(action.taskId) ? state : { ...state, dismissed: [...state.dismissed, action.taskId].slice(-MAX_DISMISSED) };
    case "engineStatus":
      return { ...state, engineStatus: action.engines };
    case "relay": {
      const relays = { ...state.relays };
      if (action.relay) relays[action.id] = action.relay;
      else delete relays[action.id];
      return { ...state, relays };
    }
    case "relayList":
      return { ...state, relays: Object.fromEntries(action.relays.map((r) => [r.sessionId, r])) };
    case "settings":
      return { ...state, settings: { ...state.settings, [action.id]: action.settings } };
    case "usage":
      return { ...state, usage: action.usage };
    case "focusProject":
      return { ...state, focusProjectId: action.projectId };
    case "error":
      return { ...state, error: action.message };
    default:
      return state;
  }
}
