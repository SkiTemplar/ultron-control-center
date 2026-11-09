// Turnos de la línea de tiempo y su caché entre reconstrucciones: cada evento
// rehace la línea, pero un turno cuyos mensajes no han cambiado conserva su
// actividad y su gasto, y un elemento igual al anterior se reutiliza tal cual,
// así el `memo` de cada fila no se rompe por objetos recreados.

import { buildResultIndex, visibleMessages, type ToolResultBlock } from "./parse";
import type { ChatNote } from "./session-state";
import type { ChatMessage, EngineTask, TurnPayload } from "./types";
import type { TimelineItem, TurnActivity, TurnStats } from "./timeline";

export interface Turn {
  /** "inicio" o el uuid del prompt que lo abre. */
  key: string;
  start: number;
  /** Índice del primer mensaje del turno siguiente. */
  end: number;
  /** uuid de la primera y la última respuesta del asistente. */
  first?: string;
  last?: string;
  activity?: TurnActivity;
  stats?: TurnStats;
}

interface TurnMemo {
  refs: ChatMessage[];
  payloads: readonly TurnPayload[] | undefined;
  model: string | null | undefined;
  next: ChatMessage | undefined;
  turn: Turn;
}

export interface TimelineCache {
  turns: Map<string, TurnMemo>;
  /** Elementos de la reconstrucción anterior, en orden. */
  items: TimelineItem[];
  /** Mensajes y turnos de la reconstrucción anterior, con lo que los condiciona. */
  last: { messages: readonly ChatMessage[]; turns: Turn[]; payloads: readonly TurnPayload[] | undefined; model: string | null | undefined } | null;
  /** Notas e intervenciones con las que se construyeron `items`. */
  inputs: { notes: readonly ChatNote[] | undefined; tasks: readonly EngineTask[] } | null;
}

export function createTimelineCache(): TimelineCache {
  return { turns: new Map(), items: [], last: null, inputs: null };
}

/** Parte los mensajes en turnos desde `from` (que abre el turno `key`): cada prompt que abre turno empieza uno. */
export function splitTurns(messages: readonly ChatMessage[], opens: (m: ChatMessage) => boolean, from = 0, key0 = "inicio"): Turn[] {
  const out: Turn[] = [];
  let start = from;
  let key = key0;
  for (let i = from + (from > 0 ? 1 : 0); i < messages.length; i += 1) {
    if (!opens(messages[i])) continue;
    out.push({ key, start, end: i });
    start = i;
    key = messages[i].uuid;
  }
  out.push({ key, start, end: messages.length });
  return out;
}

/**
 * Turnos de la reconstrucción anterior que siguen valiendo tal cual: los que
 * acaban (y cuyo siguiente prompt está) antes del primer mensaje que cambió.
 * Con la cabeza movida (página anterior o cota) no se aprovecha ninguno.
 */
export function stableTurns(
  cache: TimelineCache | undefined, messages: readonly ChatMessage[],
  payloads: readonly TurnPayload[] | undefined, model: string | null | undefined,
): Turn[] {
  const last = cache?.last;
  if (!last || last.payloads !== payloads || last.model !== model) return [];
  const prev = last.messages;
  const n = Math.min(prev.length, messages.length);
  let diff = 0;
  while (diff < n && prev[diff] === messages[diff]) diff += 1;
  let k = 0;
  while (k < last.turns.length && last.turns[k].end < diff) k += 1;
  return last.turns.slice(0, k);
}

function sameRefs(memo: TurnMemo, messages: readonly ChatMessage[], t: Turn): boolean {
  if (memo.refs.length !== t.end - t.start) return false;
  for (let i = 0; i < memo.refs.length; i += 1) {
    if (memo.refs[i] !== messages[t.start + i]) return false;
  }
  return true;
}

/** El turno ya calculado si sus mensajes, el siguiente, los eventos `turn` y el modelo no han cambiado. */
export function cachedTurn(
  cache: TimelineCache | undefined, messages: readonly ChatMessage[], t: Turn,
  payloads: readonly TurnPayload[] | undefined, model: string | null | undefined,
): Turn | null {
  const memo = cache?.turns.get(t.key);
  if (!memo || memo.payloads !== payloads || memo.model !== model || memo.next !== messages[t.end]) return null;
  return sameRefs(memo, messages, t) ? { ...memo.turn, start: t.start, end: t.end } : null;
}

export function rememberTurn(
  cache: TimelineCache, messages: readonly ChatMessage[], t: Turn,
  payloads: readonly TurnPayload[] | undefined, model: string | null | undefined,
): void {
  cache.turns.set(t.key, { refs: messages.slice(t.start, t.end), payloads, model, next: messages[t.end], turn: t });
}

function sameList<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean): boolean {
  return a.length === b.length && a.every((x, i) => eq(x, b[i]));
}

export function sameActivity(a: TurnActivity | undefined, b: TurnActivity | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.tools !== b.tools || a.system !== b.system) return false;
  return sameList(a.toolIds, b.toolIds, (x, y) => x === y) && sameList(a.byName, b.byName, (x, y) => x[0] === y[0] && x[1] === y[1]);
}

export function sameStats(a: TurnStats | undefined, b: TurnStats | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.costUsd !== b.costUsd || a.subagents !== b.subagents) return false;
  const ua = a.usage as unknown as Record<string, unknown>;
  const ub = b.usage as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(ua), ...Object.keys(ub)]);
  return [...keys].every((k) => ua[k] === ub[k]);
}

function sameItem(a: TimelineItem, b: TimelineItem): boolean {
  if (a.kind === "engine" && b.kind === "engine") return a.task === b.task;
  if (a.kind === "note" && b.kind === "note") return a.note === b.note;
  if (a.kind !== "msg" || b.kind !== "msg") return false;
  return a.m === b.m && a.continued === b.continued && a.endsTurn === b.endsTurn && a.turn === b.turn
    && a.inTurn === b.inTurn && sameActivity(a.activity, b.activity) && sameStats(a.stats, b.stats);
}

/**
 * Sustituye cada elemento por el de la reconstrucción anterior si es igual y
 * renueva la caché. Casi siempre coinciden por posición (se añade al final); solo
 * si la cabeza cambió (página anterior, cota) se busca por clave.
 */
export function reuseItems(cache: TimelineCache | undefined, items: TimelineItem[], skip = 0): TimelineItem[] {
  if (!cache) return items;
  const prevList = cache.items;
  let byKey: Map<string, TimelineItem> | null = null;
  // Los `skip` primeros ya son los de la reconstrucción anterior: solo se recorre
  // el resto (antes, un `map` sobre toda la línea en cada evento). `out` es una
  // copia propia, así que sustituir en ella no toca la lista recibida.
  const out = items.slice();
  for (let i = skip; i < out.length; i += 1) {
    const it = out[i];
    let prev: TimelineItem | undefined = prevList[i];
    if (prev && prev.key !== it.key) {
      byKey ??= new Map(prevList.map((p) => [p.key, p]));
      prev = byKey.get(it.key);
    } else if (!prev && byKey) {
      prev = byKey.get(it.key);
    }
    if (prev && sameItem(prev, it)) out[i] = prev;
  }
  cache.items = out;
  return out;
}

/** Olvida los turnos que ya no están en la línea (sesión recortada o reiniciada). */
export function pruneTurns(cache: TimelineCache | undefined, turns: readonly Turn[]): void {
  if (!cache || cache.turns.size <= turns.length) return;
  const alive = new Set(turns.map((t) => t.key));
  for (const key of cache.turns.keys()) if (!alive.has(key)) cache.turns.delete(key);
}

/**
 * Derivados de un hilo que el chat rehace con cada evento `messages`: los
 * mensajes visibles y el índice de resultados de herramientas. Si la lista nueva
 * solo añade mensajes al final de la anterior (mismas referencias), se extienden
 * con lo nuevo en vez de recorrer todo el historial; si no añade nada visible ni
 * ningún resultado, se conservan los mismos objetos (y los `useMemo` que
 * dependen de ellos no se rehacen). Con 20.000 mensajes, de ~1,5 ms a ~0,05 ms por evento.
 */
export interface ThreadDerived {
  raw: readonly ChatMessage[];
  visible: ChatMessage[];
  results: Map<string, ToolResultBlock>;
}

export interface ThreadDerivedCache {
  last: ThreadDerived | null;
}

export function createThreadDerivedCache(): ThreadDerivedCache {
  return { last: null };
}

function extendsList(prev: readonly ChatMessage[], next: readonly ChatMessage[]): boolean {
  if (next.length < prev.length) return false;
  for (let i = 0; i < prev.length; i += 1) if (prev[i] !== next[i]) return false;
  return true;
}

function withResults(base: Map<string, ToolResultBlock>, added: readonly ChatMessage[]): Map<string, ToolResultBlock> {
  const fresh = buildResultIndex(added);
  if (fresh.size === 0) return base;
  const out = new Map(base);
  for (const [id, r] of fresh) out.set(id, r);
  return out;
}

export function deriveThread(cache: ThreadDerivedCache, raw: readonly ChatMessage[]): ThreadDerived {
  const prev = cache.last;
  if (prev && prev.raw === raw) return prev;
  let next: ThreadDerived;
  if (prev && extendsList(prev.raw, raw)) {
    const added = raw.slice(prev.raw.length);
    const shown = visibleMessages(added);
    next = { raw, visible: shown.length === 0 ? prev.visible : [...prev.visible, ...shown], results: withResults(prev.results, added) };
  } else {
    next = { raw, visible: visibleMessages(raw), results: buildResultIndex(raw) };
  }
  cache.last = next;
  return next;
}
