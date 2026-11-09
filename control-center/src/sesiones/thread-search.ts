// Búsqueda dentro del hilo del chat (Ctrl+F): plegado sin mayúsculas ni tildes,
// texto buscable de cada mensaje, coincidencias por mensaje y navegación
// circular. El texto plegado se memoriza por objeto (los mensajes y los
// resultados de herramientas son inmutables), así que un hilo de miles de
// mensajes solo pliega lo nuevo. Al final, el canal que abre la barra en el
// panel con foco (lo emite el atajo global de `useShortcuts`).

import { useSyncExternalStore } from "react";
import type { ToolResultBlock } from "./parse";
import { createStore } from "./store";
import type { TimelineItem } from "./timeline";
import type { ChatMessage, SessionId } from "./types";

const MARKS = /\p{M}+/gu;

/** Minúsculas y sin diacríticos («Canción» → «cancion»). */
export function foldText(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(MARKS, "");
}

export interface FoldedText {
  text: string;
  /** `map[i]` = índice en el original del carácter `i` plegado; `map[text.length]` = longitud del original. */
  map: number[];
}

/** Plegado con correspondencia de posiciones, para resaltar el término en el texto pintado. */
export function foldWithMap(s: string): FoldedText {
  let text = "";
  const map: number[] = [];
  let at = 0;
  for (const ch of s) {
    const folded = foldText(ch);
    for (let k = 0; k < folded.length; k += 1) map.push(at);
    text += folded;
    at += ch.length;
  }
  map.push(s.length);
  return { text, map };
}

/** Rangos `[inicio, fin)` del original donde aparece `query` (ya plegada). */
export function foldedRanges(s: string, foldedQuery: string): [number, number][] {
  if (!foldedQuery) return [];
  const { text, map } = foldWithMap(s);
  const out: [number, number][] = [];
  let from = text.indexOf(foldedQuery);
  while (from >= 0) {
    const end = from + foldedQuery.length;
    out.push([map[from], map[end]]);
    from = text.indexOf(foldedQuery, end);
  }
  return out;
}

const messageCache = new WeakMap<ChatMessage, string>();
const resultCache = new WeakMap<ToolResultBlock, string>();

function foldedMessage(m: ChatMessage): string {
  let folded = messageCache.get(m);
  if (folded === undefined) {
    folded = foldText(m.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("\n"));
    messageCache.set(m, folded);
  }
  return folded;
}

function foldedResult(r: ToolResultBlock): string {
  let folded = resultCache.get(r);
  if (folded === undefined) {
    folded = foldText(r.text);
    resultCache.set(r, folded);
  }
  return folded;
}

/** El texto del mensaje o el de los resultados de sus herramientas contiene `foldedQuery`. */
export function messageMatches(m: ChatMessage, results: ReadonlyMap<string, ToolResultBlock>, foldedQuery: string): boolean {
  if (foldedMessage(m).includes(foldedQuery)) return true;
  for (const b of m.blocks) {
    if (b.kind !== "toolUse") continue;
    const r = results.get(b.id);
    if (r && foldedResult(r).includes(foldedQuery)) return true;
  }
  return false;
}

export interface ThreadMatch {
  /** Clave de la fila (uuid del mensaje). */
  key: string;
  /** Turno del mensaje: si está plegado, hay que desplegarlo para verlo. */
  turn: string | null;
}

/**
 * Mensajes del hilo cargado que contienen el término, en orden. Cuenta mensajes,
 * no apariciones: el Markdown pintado no coincide carácter a carácter con el
 * texto fuente, así que «n de m» se refiere a mensajes con coincidencias.
 */
export function findMatches(items: readonly TimelineItem[], results: ReadonlyMap<string, ToolResultBlock>, query: string): ThreadMatch[] {
  const q = foldText(query.trim());
  if (!q) return [];
  const out: ThreadMatch[] = [];
  for (const it of items) {
    if (it.kind === "msg" && messageMatches(it.m, results, q)) out.push({ key: it.key, turn: it.turn || null });
  }
  return out;
}

/** Siguiente (`1`) o anterior (`-1`) con vuelta al otro extremo; -1 si no hay coincidencias. */
export function stepMatch(active: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (active < 0 || active >= count) return dir > 0 ? 0 : count - 1;
  return (active + dir + count) % count;
}

/** «n de m»; sin coincidencias, «0 de 0». */
export function matchLabel(active: number, count: number): string {
  if (count <= 0) return "0 de 0";
  return `${active >= 0 && active < count ? active + 1 : 0} de ${count}`;
}

// --- Canal «abrir la búsqueda» ------------------------------------------------

export interface SearchRequest {
  sessionId: SessionId;
  agentId: string | null;
  tick: number;
}

const searchStore = createStore<SearchRequest | null, SearchRequest | null>((_, next) => next, null);

/** Pide abrir (o volver a enfocar) la búsqueda del chat que pinta ese hilo. */
export function requestThreadSearch(sessionId: SessionId, agentId: string | null): void {
  const tick = (searchStore.getState()?.tick ?? 0) + 1;
  searchStore.dispatch({ sessionId, agentId, tick });
}

/** El chat atiende la petición: un panel que se monte después no la vuelve a abrir. */
export function consumeThreadSearch(tick: number): void {
  if (searchStore.getState()?.tick === tick) searchStore.dispatch(null);
}

export function useThreadSearchRequest(sessionId: SessionId, agentId: string | null): SearchRequest | null {
  return useSyncExternalStore(searchStore.subscribe, () => {
    const r = searchStore.getState();
    return r && r.sessionId === sessionId && r.agentId === agentId ? r : null;
  });
}
