// Columna de sesiones → backend: dónde está cada fila en pantalla.
//
// La mascota (Pupus) se cuelga junto a la sesión que pide permiso y la
// señala. Para eso necesita los rectángulos de la columna y de cada fila
// (px CSS del viewport) y el devicePixelRatio; el backend los pasa a px
// físicos con la posición de la ventana (sesiones/barra_lateral.rs). El
// informe lleva también el cuadro de texto del chat (`.composer .cbox`):
// Pupus anda por su borde superior (mascot/sessions_surfaces.rs). Se
// informa solo cuando cambia el layout (tamaño, scroll, dpr, sesiones, el
// cuadro crece o aparece), con un fotograma y un remate a los 200 ms, y
// nunca con la ventana oculta.

import { useEffect, useRef, type RefObject } from "react";
import { reportError } from "./bootstrap";
import { useApi } from "./context";
import type { SessionId } from "./types";

export interface CssRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Cuánto se ve de la fila dentro de la columna (que hace scroll). */
export type RailClip = "full" | "partial" | "above" | "below";

export interface RailItem {
  id: SessionId;
  rect: CssRect;
  clip: RailClip;
}

/**
 * `rail = null`: la columna no se ve (layout estrecho) y no hay filas.
 * `composer = null`: no hay cuadro de texto a la vista.
 */
export interface RailReport {
  dpr: number;
  rail: CssRect | null;
  items: RailItem[];
  composer: CssRect | null;
}

/** El backend rechaza informes con más filas. */
const MAX_ITEMS = 200;
const SETTLE_MS = 200;
/**
 * Repaso periódico: el cuadro de texto aparece y desaparece al cambiar de
 * vista sin que la columna cambie de tamaño. Solo envía si algo cambió.
 */
const RECHECK_MS = 1000;
/** El cuadro de texto del chat (Composer.tsx). */
export const COMPOSER_SELECTOR = ".composer .cbox";

const cssRect = (r: DOMRect): CssRect => ({ x: r.left, y: r.top, w: r.width, h: r.height });

export function clipOf(item: CssRect, rail: CssRect): RailClip {
  const bottom = item.y + item.h;
  const railBottom = rail.y + rail.h;
  if (bottom <= rail.y) return "above";
  if (item.y >= railBottom) return "below";
  return item.y >= rail.y && bottom <= railBottom ? "full" : "partial";
}

/** Primer cuadro de texto con tamaño (en px CSS del viewport), o null. */
export function composerRect(doc: Document): CssRect | null {
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(COMPOSER_SELECTOR))) {
    const r = cssRect(el.getBoundingClientRect());
    if (r.w > 0 && r.h > 0) return r;
  }
  return null;
}

/** Informe de la columna `rail`: filas `[data-session-id]` (rect de su botón `.sess`) y el cuadro de texto. */
export function collectRailReport(rail: HTMLElement, dpr: number): RailReport {
  const box = rail.getBoundingClientRect();
  const composer = composerRect(rail.ownerDocument);
  if (box.width <= 0 || box.height <= 0) return { dpr, rail: null, items: [], composer };
  const railRect = cssRect(box);
  const items: RailItem[] = [];
  for (const el of Array.from(rail.querySelectorAll<HTMLElement>("[data-session-id]"))) {
    const id = el.dataset.sessionId;
    const rect = cssRect((el.querySelector<HTMLElement>(".sess") ?? el).getBoundingClientRect());
    if (!id || rect.w <= 0 || rect.h <= 0) continue;
    items.push({ id, rect, clip: clipOf(rect, railRect) });
  }
  return { dpr, rail: railRect, items: items.slice(0, MAX_ITEMS), composer };
}

const sameRect = (a: CssRect, b: CssRect) =>
  Math.round(a.x) === Math.round(b.x) &&
  Math.round(a.y) === Math.round(b.y) &&
  Math.round(a.w) === Math.round(b.w) &&
  Math.round(a.h) === Math.round(b.h);

/** Iguales a efectos de la mascota: a 1 px y con el dpr a 0,01. */
export function sameReport(a: RailReport, b: RailReport): boolean {
  const empty = (r: RailReport) => !r.rail && r.items.length === 0 && !r.composer;
  if (empty(a) && empty(b)) return true;
  if (Math.round(a.dpr * 100) !== Math.round(b.dpr * 100)) return false;
  if (!a.rail || !b.rail ? a.rail !== b.rail : !sameRect(a.rail, b.rail)) return false;
  if (!a.composer || !b.composer ? a.composer !== b.composer : !sameRect(a.composer, b.composer)) return false;
  if (a.items.length !== b.items.length) return false;
  return a.items.every((it, i) => {
    const o = b.items[i];
    return it.id === o.id && it.clip === o.clip && sameRect(it.rect, o.rect);
  });
}

/** Lo que el backend sabe sin informe: nada que señalar. */
export const EMPTY_RAIL: RailReport = { dpr: 1, rail: null, items: [], composer: null };

/** Avisa con `cb` cuando cambia el devicePixelRatio (zoom o cambio de monitor). */
function watchDpr(cb: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  let mql: MediaQueryList | null = null;
  const onChange = () => {
    arm();
    cb();
  };
  function arm() {
    mql?.removeEventListener("change", onChange);
    mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mql.addEventListener("change", onChange);
  }
  arm();
  return () => mql?.removeEventListener("change", onChange);
}

/**
 * Informa de la columna al backend cuando cambia. `sessionsKey` cambia con
 * la lista de sesiones (filas nuevas o quitadas). Un fallo se cuenta una
 * sola vez y deja el último informe sin tocar, para reintentar.
 */
export function useRailReport(railRef: RefObject<HTMLElement | null>, sessionsKey: string): void {
  const api = useApi();
  const lastRef = useRef<RailReport>(EMPTY_RAIL);
  const failedRef = useRef(false);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let frame = 0;
    let timer = 0;
    let alive = true;
    const send = () => {
      if (!alive || document.visibilityState === "hidden") return;
      const next = collectRailReport(rail, window.devicePixelRatio || 1);
      const prev = lastRef.current;
      if (sameReport(prev, next)) return;
      lastRef.current = next;
      api.reportRail(next).then(
        () => void (failedRef.current = false),
        (e: unknown) => {
          if (lastRef.current === next) lastRef.current = prev;
          if (!failedRef.current) reportError(e);
          failedRef.current = true;
        },
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      frame = requestAnimationFrame(send);
      timer = window.setTimeout(send, SETTLE_MS);
    };
    schedule();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(rail);
    rail.querySelectorAll("[data-session-id]").forEach((el) => ro?.observe(el));
    rail.ownerDocument.querySelectorAll(COMPOSER_SELECTOR).forEach((el) => ro?.observe(el));
    const recheck = window.setInterval(send, RECHECK_MS);
    rail.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    const unwatch = watchDpr(schedule);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.clearInterval(recheck);
      ro?.disconnect();
      rail.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
      unwatch();
    };
  }, [api, railRef, sessionsKey]);
}
