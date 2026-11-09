// Eco optimista de lo enviado (§5.2, VEL-01): el prompt se pinta al momento con
// su `clientId` y desaparece por identidad cuando llega el mensaje del transcript
// con ese `clientId` o con el `messageUuid` que la cola le asignó (un envío
// entregado por orden empareja con un mensaje que no lleva `clientId`). La cola
// del backend dice en qué punto está cada envío. Puro, para poder probarlo.

import type { ChatMessage, QueueItem } from "./types";

export type EchoState = "pending" | "cliQueued" | "absorbed";

export interface Echo {
  clientId: string;
  text: string;
  attachments: string[];
  /** ISO del envío. */
  at: string;
  state: EchoState;
  /** Ya apareció en una instantánea de la cola: si sale de ella, el eco sobra. */
  seen: boolean;
  /** `uuid` del mensaje del transcript con el que la cola emparejó el envío. */
  messageUuid?: string;
}

const ECHO_OF: Partial<Record<QueueItem["state"], EchoState>> = {
  sending: "pending",
  cliQueued: "cliQueued",
  absorbed: "absorbed",
  delivered: "absorbed",
};

function delivered(messages: readonly ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) if (m.clientId) ids.add(m.clientId);
  return ids;
}

/** El mensaje definitivo del eco ya está en el hilo: por `clientId` o por el `messageUuid` de la cola. */
function arrived(e: Pick<Echo, "clientId" | "messageUuid">, done: ReadonlySet<string>, uuids: ReadonlySet<string>): boolean {
  return done.has(e.clientId) || (e.messageUuid !== undefined && uuids.has(e.messageUuid));
}

const uuidsOf = (messages: readonly ChatMessage[]): Set<string> => new Set(messages.map((m) => m.uuid));

/** Margen entre la hora del envío y la que el transcript pone al prompt (relojes y redondeos). */
export const TEXT_MATCH_SKEW_MS = 2000;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface PromptSlot {
  text: string;
  at: number;
}

/** Prompts del usuario sin `clientId` (los del historial): la única pareja posible es por texto. */
function anonymousPrompts(messages: readonly ChatMessage[]): PromptSlot[] {
  const out: PromptSlot[] = [];
  for (const m of messages) {
    if (m.role !== "user" || m.clientId) continue;
    const text = normalizeText(m.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("\n"));
    if (text) out.push({ text, at: Date.parse(m.timestamp) });
  }
  return out;
}

/**
 * Envíos cuyo prompt ya está en el hilo aunque el mensaje no traiga `clientId`
 * (historial). Emparejado uno a uno, del envío más antiguo al más reciente, y
 * solo con prompts escritos después del envío: un prompt repetido de verdad
 * (el del hilo es anterior) o un segundo envío idéntico sin su mensaje siguen
 * como eco. Sin fechas válidas no se empareja.
 */
export function pairedByText(sends: readonly Pick<Echo, "clientId" | "text" | "at">[], messages: readonly ChatMessage[]): Set<string> {
  const paired = new Set<string>();
  const pool = anonymousPrompts(messages);
  if (pool.length === 0) return paired;
  const used = new Set<number>();
  const ordered = [...sends].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const send of ordered) {
    const sentAt = Date.parse(send.at);
    const text = normalizeText(send.text);
    if (Number.isNaN(sentAt) || !text) continue;
    const at = pool.findIndex((p, i) => !used.has(i) && p.text === text && p.at >= sentAt - TEXT_MATCH_SKEW_MS);
    if (at === -1) continue;
    used.add(at);
    paired.add(send.clientId);
  }
  return paired;
}

/** Alta idempotente por `clientId`. */
export function addEcho(list: readonly Echo[], echo: Omit<Echo, "seen" | "state"> & { state?: EchoState }): Echo[] {
  if (list.some((e) => e.clientId === echo.clientId)) return list as Echo[];
  return [...list, { state: "pending", ...echo, seen: false }];
}

export function dropEcho(list: readonly Echo[], clientId: string): Echo[] {
  return list.some((e) => e.clientId === clientId) ? list.filter((e) => e.clientId !== clientId) : (list as Echo[]);
}

/** Quita los ecos cuyo mensaje definitivo ya llegó: mismo `clientId` o `messageUuid` o, sin ellos (historial), mismo prompt. */
export function absorbEchoes(list: readonly Echo[], messages: readonly ChatMessage[]): Echo[] {
  if (list.length === 0) return list as Echo[];
  const done = delivered(messages);
  const uuids = uuidsOf(messages);
  const pending = list.filter((e) => !arrived(e, done, uuids));
  const byText = pairedByText(pending, messages);
  const next = byText.size === 0 ? pending : pending.filter((e) => !byText.has(e.clientId));
  return next.length === list.length ? (list as Echo[]) : next;
}

function echoFromItem(item: QueueItem, state: EchoState): Echo {
  const echo: Echo = { clientId: item.clientId, text: item.text, attachments: item.attachments, at: item.sentAt ?? item.createdAt, state, seen: true };
  return item.messageUuid ? { ...echo, messageUuid: item.messageUuid } : echo;
}

/**
 * Reconcilia los ecos con la instantánea de la cola: lo escrito aparece como eco,
 * lo que sigue en cola o falló vive en el panel de la cola (no como eco), y un
 * eco que ya estuvo en la cola y desapareció de ella sin mensaje sobra.
 * `retired`: envíos de una conversación anterior (/clear) que la cola aún retiene.
 */
export function reconcileEchoes(
  list: readonly Echo[], items: readonly QueueItem[], messages: readonly ChatMessage[], retired: ReadonlySet<string> = NO_RETIRED,
): Echo[] {
  const done = new Set([...delivered(messages), ...retired]);
  const uuids = uuidsOf(messages);
  const byId = new Map(items.map((i) => [i.clientId, i]));
  const kept: Echo[] = [];
  for (const e of list) {
    const item = byId.get(e.clientId);
    if (done.has(e.clientId)) continue;
    if (!item) {
      if (!e.seen) kept.push(e);
      continue;
    }
    const state = ECHO_OF[item.state];
    const next: Echo = { ...e, state: state ?? e.state, seen: true, ...(item.messageUuid ? { messageUuid: item.messageUuid } : {}) };
    if (state && !arrived(next, done, uuids)) kept.push(next);
  }
  for (const item of items) {
    const state = ECHO_OF[item.state];
    if (!state || item.origin !== "ultron" || done.has(item.clientId)) continue;
    if (item.messageUuid && uuids.has(item.messageUuid)) continue;
    if (!kept.some((e) => e.clientId === item.clientId)) kept.push(echoFromItem(item, state));
  }
  const byText = pairedByText(kept, messages);
  return kept.filter((e) => !byText.has(e.clientId)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const NO_RETIRED: ReadonlySet<string> = new Set();

/** Estados de la cola cuyo prompt ya entró en la conversación: tras un reset no deben volver como eco. */
const SETTLED: ReadonlySet<QueueItem["state"]> = new Set(["absorbed", "delivered"]);

/** Envíos que un reset deja atrás: los ya entregados a la conversación que se cierra. */
export function retireSettled(prev: readonly string[], items: readonly QueueItem[]): string[] {
  const fresh = items.filter((i) => SETTLED.has(i.state) && !prev.includes(i.clientId)).map((i) => i.clientId);
  return fresh.length === 0 ? (prev as string[]) : [...prev, ...fresh];
}

/** Solo se recuerdan los retirados que la cola sigue reteniendo; los demás ya no pueden volver. */
export function pruneRetired(retired: readonly string[], items: readonly QueueItem[]): string[] {
  const next = retired.filter((id) => items.some((i) => i.clientId === id));
  return next.length === retired.length ? (retired as string[]) : next;
}

/** Elementos que se ven en el panel de la cola: los que aún no salieron y los fallidos. */
export function visibleQueue(items: readonly QueueItem[]): QueueItem[] {
  return items.filter((i) => i.state === "queued" || i.state === "failed");
}

export const ECHO_LABEL: Record<EchoState, string> = {
  pending: "enviando…",
  cliQueued: "en la cola de Claude",
  absorbed: "añadido durante el turno",
};
