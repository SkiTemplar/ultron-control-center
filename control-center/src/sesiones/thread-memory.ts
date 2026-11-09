// Memoria de los hilos de una sesión (auditoría de estabilidad nocturna, H1).
// Puro, para probarlo: el peso estimado de cada mensaje (textos e imágenes en
// `data:`), el tope en bytes por sesión y el LRU de hilos de subagente. Lo que
// se suelta aquí no se pierde: el historial paginado lo recupera al hacer
// scroll (`hasMore`) o al abrir el hilo (`loadHistory`).

import type { Block, ChatMessage } from "./types";

/** Por encima de esto (bytes estimados en UTF-16) se sueltan los mensajes más antiguos de la sesión… */
export const BYTE_CAP = 64 * 1024 * 1024;
/** …hasta quedarse por debajo de esto (histéresis: no se recorta en cada evento). */
export const BYTE_KEEP = 48 * 1024 * 1024;
/** Hilos de subagente cerrados que se conservan en memoria (los más recientes). */
export const AGENT_THREADS_KEEP = 8;

/** Coste fijo por mensaje (objeto, uuid, marcas de tiempo). */
const MESSAGE_OVERHEAD = 256;

const messageWeights = new WeakMap<ChatMessage, number>();
const threadWeights = new WeakMap<readonly ChatMessage[], number>();

function inputChars(input: unknown): number {
  if (input === undefined || input === null) return 0;
  if (typeof input === "string") return input.length;
  try {
    return JSON.stringify(input)?.length ?? 0;
  } catch {
    // Entrada no serializable (ciclo): cuenta como vacía, el resto del mensaje sí pesa.
    return 0;
  }
}

function blockChars(b: Block): number {
  switch (b.kind) {
    case "text":
    case "thinking":
      return b.text.length;
    case "image":
      return (b.dataUrl?.length ?? 0) + (b.path?.length ?? 0);
    case "toolUse":
      return b.summary.length + b.name.length + inputChars(b.input);
    case "toolResult":
      return b.text.length + (b.images ?? []).reduce((n, img) => n + img.length, 0);
    default:
      return 0;
  }
}

/** Peso estimado de un mensaje en bytes (UTF-16: dos por carácter). Se calcula una vez por objeto. */
export function messageWeight(m: ChatMessage): number {
  const cached = messageWeights.get(m);
  if (cached !== undefined) return cached;
  let chars = MESSAGE_OVERHEAD;
  for (const b of m.blocks) chars += blockChars(b);
  if (m.command) chars += m.command.stdout.length + m.command.args.length;
  const weight = chars * 2;
  messageWeights.set(m, weight);
  return weight;
}

/** Peso de un hilo; cacheado por lista (las listas del store no se mutan). */
export function threadWeight(list: readonly ChatMessage[]): number {
  const cached = threadWeights.get(list);
  if (cached !== undefined) return cached;
  let total = 0;
  for (const m of list) total += messageWeight(m);
  threadWeights.set(list, total);
  return total;
}

/**
 * Suelta los mensajes más antiguos hasta que el hilo pese `budget` o menos.
 * Conserva siempre el último. Devuelve la misma lista si no recorta.
 */
export function capBytes(list: readonly ChatMessage[], budget: number): ChatMessage[] {
  let total = threadWeight(list);
  if (total <= budget) return list as ChatMessage[];
  let cut = 0;
  while (cut < list.length - 1 && total > budget) {
    total -= messageWeight(list[cut]);
    cut += 1;
  }
  return cut === 0 ? (list as ChatMessage[]) : list.slice(cut);
}

/** Lleva los hilos dados al final del LRU (el más reciente, el último). Misma lista si ya estaban al final en ese orden. */
export function touchLru(lru: readonly string[], ids: readonly string[]): string[] {
  if (ids.length === 0) return lru as string[];
  const tail = lru.slice(lru.length - ids.length);
  if (tail.length === ids.length && tail.every((x, i) => x === ids[i])) return lru as string[];
  const moved = new Set(ids);
  return [...lru.filter((x) => !moved.has(x)), ...ids];
}

/**
 * Hilos de subagente que se pueden soltar: los que no están abiertos en ningún
 * panel y quedan fuera de los `keep` más recientes del LRU (del más antiguo al
 * más reciente).
 */
export function evictableAgents(lru: readonly string[], open: ReadonlySet<string>, keep = AGENT_THREADS_KEEP): string[] {
  const closed = lru.filter((id) => !open.has(id));
  return closed.slice(0, Math.max(0, closed.length - keep));
}
