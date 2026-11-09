// Arranque: carga la API, engancha los eventos al store y hace la carga inicial.
// Ninguna reacción a un evento tiene efectos laterales en el backend salvo leer
// (§0.1): N ventanas abiertas no duplican envíos, respuestas ni drenajes.

import { consumeCwdParam, newSessionInFolder } from "./abrir-carpeta";
import { loadApi, type SesionesApi, type Unlisten } from "./api";
import { armAttention, onAskAttention, onTurnAttention } from "./attention";
import { offerContinuation } from "./components/composer/continuation";
import { maybeAutoReview, onReviewUpdate } from "./auto-review";
import { newStalls, reportIncident, setIncidentSink } from "./incidents";
import { pagingOf } from "./session-state";
import { loadQueue, migrateLegacyQueue } from "./queue";
import { store } from "./store";
import { clearSessionStream, matchMessages, matchStream, pushStream, scheduleTurnCleanup, setMessagesSource } from "./stream";
import type { AskResolvedPayload, NoticeLevel, SesionesEvents, SessionId, SessionInfo } from "./types";
import { insertInComposer } from "./ui";
import { markTurnUnread } from "./unread";
import { pruneWorkspace, showInFocused, updateWorkspace, workspaceStore } from "./workspace";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function reportError(e: unknown): void {
  const message = errorText(e);
  store.dispatch({ type: "error", message });
  reportIncident({ id: null, origin: "error", level: "error", text: message });
}

let noteSeq = 0;

/** Nota del chat en su posición cronológica (aviso, resultado o error de un comando). */
export function addNote(id: SessionId, level: NoticeLevel, text: string): void {
  noteSeq += 1;
  store.dispatch({ type: "note", id, note: { id: `${Date.now().toString(36)}-${noteSeq}`, at: new Date().toISOString(), level, text } });
  if (level !== "info") reportIncident({ id, origin: "note", level, text });
}

const ASK_KINDS = new Set(["question", "permission", "plan"]);

/** Recupera las preguntas pendientes (§4.2 paso 7): al arrancar y si una sesión espera sin tarjeta. */
export async function loadPendingAsks(api: SesionesApi, id?: SessionId): Promise<void> {
  try {
    store.dispatch({ type: "asks", id, asks: await api.pendingAsks(id) });
  } catch (e) {
    reportError(e);
  }
}

const askReload = new Map<SessionId, number>();
const ASK_RELOAD_MS = 3000;

/** Sesiones que esperan una pregunta sin tarjeta en el store (como mucho una recarga cada 3 s). */
function askless(sessions: readonly SessionInfo[], now = Date.now()): SessionInfo[] {
  const asks = store.getState().asks;
  return sessions.filter((s) => {
    if (s.status !== "waiting" || !ASK_KINDS.has(s.waiting?.kind ?? "") || asks.some((a) => a.id === s.id)) return false;
    if (now - (askReload.get(s.id) ?? 0) < ASK_RELOAD_MS) return false;
    askReload.set(s.id, now);
    return true;
  });
}

const CANCEL_TEXT: Record<string, string> = {
  interrupted: "interrumpiste el turno",
  turnEnded: "el turno terminó",
  sessionExited: "la sesión terminó",
  modAborted: "se interrumpió en la CLI",
  restart: "la sesión se reinició",
};

/**
 * Quita la pregunta resuelta y avisa en el chat si se canceló. `gestor::kill` saca
 * la sesión del registro antes de cancelar sus preguntas: sin sesión viva no hay
 * nota, que resucitaría su estado después de que `sessions` lo purgase.
 */
export function onAskResolved(p: AskResolvedPayload): void {
  store.dispatch({ type: "askResolved", askId: p.askId });
  if (p.outcome !== "cancelled" || !p.reason || p.reason === "unknown") return;
  if (!store.getState().sessions.some((s) => s.id === p.id)) return;
  addNote(p.id, "info", `Pregunta cancelada: ${CANCEL_TEXT[p.reason] ?? p.reason}.`);
}

function onOpResult(p: SesionesEvents["sesiones://op-result"]): void {
  if (!p.ok) return addNote(p.id, "error", p.error ?? "La operación falló sin detalle.");
  const text = typeof p.value === "string" ? p.value : typeof (p.value as { text?: unknown } | undefined)?.text === "string" ? (p.value as { text: string }).text : null;
  if (text) addNote(p.id, "info", text);
}

/** Claves de los atascos vigentes por sesión: solo un atasco nuevo es un incidente. */
let stallsSeen: ReadonlyMap<SessionId, string> = new Map();

function wireSessions(api: SesionesApi): Promise<Unlisten> {
  return api.on("sesiones://sessions", (sessions) => {
    store.dispatch({ type: "sessions", sessions });
    const stalls = newStalls(stallsSeen, sessions);
    stallsSeen = stalls.seen;
    stalls.reports.forEach(reportIncident);
    updateWorkspace((ws) => pruneWorkspace(ws, sessions.map((s) => s.id)));
    sessions.filter((s) => s.status === "exited").forEach((s) => clearSessionStream(s.id));
    askless(sessions).forEach((s) => void loadPendingAsks(api, s.id));
  });
}

function wireV3(api: SesionesApi): Promise<Unlisten>[] {
  const d = store.dispatch;
  return [
    api.on("sesiones://queue", ({ id, items }) => d({ type: "queue", id, items })),
    api.on("sesiones://turn", (payload) => {
      d({ type: "turn", payload });
      scheduleTurnCleanup(payload.id, payload.turnId);
      void maybeAutoReview(api, payload).catch(reportError);
      void onTurnAttention(payload).catch(reportError);
      markTurnUnread(payload, workspaceStore.getState());
    }),
    api.on("sesiones://stream-matched", ({ id, streamKey }) => matchStream(id, streamKey)),
    api.on("sesiones://composer-fill", ({ id, text, mode }) => insertInComposer(id, text, mode)),
    api.on("sesiones://reset", ({ id }) => {
      d({ type: "reset", id });
      clearSessionStream(id);
      void loadHistory(api, id, null);
      void refreshWorkflows(api, id);
    }),
    api.on("sesiones://commands", ({ id, items }) => d({ type: "commands", id, items })),
    api.on("sesiones://notice", ({ id, level, text }) => addNote(id, level, text)),
    api.on("sesiones://continuation", ({ id, text }) => offerContinuation(id, text)),
    api.on("sesiones://op-result", onOpResult),
  ];
}

async function wireEvents(api: SesionesApi): Promise<Unlisten[]> {
  const d = store.dispatch;
  setMessagesSource((id, agentId) => {
    const s = store.getState().bySession[id];
    return (agentId === null ? s?.messages : s?.agentMessages[agentId]) ?? [];
  });
  return allOrUnlisten([
    wireSessions(api),
    api.on("sesiones://messages", ({ id, messages }) => {
      d({ type: "messages", id, messages });
      matchMessages(id, messages);
    }),
    api.on("sesiones://stream", (p) => pushStream(p)),
    api.on("sesiones://tool", (payload) => d({ type: "tool", payload })),
    api.on("sesiones://agents", ({ id, agents }) => d({ type: "agents", id, agents })),
    api.on("sesiones://workflow", ({ id, run }) => d({ type: "workflow", id, run })),
    api.on("sesiones://ask", (ask) => {
      d({ type: "ask", ask });
      void onAskAttention(ask).catch(reportError);
    }),
    api.on("sesiones://ask-resolved", onAskResolved),
    api.on("sesiones://status", (payload) => d({ type: "status", payload })),
    api.on("sesiones://engine", (task) => {
      d({ type: "engine", task });
      onReviewUpdate(task);
    }),
    api.on("sesiones://engine-list", (tasks) => d({ type: "engineList", tasks })),
    api.on("sesiones://relay", ({ id, relay }) => d({ type: "relay", id, relay })),
    api.on("sesiones://focus-project", ({ projectId }) => focusProject(projectId)),
    api.on("sesiones://focus-session", ({ sessionId }) => focusSession(sessionId)),
    api.on("sesiones://new-in-cwd", ({ cwd }) => void newSessionInFolder(api, cwd)),
    ...wireV3(api),
  ]);
}

/**
 * Como `Promise.all`, pero si una suscripción falla da de baja las que sí entraron:
 * así «Reintentar» tras un arranque fallido no deja los eventos duplicados.
 */
export async function allOrUnlisten(pending: Promise<Unlisten>[]): Promise<Unlisten[]> {
  const settled = await Promise.allSettled(pending);
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  const ok = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!failure) return ok;
  ok.forEach((off) => off());
  throw failure.reason;
}

/** Lleva al panel con foco la sesión viva más reciente del proyecto pedido. */
export function focusProject(projectId: string): void {
  store.dispatch({ type: "focusProject", projectId });
  const match = [...store.getState().sessions].reverse().find((s) => s.projectId === projectId);
  if (match) updateWorkspace((ws) => showInFocused(ws, match.id));
}

/**
 * Pone la sesión en el panel con foco y su fila a la vista (clic en Pupus
 * con un aviso de esa sesión). Una sesión que esta ventana no conoce no
 * toca nada.
 */
export function focusSession(id: SessionId): void {
  if (!store.getState().sessions.some((s) => s.id === id)) return;
  updateWorkspace((ws) => showInFocused(ws, id));
  requestAnimationFrame(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-session-id]"));
    rows.find((el) => el.dataset.sessionId === id)?.scrollIntoView?.({ block: "nearest" });
  });
}

/** El backend ya no encuentra el cursor (`beforeUuid`) en el transcript (§7). */
export const HISTORY_CURSOR_GONE = "history_cursor_gone";

function generationOf(id: SessionId): number {
  return store.getState().bySession[id]?.generation ?? 0;
}

function threadMessages(id: SessionId, agentId: string | null) {
  const cur = store.getState().bySession[id];
  return (agentId ? cur?.agentMessages[agentId] : cur?.messages) ?? [];
}

/**
 * Última página del hilo (§7). Lleva la generación de la conversación: si llega
 * después de un `sesiones://reset`, el reducer la descarta. `replace` recarga
 * desde el final soltando las páginas anteriores ya cargadas.
 */
export async function loadHistory(api: SesionesApi, id: SessionId, agentId: string | null, replace = false): Promise<void> {
  const generation = generationOf(id);
  try {
    const page = await api.history({ id, agentId: agentId ?? undefined });
    store.dispatch({ type: "history", id, agentId, messages: page.messages, hasMore: page.hasMore, generation, replace });
    if (agentId === null && generationOf(id) === generation) matchMessages(id, page.messages);
  } catch (e) {
    // Se marca como cargado con lo que haya para no dejar el esqueleto colgado, pero con
    // el fallo a la vista: sin él, el chat decía «Sesión lista» o «Inicio de la conversación».
    store.dispatch({ type: "history", id, agentId, messages: threadMessages(id, agentId), generation });
    store.dispatch({ type: "historyPaging", id, agentId, generation, patch: { loadError: errorText(e) || "error sin detalle" } });
    reportError(e);
  }
}

/**
 * Página anterior al primer mensaje del hilo (§7), una a la vez. Si el cursor ya
 * no existe (el transcript cambió), avisa y recarga desde el final.
 */
export async function loadOlder(api: SesionesApi, id: SessionId, agentId: string | null): Promise<void> {
  const s = store.getState().bySession[id];
  const first = threadMessages(id, agentId)[0];
  if (!s || !first || pagingOf(s, agentId).loading || !pagingOf(s, agentId).hasMore) return;
  const generation = s.generation;
  store.dispatch({ type: "historyPaging", id, agentId, generation, patch: { loading: true } });
  try {
    const page = await api.history({ id, agentId: agentId ?? undefined, beforeUuid: first.uuid });
    store.dispatch({ type: "historyOlder", id, agentId, messages: page.messages, hasMore: page.hasMore, generation });
  } catch (e) {
    store.dispatch({ type: "historyPaging", id, agentId, generation, patch: { loading: false } });
    if (!errorText(e).includes(HISTORY_CURSOR_GONE)) return reportError(e);
    if (agentId === null) addNote(id, "info", "El transcript cambió (compactación o /clear): el chat se ha recargado desde el final.");
    await loadHistory(api, id, agentId, true);
  }
}

/** Ajustes de la sesión para el HUD (modelo, effort, socrático, permisos). */
export async function loadSettings(api: SesionesApi, id: SessionId): Promise<void> {
  try {
    store.dispatch({ type: "settings", id, settings: await api.settings(id) });
  } catch (e) {
    reportError(e);
  }
}

export async function refreshAgents(api: SesionesApi, id: SessionId): Promise<void> {
  try {
    store.dispatch({ type: "agents", id, agents: await api.agents(id) });
  } catch (e) {
    reportError(e);
  }
}

/** Runs de `Workflow` de la sesión: sobrevive a la recarga de la ventana. */
export async function refreshWorkflows(api: SesionesApi, id: SessionId): Promise<void> {
  try {
    store.dispatch({ type: "workflows", id, runs: await api.workflows(id) });
  } catch (e) {
    reportError(e);
  }
}

let booting: Promise<SesionesApi> | null = null;

/**
 * Idempotente: StrictMode monta dos veces y los eventos no deben duplicarse. Un
 * arranque fallido no se queda en caché: `retryBootstrap` lo vuelve a intentar.
 */
export function bootstrap(): Promise<SesionesApi> {
  booting ??= start().catch((e: unknown) => {
    booting = null;
    throw e;
  });
  return booting;
}

/** «Reintentar» de la pantalla de arranque fallido. */
export function retryBootstrap(): Promise<SesionesApi> {
  store.dispatch({ type: "error", message: null });
  return bootstrap();
}

function showInitial(sessions: SessionInfo[]): void {
  const ws = workspaceStore.getState();
  const alive = sessions.map((s) => s.id);
  updateWorkspace((w) => pruneWorkspace(w, alive));
  const wanted = new URLSearchParams(window.location.search).get("session");
  const first = sessions.find((s) => s.id === wanted) ?? sessions[0];
  const empty = ws.panes.every((p) => !p.sessionId || !alive.includes(p.sessionId));
  if (first && (empty || first.id === wanted)) updateWorkspace((w) => showInFocused(w, first.id));
}

/**
 * Cola y preguntas de cada sesión: una ventana nueva o recargada lo ve todo (EST-05, M2).
 * La cola se carga también en las terminadas: conservan sus `queued` para Reiniciar, y una
 * sesión restaurada al arrancar ULTRON cuyo relanzamiento falló llega así (#35).
 */
async function loadSessionState(api: SesionesApi, all: SessionInfo[]): Promise<void> {
  // Las sesiones de motor no tienen cola ni preguntas de Claude.
  const sessions = all.filter((s) => !s.engine);
  const alive = sessions.filter((s) => s.status !== "exited").map((s) => s.id);
  await loadPendingAsks(api);
  try {
    await migrateLegacyQueue(api, alive);
  } catch (e) {
    reportError(e);
  }
  await Promise.all(sessions.map((s) => loadQueue(api, s.id).catch(reportError)));
}

/**
 * Motores, tareas y uso llegan cada uno por su cuenta: la detección de motores
 * (`codex --version`, `agy --version`) y la petición HTTP de uso pueden tardar
 * segundos y no deben retrasar el primer pintado (hallazgo 11).
 */
function loadSecondary(api: SesionesApi): void {
  const d = store.dispatch;
  void api.engineList().then((tasks) => d({ type: "engineList", tasks }), reportError);
  void api.relayList().then((relays) => d({ type: "relayList", relays }), reportError);
  // Sin detección, los motores quedan en estado desconocido y la pestaña Motores lo dice.
  void api.engines().then((engines) => d({ type: "engineStatus", engines }), () => undefined);
  void api.usage().then((usage) => d({ type: "usage", usage }), reportError);
}

async function start(): Promise<SesionesApi> {
  const api = await loadApi();
  setIncidentSink((report) => api.reportIncident(report));
  await wireEvents(api);
  store.dispatch({ type: "ready", isMock: api.isMock });
  loadSecondary(api);
  try {
    const sessions = await api.list();
    store.dispatch({ type: "sessions", sessions });
    showInitial(sessions);
    await loadSessionState(api, sessions);
  } catch (e) {
    reportError(e);
  }
  const project = new URLSearchParams(window.location.search).get("project");
  if (project) focusProject(project);
  const cwd = consumeCwdParam();
  if (cwd) void newSessionInFolder(api, cwd);
  // Los avisos de atención se arman tras la carga inicial: nada de lo restaurado avisa.
  armAttention(api.isMock);
  return api;
}
