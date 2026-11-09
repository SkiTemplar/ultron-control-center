// Texto en vivo del puente (§5.3). Vive fuera del store principal: los deltas se
// acumulan y se publican una vez por fotograma, y solo se avisa al hilo afectado.
// Cada (turno, agente, paso, bloque) es una entrada distinta con su `streamKey`;
// la entrada sale por identidad (`stream-matched` o un mensaje con el mismo
// `streamKey`), nunca comparando texto. Sin pareja, sale 2 s después del fin del
// turno; el razonamiento sale con `stepDone` (el transcript lo trae vacío).
// Red de seguridad para puentes sin `streamKey` (protocolo 1): una entrada ya
// terminada cuyo texto es exactamente un bloque (o el último párrafo de un bloque)
// de una respuesta recibida del mismo hilo se retira; no hay cola de 80 caracteres.

import { useSyncExternalStore } from "react";
import { mergeStreamText } from "./parse";
import type { ChatMessage, SessionId, StreamPayload } from "./types";

export interface StreamEntry {
  /** `turnId:agentId|main:step:block`, la misma clave que `ChatMessage.streamKey`. */
  key: string;
  turnId: string;
  step: number;
  block: number;
  text: string;
  thinking: string;
  stepDone: boolean;
  done: boolean;
}

type ThreadKey = string;

/** Retardo con el que salen las entradas sin pareja tras el fin del turno. */
export const UNMATCHED_GRACE_MS = 2000;

export function threadKey(id: SessionId, agentId: string | null): ThreadKey {
  return `${id}::${agentId ?? ""}`;
}

export function entryKey(p: Pick<StreamPayload, "turnId" | "agentId" | "step" | "block">): string {
  return `${p.turnId}:${p.agentId ?? "main"}:${p.step}:${p.block}`;
}

/** Aplica un payload a una entrada; si la clave cambia (otro turno, paso o bloque), empieza de cero. */
export function applyStream(prev: StreamEntry | undefined, p: StreamPayload): StreamEntry {
  const key = entryKey(p);
  const base: StreamEntry = prev && prev.key === key ? prev : { key, turnId: p.turnId, step: p.step, block: p.block, text: "", thinking: "", stepDone: false, done: false };
  // El delta siempre viaja en `text`; `thinking` solo dice a qué bloque pertenece.
  const isThinking = p.thinking === true;
  return {
    ...base,
    text: isThinking ? base.text : mergeStreamText(base.text, p.text),
    thinking: isThinking ? mergeStreamText(base.thinking, p.text) : base.thinking,
    stepDone: base.stepDone || Boolean(p.stepDone),
    done: base.done || p.done,
  };
}

/**
 * Fin de turno del puente (`turnEnd` en `puente_aplicar.rs`): llega con `done` y
 * sin `step` ni `block`, así que no designa ninguna entrada concreta.
 */
export function isTurnEnd(p: StreamPayload): boolean {
  return p.done && (typeof p.step !== "number" || typeof p.block !== "number");
}

/** Marca como terminadas las entradas del turno; con `turnId` vacío, todas las del hilo. Conserva las referencias que no cambian. */
export function markTurnDone(list: readonly StreamEntry[], turnId: string): StreamEntry[] {
  const hits = (e: StreamEntry) => !e.done && (!turnId || e.turnId === turnId);
  if (!list.some(hits)) return list as StreamEntry[];
  return list.map((e) => (hits(e) ? { ...e, done: true } : e));
}

/** Aplica un payload a las entradas de un hilo. Puro: cada (paso, bloque) es una entrada; nunca concatena entre pasos. */
export function applyStreamList(list: readonly StreamEntry[], p: StreamPayload): StreamEntry[] {
  if (isTurnEnd(p)) return markTurnDone(list, p.turnId);
  if (p.stepDone) return markStepDone(list, p.turnId, p.step);
  const applied = applyBlock(list, p);
  // Cualquier `done` cierra el turno entero, no solo el bloque que lo trae.
  return p.done ? markTurnDone(applied, p.turnId) : applied;
}

/**
 * `stepEnd` cierra el paso entero: llega con `block` 0, pero el texto suele ir
 * en otro bloque (el razonamiento ocupa el 0). Sin esto, el texto del paso se
 * quedaba con el cursor y el razonamiento con «en curso».
 */
export function markStepDone(list: readonly StreamEntry[], turnId: string, step: number): StreamEntry[] {
  const hits = (e: StreamEntry) => e.turnId === turnId && e.step === step && (!e.stepDone || Boolean(e.thinking));
  if (!list.some(hits)) return list as StreamEntry[];
  return list.flatMap((e) => {
    if (!hits(e)) return [e];
    // Con `stepDone`, el razonamiento sobra: en la familia 5.5 el transcript lo trae vacío.
    const next = { ...e, stepDone: true, thinking: "" };
    return next.text ? [next] : [];
  });
}

function applyBlock(list: readonly StreamEntry[], p: StreamPayload): StreamEntry[] {
  const key = entryKey(p);
  const prev = list.find((e) => e.key === key);
  const next = applyStream(prev, p);
  // Con `stepDone`, el razonamiento sobra: en la familia 5.5 el transcript lo trae vacío.
  const visible = next.stepDone ? { ...next, thinking: "" } : next;
  const settled = visible.text || visible.thinking ? visible : null;
  const rest = list.filter((e) => e.key !== key);
  if (!settled) return rest;
  return prev ? list.map((e) => (e.key === key ? settled : e)) : [...rest, settled];
}

export function withoutKeys(list: readonly StreamEntry[], keys: ReadonlySet<string>): StreamEntry[] {
  return list.filter((e) => !keys.has(e.key));
}

/** Quita las entradas de los turnos dados (uno o varios). */
export function withoutTurn(list: readonly StreamEntry[], turnId: string | ReadonlySet<string>): StreamEntry[] {
  const drop = typeof turnId === "string" ? new Set([turnId]) : turnId;
  const kept = list.filter((e) => !drop.has(e.turnId));
  return kept.length === list.length ? (list as StreamEntry[]) : kept;
}

const threads = new Map<ThreadKey, StreamEntry[]>();
const listeners = new Map<ThreadKey, Set<() => void>>();
const EMPTY: StreamEntry[] = [];
let pending: StreamPayload[] = [];
let frame: number | null = null;

const schedule: (cb: () => void) => number =
  typeof requestAnimationFrame === "function" ? (cb) => requestAnimationFrame(cb) : (cb) => window.setTimeout(cb, 16);

function notify(key: ThreadKey): void {
  listeners.get(key)?.forEach((l) => l());
}

function setThread(key: ThreadKey, list: StreamEntry[]): void {
  const prev = threads.get(key) ?? EMPTY;
  if (list.length === prev.length && list.every((e, i) => e === prev[i])) return;
  if (list.length === 0) threads.delete(key);
  else threads.set(key, list);
  notify(key);
}

/** Claves ya persistidas que aún no han llegado al hilo (el mensaje se adelantó al delta). */
const matched = new Set<string>();
const MATCHED_MAX = 2000;

/** ¿El texto de una entrada terminada ya está en el transcript? Bloque exacto o último párrafo de un bloque. */
export function isPersisted(text: string, messages: readonly ChatMessage[]): boolean {
  const t = text.trimEnd();
  if (!t.trim()) return false;
  // Las 6 últimas respuestas, buscadas desde el final: no se recorre todo el hilo por delta.
  const recent: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && recent.length < 6; i -= 1) {
    if (messages[i].role === "assistant") recent.push(messages[i]);
  }
  return recent.some((m) => m.blocks.some((b) => b.kind === "text" && (b.text.trimEnd() === t || b.text.trimEnd().endsWith(`\n\n${t}`))));
}

/** Mensajes ya recibidos de un hilo (los da el store; se inyecta para no acoplar). */
let messagesOf: (id: SessionId, agentId: string | null) => readonly ChatMessage[] = () => [];

export function setMessagesSource(fn: typeof messagesOf): void {
  messagesOf = fn;
}

function dropPersisted(id: SessionId, agentId: string | null, list: StreamEntry[]): StreamEntry[] {
  const done = list.filter((e) => e.done && isPersisted(e.text, messagesOf(id, agentId)));
  return done.length === 0 ? list : withoutKeys(list, new Set(done.map((e) => e.key)));
}

function flush(): void {
  frame = null;
  const batch = pending;
  pending = [];
  for (const p of batch) {
    if (isTurnEnd(p)) {
      endTurn(p);
      continue;
    }
    const key = threadKey(p.id, p.agentId);
    if (matched.has(entryKey(p))) continue;
    setThread(key, dropPersisted(p.id, p.agentId, applyStreamList(threads.get(key) ?? EMPTY, p)));
    if (p.done) scheduleTurnCleanup(p.id, p.turnId);
  }
}

/** Hilo de un `threadKey` (`id::agentId`, vacío para el principal). */
function agentOfThread(key: ThreadKey, id: SessionId): string | null {
  return key.slice(id.length + 2) || null;
}

/**
 * Fin de turno: marca `done` las entradas del turno y retira las que ya están en
 * el transcript. El del hilo principal cierra también los subagentes de ese turno.
 */
function endTurn(p: StreamPayload): void {
  const own = threadKey(p.id, p.agentId);
  for (const [key, list] of [...threads]) {
    if (key !== own && (p.agentId !== null || !key.startsWith(`${p.id}::`))) continue;
    setThread(key, dropPersisted(p.id, agentOfThread(key, p.id), markTurnDone(list, p.turnId)));
  }
  scheduleTurnCleanup(p.id, p.turnId);
}

/** Con la ventana oculta no hay fotogramas (rAF congelado): se vacía con un temporizador. */
export const HIDDEN_FLUSH_MS = 250;
/** Deltas pendientes a partir de los cuales se vacía en el acto, haya fotograma o no. */
export const PENDING_MAX = 500;
let frameIsTimer = false;

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function cancelFrame(): void {
  if (frame === null) return;
  if (frameIsTimer) window.clearTimeout(frame);
  else if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
  frame = null;
}

export function pushStream(p: StreamPayload): void {
  pending.push(p);
  if (pending.length >= PENDING_MAX) {
    cancelFrame();
    flush();
    return;
  }
  if (frame !== null) return;
  const hidden = isHidden();
  frameIsTimer = hidden || typeof requestAnimationFrame !== "function";
  frame = hidden ? window.setTimeout(flush, HIDDEN_FLUSH_MS) : schedule(flush);
}

// Un fotograma pedido justo antes de ocultarse no llegaría hasta volver: se pasa a temporizador.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!isHidden() || frame === null || frameIsTimer) return;
    cancelFrame();
    frameIsTimer = true;
    frame = window.setTimeout(flush, HIDDEN_FLUSH_MS);
  });
}

/** Quita la entrada con esa clave en cualquier hilo de la sesión (`stream-matched`). */
export function matchStream(id: SessionId, streamKey: string): void {
  if (matched.size > MATCHED_MAX) matched.clear();
  matched.add(streamKey);
  for (const [key, list] of threads) {
    if (!key.startsWith(`${id}::`)) continue;
    setThread(key, withoutKeys(list, new Set([streamKey])));
  }
}

/** Los mensajes definitivos retiran su entrada en vivo: por `streamKey` o, sin él, por la red de seguridad. */
export function matchMessages(id: SessionId, messages: readonly ChatMessage[]): void {
  messages.forEach((m) => m.streamKey && matchStream(id, m.streamKey));
  for (const agentId of new Set(messages.filter((m) => m.role === "assistant" && !m.streamKey).map((m) => m.agentId))) {
    const key = threadKey(id, agentId);
    const list = threads.get(key);
    if (list) setThread(key, dropPersisted(id, agentId, list));
  }
}

/** Turnos con texto en vivo en algún hilo de la sesión. */
function liveTurns(id: SessionId): Set<string> {
  const turns = new Set<string>();
  for (const [key, list] of threads) if (key.startsWith(`${id}::`)) list.forEach((e) => turns.add(e.turnId));
  return turns;
}

/**
 * Fin del turno: lo que siga sin pareja (texto de un turno interrumpido) sale a los 2 s.
 * Un turno cerrado sin `turnId` (red, reconciliación o relleno) vale por todos los
 * que había en vivo al cerrarse, igual que en `markTurnDone`; el que empiece
 * después no se toca.
 */
export function scheduleTurnCleanup(id: SessionId, turnId: string, delayMs = UNMATCHED_GRACE_MS): void {
  const turns: ReadonlySet<string> = turnId ? new Set([turnId]) : liveTurns(id);
  if (turns.size === 0) return;
  window.setTimeout(() => {
    for (const [key, list] of threads) {
      if (key.startsWith(`${id}::`)) setThread(key, withoutTurn(list, turns));
    }
  }, delayMs);
}

/** Vacía el texto en vivo de una sesión (cambio de conversación o sesión terminada). */
export function clearSessionStream(id: SessionId): void {
  // Los deltas aún sin publicar en este fotograma son de la conversación anterior.
  pending = pending.filter((p) => p.id !== id);
  for (const key of [...threads.keys()]) if (key.startsWith(`${id}::`)) setThread(key, EMPTY);
}

export function getStreamEntries(id: SessionId, agentId: string | null): readonly StreamEntry[] {
  return threads.get(threadKey(id, agentId)) ?? EMPTY;
}

/** Última entrada del hilo (la que se está escribiendo), o `undefined` si no hay texto en vivo. */
export function getStream(id: SessionId, agentId: string | null): StreamEntry | undefined {
  const list = threads.get(threadKey(id, agentId));
  return list?.[list.length - 1];
}

function subscribe(key: ThreadKey, l: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  set.add(l);
  listeners.set(key, set);
  return () => set.delete(l);
}

export function useStream(id: SessionId | null, agentId: string | null): readonly StreamEntry[] {
  const key = id ? threadKey(id, agentId) : "";
  return useSyncExternalStore(
    (l) => subscribe(key, l),
    () => (key ? threads.get(key) ?? EMPTY : EMPTY),
  );
}

/** Solo para tests: estado limpio entre casos. */
export function resetStreamsForTests(): void {
  threads.clear();
  matched.clear();
  pending = [];
  cancelFrame();
}
