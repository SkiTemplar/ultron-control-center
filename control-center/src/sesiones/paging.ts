// Historial paginado en el cliente (contrato v3 §7), puro para poder probarlo:
// colocar la última página sobre lo que ya hay, anteponer una página anterior
// sin duplicar y la cota en vivo de mensajes por hilo.

import { mergeMessages } from "./parse";
import { opensTurn } from "./timeline";
import type { ChatMessage } from "./types";

/** Por encima de esto, en vivo, se sueltan los mensajes más antiguos… */
export const LIVE_CAP = 1500;
/** …hasta quedarse con estos. */
export const LIVE_KEEP = 1200;
/**
 * Cota cuando el usuario lee lejos del final (anclado arriba) o cuando el turno
 * en curso ocupa todo el hilo: más holgada, pero la memoria sigue acotada.
 */
export const HARD_CAP = 6000;

/**
 * Coloca la última página del transcript sobre el hilo en memoria. Si se solapan,
 * se conserva lo anterior a la página (páginas ya cargadas) salvo con `replace`;
 * lo llegado por evento durante la carga queda detrás. Sin solape, lo que hay en
 * memoria llegó por evento durante la carga y va detrás de la página (F16).
 */
export function placeLastPage(existing: readonly ChatMessage[], page: readonly ChatMessage[], replace = false): ChatMessage[] {
  if (page.length === 0) return replace ? [] : (existing as ChatMessage[]);
  if (existing.length === 0) return page as ChatMessage[];
  const inPage = new Set(page.map((m) => m.uuid));
  const first = existing.findIndex((m) => inPage.has(m.uuid));
  if (first === -1) return replace ? (page as ChatMessage[]) : [...page, ...existing];
  const prefix = replace ? [] : existing.slice(0, first);
  return [...prefix, ...mergeMessages(page, existing.slice(first))];
}

/** Antepone una página anterior; los uuid que ya están en el hilo no se repiten. */
export function prependPage(existing: readonly ChatMessage[], page: readonly ChatMessage[]): ChatMessage[] {
  if (page.length === 0) return existing as ChatMessage[];
  const have = new Set(existing.map((m) => m.uuid));
  const fresh = page.filter((m) => !have.has(m.uuid));
  return fresh.length === 0 ? (existing as ChatMessage[]) : [...fresh, ...existing];
}

/** Índice del prompt que abre el último turno, buscando hacia atrás; -1 si no hay. */
export function lastTurnStart(list: readonly ChatMessage[]): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (opensTurn(list[i])) return i;
  }
  return -1;
}

/**
 * Cota en vivo (§7): por encima de `LIVE_CAP` mensajes se sueltan los más antiguos
 * hasta `LIVE_KEEP`. El turno en curso se conserva entero mientras quepa en la
 * cota; si la pasa (un turno autónomo de toda la noche), se recorta también por
 * dentro y el historial paginado lo recupera. Si el usuario lee lejos del final,
 * la cota es `HARD_CAP`. Devuelve la misma lista si no recorta.
 */
export function capThread(list: readonly ChatMessage[], pinned = false): ChatMessage[] {
  const len = list.length;
  const limit = pinned ? HARD_CAP : LIVE_CAP;
  if (len <= limit) return list as ChatMessage[];
  const target = len - LIVE_KEEP;
  const start = lastTurnStart(list);
  const keepTurn = start > 0 && start < target && len - start <= limit;
  return list.slice(keepTurn ? start : target);
}
