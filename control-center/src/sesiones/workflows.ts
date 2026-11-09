// Runs de `Workflow` de Claude Code (evento `sesiones://workflow` y comando
// `sesiones_workflows`): tipos del contrato y ayudas puras de la tarjeta del
// chat. Los tiempos van en milisegundos desde la época UNIX.

import type { ChatMessage, SessionId } from "./types";

export type WorkflowStatus = "running" | "completed" | "failed" | "killed" | "stopped";
export type WfAgentStatus = "running" | "done" | "failed" | "cached" | "stopped";

export interface WorkflowPhase {
  index: number;
  title: string;
  detail: string | null;
  /** Agentes vistos hasta ahora en la fase: mientras corre no se sabe cuántos faltan. */
  total: number;
  done: number;
  failed: number;
  running: number;
}

export interface WorkflowAgent {
  /** Clave del journal: la comparten los reintentos. */
  key: string;
  /** Agente del último intento (abre su transcript). */
  agentId: string;
  label: string;
  phase: string;
  status: WfAgentStatus;
  attempt: number;
  agentType: string | null;
  model: string | null;
  startedAt: number | null;
  lastAt: number | null;
  durationMs: number | null;
  contextTokens: number | null;
  toolCalls: number | null;
  lastActivity: string | null;
  resultPreview: string | null;
}

export interface WorkflowRun {
  runId: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  phases: WorkflowPhase[];
  agents: WorkflowAgent[];
  totalTokens: number | null;
  totalToolCalls: number | null;
  resultPreview: string | null;
  error: string | null;
}

export interface WorkflowEvent {
  id: SessionId;
  run: WorkflowRun;
}

// La anticipación final impide quedarse con los 77 primeros caracteres de un ID más largo.
const RUN_ID_RE = /Run ID: (wf_[A-Za-z0-9_-]{1,77})(?![A-Za-z0-9_-])/;
const VALID_RUN_ID = /^wf_[A-Za-z0-9_-]{1,77}$/;

/** runId de una llamada `Workflow`: del texto de su resultado o, al reanudar, de `resumeFromRunId`. */
export function runIdFromWorkflowTool(input: unknown, resultText: string | undefined): string | null {
  const m = resultText ? RUN_ID_RE.exec(resultText) : null;
  if (m) return m[1];
  const resume = input && typeof input === "object" ? (input as Record<string, unknown>).resumeFromRunId : undefined;
  return typeof resume === "string" && VALID_RUN_ID.test(resume) ? resume : null;
}

const NOTIFIED: Record<string, WorkflowStatus> = { completed: "completed", failed: "failed", killed: "killed", stopped: "stopped" };

type NotifiedIndex = ReadonlyMap<string, WorkflowStatus | null>;

const TOOL_USE_ID_RE = /<tool-use-id>([^<]*)<\/tool-use-id>/g;
const STATUS_RE = /<status>([a-z_]+)<\/status>/;

/** Índice por lista de mensajes: el store la sustituye entera cuando cambia. */
const notifiedCache = new WeakMap<readonly ChatMessage[], NotifiedIndex>();
/** Última lista indexada, para indexar solo lo añadido cuando llega otra que la extiende. */
let lastIndexed: { messages: readonly ChatMessage[]; index: NotifiedIndex } | null = null;

function extendsList(prev: readonly ChatMessage[], next: readonly ChatMessage[]): boolean {
  if (prev.length > next.length) return false;
  for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return false;
  return true;
}

/** Copia de `base` con las notificaciones de `messages[from..]`; la última de cada llamada manda. */
function indexFrom(messages: readonly ChatMessage[], from: number, base: NotifiedIndex | undefined): NotifiedIndex {
  const index = new Map(base);
  for (let i = from; i < messages.length; i++) {
    const m = messages[i];
    if (m.kind !== "taskNotification") continue;
    const text = m.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("\n");
    const st = STATUS_RE.exec(text)?.[1];
    const status = (st && NOTIFIED[st]) || null;
    for (const id of text.matchAll(TOOL_USE_ID_RE)) index.set(id[1], status);
  }
  return index;
}

/**
 * `toolUseId` → estado que anuncia su `<task-notification>` (el journal no
 * tiene evento de fin). Cada fila de `Workflow` lo consulta en cada cambio
 * del store: con la misma lista no se recorre otra vez y, si la lista nueva
 * extiende la anterior (mensajes que llegan en streaming), solo se indexa lo
 * añadido; cualquier otro cambio reconstruye el índice.
 */
export function notifiedIndex(messages: readonly ChatMessage[]): NotifiedIndex {
  const hit = notifiedCache.get(messages);
  if (hit) return hit;
  const prev = lastIndexed && extendsList(lastIndexed.messages, messages) ? lastIndexed : null;
  const index = indexFrom(messages, prev?.messages.length ?? 0, prev?.index);
  notifiedCache.set(messages, index);
  lastIndexed = { messages, index };
  return index;
}

/** Estado que anuncia la `<task-notification>` de la llamada `toolUseId`. */
export function notifiedStatus(messages: readonly ChatMessage[], toolUseId: string): WorkflowStatus | null {
  return notifiedIndex(messages).get(toolUseId) ?? null;
}

/** El estado del run, corregido por la notificación si el disco aún no tiene el final. */
export function effectiveStatus(run: WorkflowRun, notified: WorkflowStatus | null): WorkflowStatus {
  return run.status === "running" && notified ? notified : run.status;
}

/** Tiempo transcurrido: duración cerrada, o desde el inicio hasta `now` si sigue en marcha. */
export function elapsedMs(x: { startedAt: number | null; durationMs: number | null }, running: boolean, now: number): number | null {
  if (x.durationMs != null && !running) return x.durationMs;
  if (x.startedAt == null) return x.durationMs;
  return Math.max(0, now - x.startedAt);
}

export function formatElapsed(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Agentes terminados (hechos o reutilizados) frente a los vistos. */
export function runProgress(run: WorkflowRun): { done: number; failed: number; total: number } {
  const done = run.agents.filter((a) => a.status === "done" || a.status === "cached").length;
  const failed = run.agents.filter((a) => a.status === "failed").length;
  return { done, failed, total: run.agents.length };
}

/** Fase activa: la primera con agentes en marcha o, si no hay, la última con agentes. */
export function activePhase(run: WorkflowRun): number | null {
  const running = run.phases.find((p) => p.running > 0);
  if (running) return running.index;
  const seen = run.phases.filter((p) => p.total > 0);
  return run.status === "running" && seen.length > 0 ? seen[seen.length - 1].index : null;
}
