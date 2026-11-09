// Línea de tiempo del chat: mensajes del transcript, intervenciones de otros
// motores y notas del cliente, agrupados por turnos para poder plegar la
// actividad (herramientas, razonamiento y avisos del sistema) de cada uno.
// Pura, para poder probarla.

import { visibleInChat } from "./auto-review-core";
import { isToolResultOnly } from "./parse";
import { addUsage, costOf, ZERO_USAGE } from "./pricing";
import type { ChatNote } from "./session-state";
import { cachedTurn, pruneTurns, rememberTurn, reuseItems, splitTurns, stableTurns, type TimelineCache, type Turn } from "./timeline-turns";
import type { ChatMessage, EngineTask, SessionId, TurnPayload, Usage } from "./types";

export { createThreadDerivedCache, createTimelineCache, deriveThread, type ThreadDerived, type ThreadDerivedCache, type TimelineCache } from "./timeline-turns";

/** Tokens y coste aproximado de un turno (todas sus respuestas). */
export interface TurnStats {
  usage: Usage;
  /** USD; `null` si ninguna respuesta tiene modelo con precio. */
  costUsd: number | null;
  /** Coste de los subagentes incluido en `costUsd` (R17). */
  subagents?: number;
}

/** Herramientas usadas en un turno: total, recuento por nombre e ids. */
export interface TurnActivity {
  tools: number;
  byName: [string, number][];
  toolIds: string[];
  /** Mensajes del sistema del turno (interrupciones, avisos) integrados en la línea. */
  system?: number;
}

export type TimelineItem =
  | {
      kind: "msg";
      key: string;
      m: ChatMessage;
      continued: boolean;
      endsTurn: boolean;
      /** Clave del turno (uuid del prompt que lo abre). */
      turn: string;
      /** Solo en la primera respuesta del turno: lo que hizo en todo el turno. */
      activity?: TurnActivity;
      /** Solo en la última respuesta del turno: tokens y gasto del turno. */
      stats?: TurnStats;
      /** Mensaje del sistema dentro de un turno: se pliega con la actividad. */
      inTurn?: boolean;
    }
  | { kind: "engine"; key: string; task: EngineTask }
  | { kind: "note"; key: string; note: ChatNote };

export interface TimelineOptions {
  /** El último turno sigue abierto (sesión trabajando o esperando). */
  lastTurnOpen?: boolean;
  notes?: readonly ChatNote[];
  /** Turnos cerrados del puente, con su `usage` y el de sus subagentes. */
  turns?: readonly TurnPayload[];
  /** Modelo de la sesión para valorar el `usage` del puente. */
  model?: string | null;
  /** Caché entre reconstrucciones del mismo hilo (`createTimelineCache`): turnos y elementos sin cambios se reutilizan. */
  cache?: TimelineCache;
}

export interface TimelineParts {
  items: TimelineItem[];
  /** Intervenciones del turno en curso: van después de la burbuja en vivo (§5.6). */
  pendingEngines: EngineTask[];
}

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Intervenciones de la sesión que siguen en el hilo, por hora de inicio. */
export function sessionTasks(tasks: readonly EngineTask[], sessionId: SessionId, dismissed: readonly string[]): EngineTask[] {
  return tasks
    .filter((t) => t.sessionId === sessionId && t.kind !== "chat" && !dismissed.includes(t.id) && visibleInChat(t))
    .sort((a, b) => time(a.startedAt) - time(b.startedAt));
}

const INTERRUPTED = /^\[Request interrupted by user/;

function plainText(m: ChatMessage): string {
  return m.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("").trim();
}

/** Prompt escrito por una persona que abre turno (§5.1): ni resultados, ni comandos, ni absorbidos. */
export function opensTurn(m: ChatMessage): boolean {
  if (m.role !== "user" || m.queued || isToolResultOnly(m)) return false;
  if (m.kind && m.kind !== "prompt") return false;
  return !INTERRUPTED.test(plainText(m));
}

function isSystemish(m: ChatMessage): boolean {
  return m.role === "system" || m.kind === "interrupted" || m.kind === "taskNotification" || m.kind === "compactSummary";
}

function activityOf(messages: readonly ChatMessage[], from = 0, to = messages.length): TurnActivity {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const toolIds: string[] = [];
  let system = 0;
  for (let i = from; i < to; i += 1) {
    const m = messages[i];
    if (isSystemish(m)) system += 1;
    if (m.role !== "assistant") continue;
    for (const b of m.blocks) {
      if (b.kind !== "toolUse" || seen.has(b.id)) continue;
      counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
      seen.add(b.id);
      toolIds.push(b.id);
    }
  }
  const byName = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return system > 0 ? { tools: toolIds.length, byName, toolIds, system } : { tools: toolIds.length, byName, toolIds };
}

/** Índice del último prompt que abre turno, buscando hacia atrás (0 si no hay). */
function lastPromptIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i > 0; i -= 1) {
    if (opensTurn(messages[i])) return i;
  }
  return 0;
}

/** El turno en curso ya tiene algún mensaje de Claude en el transcript (y con él su cabecera). */
export function turnHasReply(messages: readonly ChatMessage[]): boolean {
  return messages.slice(lastPromptIndex(messages) + 1).some((m) => m.role === "assistant");
}

/** Actividad del turno en curso: ids distintos tras el último prompt más los vivos no persistidos (F14). */
export function currentTurnActivity(messages: readonly ChatMessage[], live: readonly { toolUseId: string; name: string; agentId: string | null }[]): TurnActivity {
  const base = activityOf(messages, lastPromptIndex(messages));
  const known = new Set(base.toolIds);
  const extra = live.filter((t) => t.agentId === null && !known.has(t.toolUseId));
  if (extra.length === 0) return base;
  const counts = new Map(base.byName);
  extra.forEach((t) => counts.set(t.name, (counts.get(t.name) ?? 0) + 1));
  const byName = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { ...base, tools: base.tools + extra.length, byName, toolIds: [...base.toolIds, ...extra.map((t) => t.toolUseId)] };
}

export function statsOf(messages: readonly ChatMessage[]): TurnStats {
  let usage = ZERO_USAGE;
  let cost: number | null = null;
  for (const m of messages) {
    if (m.role !== "assistant" || !m.usage) continue;
    usage = addUsage(usage, m.usage);
    const c = costOf(m.model, m.usage);
    if (c !== null) cost = (cost ?? 0) + c;
  }
  return { usage, costUsd: cost };
}

/**
 * Tokens y gasto de un turno del puente: principal más subagentes (USO-01,
 * R17). Cada subagente se valora con su modelo; con el de la sesión solo si
 * no viene (un Sonnet 5.5 en una sesión Opus 5.5 cuesta la mitad).
 */
export function statsOfTurn(p: TurnPayload, model: string | null | undefined): TurnStats | null {
  if (!p.usage && !p.subagentUsage?.length) return null;
  let usage = p.usage ?? ZERO_USAGE;
  let cost = p.usage ? costOf(model, p.usage) : null;
  let subagents = 0;
  for (const u of p.subagentUsage ?? []) {
    usage = addUsage(usage, u);
    const c = costOf(u.model || model, u);
    if (c !== null) {
      cost = (cost ?? 0) + c;
      subagents += c;
    }
  }
  return { usage, costUsd: cost, subagents };
}

function turnIdOf(messages: readonly ChatMessage[]): string | null {
  for (const m of messages) {
    if (m.streamKey) return m.streamKey.split(":")[0] ?? null;
  }
  return null;
}

/** El `turn` del puente de un turno: por el `turnId` del `streamKey` o, si no, por hora. */
export function payloadFor(turn: readonly ChatMessage[], next: ChatMessage | undefined, turns: readonly TurnPayload[]): TurnPayload | null {
  if (turns.length === 0 || turn.length === 0) return null;
  const id = turnIdOf(turn);
  if (id) {
    const byId = turns.find((t) => t.turnId === id);
    if (byId) return byId;
  }
  const from = time(turn[0].timestamp) - 5000;
  const to = next ? time(next.timestamp) : Number.POSITIVE_INFINITY;
  return turns.find((t) => time(t.startedAt) >= from && time(t.startedAt) < to) ?? null;
}

/** Actividad y gasto de un turno (en su primera y su última respuesta). */
function computeTurn(t: Turn, messages: readonly ChatMessage[], opts: TimelineOptions): Turn {
  let first: ChatMessage | undefined;
  let last: ChatMessage | undefined;
  for (let i = t.start; i < t.end; i += 1) {
    if (messages[i].role !== "assistant") continue;
    first ??= messages[i];
    last = messages[i];
  }
  if (!first || !last) return t;
  const turn = messages.slice(t.start, t.end);
  const payload = payloadFor(turn, messages[t.end], opts.turns ?? []);
  const stats = (payload && statsOfTurn(payload, last.model ?? opts.model)) ?? statsOf(turn);
  return { ...t, first: first.uuid, last: last.uuid, activity: activityOf(messages, t.start, t.end), stats };
}

/** Turnos del hilo y desde qué mensaje cambian; los que no han cambiado salen de la caché con sus mismos objetos. */
function turnsOf(messages: readonly ChatMessage[], opts: TimelineOptions): { turns: Turn[]; from: number } {
  const kept = stableTurns(opts.cache, messages, opts.turns, opts.model);
  const from = kept.length > 0 ? kept[kept.length - 1].end : 0;
  const rest = splitTurns(messages, opensTurn, from, from > 0 ? messages[from].uuid : "inicio").map((t) => {
    const hit = cachedTurn(opts.cache, messages, t, opts.turns, opts.model);
    if (hit) return hit;
    const done = computeTurn(t, messages, opts);
    if (opts.cache) rememberTurn(opts.cache, messages, done, opts.turns, opts.model);
    return done;
  });
  const turns = kept.length > 0 ? [...kept, ...rest] : rest;
  if (opts.cache) opts.cache.last = { messages, turns, payloads: opts.turns, model: opts.model };
  pruneTurns(opts.cache, turns);
  return { turns, from };
}

/** Fin del turno de cada mensaje ancla de las intervenciones. */
function anchorEnds(tasks: readonly EngineTask[], messages: readonly ChatMessage[], turns: readonly Turn[]): Map<string, number> {
  const anchors = new Set(tasks.map((t) => t.anchorMessageUuid).filter((u): u is string => Boolean(u)));
  const ends = new Map<string, number>();
  if (anchors.size === 0) return ends;
  for (const t of turns) {
    for (let i = t.start; i < t.end; i += 1) if (anchors.has(messages[i].uuid)) ends.set(messages[i].uuid, t.end);
  }
  return ends;
}

/** Índice de inserción de cada intervención: al final del turno de su ancla o del de su hora. */
function engineSlots(tasks: readonly EngineTask[], messages: readonly ChatMessage[], turns: readonly Turn[]): Map<number, EngineTask[]> {
  const ends = anchorEnds(tasks, messages, turns);
  const slots = new Map<number, EngineTask[]>();
  for (const task of tasks) {
    const anchored = task.anchorMessageUuid ? ends.get(task.anchorMessageUuid) : undefined;
    const next = anchored ?? messages.findIndex((m) => opensTurn(m) && time(m.timestamp) >= time(task.startedAt));
    const at = next === -1 ? messages.length : next;
    slots.set(at, [...(slots.get(at) ?? []), task]);
  }
  return slots;
}

function msgItem(m: ChatMessage, prev: TimelineItem | undefined, t: Turn): Extract<TimelineItem, { kind: "msg" }> {
  const continued = m.role === "assistant" && prev?.kind === "msg" && prev.m.role === "assistant";
  const inTurn = isSystemish(m) && t.key !== "inicio" ? true : undefined;
  const activity = m.uuid === t.first ? t.activity : undefined;
  const stats = m.uuid === t.last ? t.stats : undefined;
  return { kind: "msg", key: m.uuid, m, continued, endsTurn: stats !== undefined, turn: t.key, activity, stats, inTurn };
}

/** Punto desde el que se sigue construyendo: elementos ya hechos, notas emitidas y último mensaje visible. */
interface Cursor {
  out: TimelineItem[];
  /** Índice del primer mensaje que falta por recorrer. */
  from: number;
  notes: number;
  lastVisible: TimelineItem | undefined;
}

const START: Cursor = { out: [], from: 0, notes: 0, lastVisible: undefined };

/**
 * Elementos de la reconstrucción anterior que siguen valiendo: todo hasta el
 * mensaje anterior a `from` (primer turno que cambió), si las notas y las
 * intervenciones son las mismas.
 */
function resumeFrom(opts: TimelineOptions, tasks: readonly EngineTask[], messages: readonly ChatMessage[], from: number, sorted: readonly ChatNote[]): Cursor {
  const cache = opts.cache;
  if (!cache || from === 0 || cache.inputs?.notes !== opts.notes || cache.inputs?.tasks !== tasks) return START;
  const key = messages[from - 1].uuid;
  let idx = cache.items.length - 1;
  while (idx >= 0 && cache.items[idx].key !== key) idx -= 1;
  if (idx < 0) return START;
  const out = cache.items.slice(0, idx + 1);
  // Las notas salen en el orden de `sorted`: las ya emitidas son hasta la última
  // nota de `out`. Sin notas no se recorre la línea (antes, un bucle entero por evento).
  let notes = 0;
  for (let j = out.length - 1; j >= 0 && sorted.length > 0; j -= 1) {
    const it = out[j];
    if (it.kind !== "note") continue;
    notes = sorted.indexOf(it.note) + 1;
    break;
  }
  let lastVisible: TimelineItem | undefined;
  for (let j = out.length - 1; j >= 0 && !lastVisible; j -= 1) {
    const it = out[j];
    if (it.kind === "msg" && !it.inTurn) lastVisible = it;
  }
  return { out, from, notes, lastVisible };
}

/**
 * Coloca cada intervención al cierre del turno de su ancla (o del turno en que se
 * lanzó), nunca entre las llamadas de un turno; las del turno abierto salen en
 * `pendingEngines`. `continued` se calcula sobre lo visible: los avisos del sistema
 * dentro de un turno no cortan la respuesta. Con `opts.cache`, solo se rehace
 * desde el primer turno que cambió y los elementos sin cambios conservan sus
 * objetos (el `memo` de cada fila aguanta).
 */
export function buildTimelineParts(messages: readonly ChatMessage[], tasks: readonly EngineTask[], opts: TimelineOptions = {}): TimelineParts {
  const { turns, from } = turnsOf(messages, opts);
  const slots = engineSlots(tasks, messages, turns);
  const pendingEngines = opts.lastTurnOpen ? [...slots.entries()].filter(([at]) => at >= messages.length).flatMap(([, list]) => list) : [];
  const notes = [...(opts.notes ?? [])].sort((a, b) => time(a.at) - time(b.at));
  const cursor = resumeFrom(opts, tasks, messages, from, notes);
  const out = cursor.out === START.out ? [] : cursor.out;
  const reused = out.length;
  let n = cursor.notes;
  let lastVisible = cursor.lastVisible;
  let ti = 0;
  const pushEngines = (at: number) => {
    for (const t of slots.get(at) ?? []) if (!pendingEngines.includes(t)) out.push({ kind: "engine", key: `e:${t.id}`, task: t });
  };
  for (let i = cursor.from; i < messages.length; i += 1) {
    const m = messages[i];
    pushEngines(i);
    for (; n < notes.length && time(notes[n].at) < time(m.timestamp); n += 1) out.push({ kind: "note", key: `n:${notes[n].id}`, note: notes[n] });
    while (i >= turns[ti].end) ti += 1;
    const item = msgItem(m, lastVisible, turns[ti]);
    out.push(item);
    if (!item.inTurn) lastVisible = item;
  }
  pushEngines(messages.length);
  for (; n < notes.length; n += 1) out.push({ kind: "note", key: `n:${notes[n].id}`, note: notes[n] });
  if (opts.cache) opts.cache.inputs = { notes: opts.notes, tasks };
  return { items: reuseItems(opts.cache, out, reused), pendingEngines };
}

/** Compatibilidad: la línea entera, con las intervenciones pendientes al final. */
export function buildTimeline(messages: readonly ChatMessage[], tasks: readonly EngineTask[], opts: TimelineOptions = {}): TimelineItem[] {
  const parts = buildTimelineParts(messages, tasks, opts);
  return [...parts.items, ...parts.pendingEngines.map((t) => ({ kind: "engine" as const, key: `e:${t.id}`, task: t }))];
}

const BROUGHT = /^(Resultado|Segunda opinión) de (Codex|Gemini) \(/;

/** Cabecera del mensaje que «Traer a Claude» pega en la sesión, si lo es. */
export function broughtHeader(text: string): string | null {
  const m = BROUGHT.exec(text);
  return m ? `${m[1]} de ${m[2]}` : null;
}

/** Texto plano de la respuesta del asistente (para copiar o pedir segunda opinión). */
export function messageText(m: ChatMessage): string {
  return m.blocks
    .filter((b): b is Extract<ChatMessage["blocks"][number], { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}
