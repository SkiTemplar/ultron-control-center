// Salto a la coincidencia activa de la búsqueda del hilo (Ctrl+F) en la lista
// virtual. Reutiliza `revealMessage` de los marcadores; si la coincidencia está
// en la actividad plegada de un turno, lo despliega primero. El mensaje queda
// marcado (`data-search-hit`) y el término se resalta con la CSS Custom
// Highlight API, que pinta rangos sin tocar el DOM de React ni del Markdown.
// Donde no existe esa API (jsdom, motores antiguos) solo se marca el mensaje.

import { useEffect, useRef, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { foldedRanges, foldText } from "../../thread-search";
import type { TimelineItem } from "../../timeline";
import { toggleTurn, uiStore } from "../../ui";
import { flashMessage, revealMessage } from "./bookmark-jump";

/** Petición de ir a una coincidencia; `owner` distingue el chat de cada panel. */
export interface SearchJump {
  owner: string;
  key: string;
  turn: string | null;
  query: string;
  tick: number;
}

const HIGHLIGHT = "thread-search";
/** Tope de rangos por mensaje: un término de una letra en un volcado enorme no bloquea el pintado. */
const MAX_RANGES = 400;
const rangesByOwner = new Map<string, Range[]>();
const markedByOwner = new Map<string, HTMLElement>();

function syncRegistry(): void {
  const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  if (!registry || typeof Highlight === "undefined") return;
  const all = [...rangesByOwner.values()].flat();
  if (all.length === 0) registry.delete(HIGHLIGHT);
  else registry.set(HIGHLIGHT, new Highlight(...all));
}

/** Rangos del término (sin mayúsculas ni tildes) en los nodos de texto de `root`. */
export function termRanges(root: HTMLElement, query: string): Range[] {
  const q = foldText(query.trim());
  if (!q) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Range[] = [];
  for (let n = walker.nextNode(); n && out.length < MAX_RANGES; n = walker.nextNode()) {
    for (const [start, end] of foldedRanges(n.nodeValue ?? "", q)) {
      const r = document.createRange();
      r.setStart(n, start);
      r.setEnd(n, end);
      out.push(r);
    }
  }
  return out;
}

/** Quita la marca y el resalte del chat `owner`. */
export function clearSearchMark(owner: string): void {
  markedByOwner.get(owner)?.removeAttribute("data-search-hit");
  markedByOwner.delete(owner);
  if (rangesByOwner.delete(owner)) syncRegistry();
}

function markMatch(owner: string, el: HTMLElement, query: string): void {
  clearSearchMark(owner);
  el.setAttribute("data-search-hit", "");
  markedByOwner.set(owner, el);
  flashMessage(el);
  const ranges = termRanges(el, query);
  if (ranges.length === 0) return;
  rangesByOwner.set(owner, ranges);
  syncRegistry();
  // En un mensaje largo, el término puede quedar fuera de la vista al centrar el mensaje.
  ranges[0].startContainer.parentElement?.scrollIntoView({ block: "center" });
}

/** Fila pintada de la lista virtual con ese índice. */
function rowOf(root: HTMLElement | null, index: number): HTMLElement | null {
  if (!root || index < 0) return null;
  return root.querySelector<HTMLElement>(`.vrow[data-index="${index}"]`);
}

type Scroller = Pick<Virtualizer<HTMLDivElement, Element>, "scrollToIndex">;

export function useSearchJump(
  items: readonly TimelineItem[],
  v: Scroller,
  scrollRef: RefObject<HTMLDivElement | null>,
  jump: SearchJump | null,
  release?: () => void,
): void {
  const handled = useRef(0);
  const expandedFor = useRef(0);
  useEffect(() => {
    if (!jump) return;
    // Otra coincidencia, cerrar la barra o desmontar el chat quita el resalte de esta.
    return () => clearSearchMark(jump.owner);
  }, [jump]);
  useEffect(() => {
    if (!jump || handled.current === jump.tick) return;
    const drawn = items.some((it) => it.key === jump.key);
    if (!drawn && jump.turn && expandedFor.current !== jump.tick && !uiStore.getState().expandedTurns[jump.turn]) {
      // Fila plegada (actividad del turno): al desplegarla cambian las filas y se reintenta.
      expandedFor.current = jump.tick;
      toggleTurn(jump.turn);
      return;
    }
    return revealMessage(items, v, scrollRef, jump.key, (el) => {
      handled.current = jump.tick;
      // Avisos del sistema, comandos y traídos no llevan `data-msg-uuid`: se marca su fila.
      const target = el ?? rowOf(scrollRef.current, items.findIndex((it) => it.key === jump.key));
      if (!target) return;
      if (!el) target.scrollIntoView({ block: "center" });
      markMatch(jump.owner, target, jump.query);
    }, release);
  }, [jump, items, v, scrollRef, release]);
}
