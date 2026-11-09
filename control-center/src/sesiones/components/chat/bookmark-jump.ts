// Consumidor del canal «ir al marcador» (bookmarks.ts) en la lista virtual del
// chat: lleva la fila del mensaje al centro, espera a que se pinte, la centra
// con scrollIntoView y la resalta un momento. Si no puede, lo deja dicho
// (`missing`) para que el menú lo explique en vez de no hacer nada.

import { useEffect, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { settleJump, useJump } from "../../bookmarks";
import type { TimelineItem } from "../../timeline";
import { useChatScope } from "./ChatContext";

export const FLASH_MS = 1600;
/** Fotogramas que se espera a que la fila aparezca tras desplazar la lista. */
const MAX_FRAMES = 12;

/** Mensaje pintado con ese uuid (atributo `data-msg-uuid`) dentro de `root`. */
export function findRenderedMessage(root: HTMLElement | null, uuid: string): HTMLElement | null {
  if (!root) return null;
  for (const el of root.querySelectorAll<HTMLElement>("[data-msg-uuid]")) if (el.dataset.msgUuid === uuid) return el;
  return null;
}

/** Resalte breve; es un atributo fuera de React, así que un repintado no lo pisa. */
export function flashMessage(el: HTMLElement): void {
  el.setAttribute("data-flash", "");
  window.setTimeout(() => el.removeAttribute("data-flash"), FLASH_MS);
}

type Scroller = Pick<Virtualizer<HTMLDivElement, Element>, "scrollToIndex">;

/**
 * Lleva la fila `uuid` al centro de la lista virtual, espera a que se pinte y la
 * centra con scrollIntoView. Llama a `done` con el elemento del mensaje (o null si
 * no está en la lista o no llegó a pintarse). `release` suelta el anclaje abajo
 * justo antes de desplazar, solo si el mensaje está en la lista: si no, el
 * siguiente crecimiento del contenido devolvería la vista al final. Devuelve la
 * cancelación.
 */
export function revealMessage(
  items: readonly TimelineItem[],
  v: Scroller,
  scrollRef: RefObject<HTMLDivElement | null>,
  uuid: string,
  done: (el: HTMLElement | null) => void,
  release: () => void = () => undefined,
): () => void {
  const index = items.findIndex((it) => it.key === uuid);
  if (index < 0) {
    done(null);
    return () => undefined;
  }
  release();
  v.scrollToIndex(index, { align: "center" });
  let frames = 0;
  let raf = 0;
  const attempt = () => {
    const el = findRenderedMessage(scrollRef.current, uuid);
    if (el) {
      el.scrollIntoView({ block: "center" });
      done(el);
      return;
    }
    frames += 1;
    if (frames >= MAX_FRAMES) done(null);
    else raf = window.requestAnimationFrame(attempt);
  };
  raf = window.requestAnimationFrame(attempt);
  return () => window.cancelAnimationFrame(raf);
}

export function useBookmarkJump(items: readonly TimelineItem[], v: Scroller, scrollRef: RefObject<HTMLDivElement | null>, release?: () => void): void {
  const scope = useChatScope();
  const jump = useJump(scope && !scope.readOnly ? scope.sessionId : null);
  useEffect(() => {
    if (!jump || jump.status !== "pending") return;
    const { tick, uuid } = jump;
    return revealMessage(items, v, scrollRef, uuid, (el) => {
      if (!el) return settleJump(tick, "missing");
      flashMessage(el);
      settleJump(tick, "done");
    }, release);
  }, [jump, items, v, scrollRef, release]);
}
