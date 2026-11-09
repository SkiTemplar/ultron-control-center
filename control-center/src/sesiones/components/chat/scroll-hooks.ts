// Desplazamiento del chat: anclaje abajo mientras el usuario no suba y carga de
// anteriores al acercarse arriba. El anclaje del contenido visible cuando cambia
// la cabeza de la lista lo hace el virtualizador (`anchorTo: "end"`).

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

const STICK_PX = 120;
const USER_GESTURE_MS = 400;
/** A menos de esta distancia del principio se pide la página anterior. */
export const LOAD_OLDER_PX = 600;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

interface Gestures {
  isUser: () => boolean;
  isHeld: () => boolean;
  dispose: () => void;
}

/** Solo un gesto (rueda, táctil, teclado o barra pulsada) cuenta como intención del usuario (SCR-01). */
function trackGestures(el: HTMLElement): Gestures {
  let userAt = 0;
  let pointerHeld = false;
  const mark = () => {
    userAt = Date.now();
  };
  const press = () => {
    pointerHeld = true;
    mark();
  };
  const release = () => {
    if (!pointerHeld) return;
    pointerHeld = false;
    mark();
  };
  const onKey = (e: KeyboardEvent) => {
    if (SCROLL_KEYS.has(e.key)) mark();
  };
  el.addEventListener("wheel", mark, { passive: true });
  el.addEventListener("touchmove", mark, { passive: true });
  el.addEventListener("pointerdown", press);
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  el.addEventListener("keydown", onKey);
  return {
    isUser: () => pointerHeld || Date.now() - userAt <= USER_GESTURE_MS,
    isHeld: () => pointerHeld,
    dispose: () => {
      el.removeEventListener("wheel", mark);
      el.removeEventListener("touchmove", mark);
      el.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      el.removeEventListener("keydown", onKey);
    },
  };
}

/**
 * Mantiene el anclaje abajo mientras el usuario no suba: un ResizeObserver
 * sobre el contenido detecta el crecimiento (streaming incluido) sin que el
 * componente padre tenga que re-renderizar por cada delta.
 */
export function useStickToBottom(ref: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>) {
  const [stuck, setStuck] = useState(true);
  const stuckRef = useRef(true);
  useEffect(() => {
    const el = ref.current;
    const inner = content.current;
    if (!el || !inner) return;
    const gestures = trackGestures(el);
    const toBottom = () => {
      el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => {
      if (!gestures.isUser()) return;
      const next = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      if (next === stuckRef.current) return;
      stuckRef.current = next;
      setStuck(next);
    };
    const ro = new ResizeObserver(() => {
      if (stuckRef.current && !gestures.isHeld()) toBottom();
    });
    ro.observe(inner);
    ro.observe(el);
    toBottom();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      gestures.dispose();
      el.removeEventListener("scroll", onScroll);
    };
  }, [ref, content]);
  const jump = () => {
    const el = ref.current;
    if (!el) return;
    stuckRef.current = true;
    setStuck(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  // Un salto a un mensaje (marcador o Ctrl+F) suelta el anclaje: si no, el
  // siguiente crecimiento del contenido devolvería la vista al final. Estable
  // para no romper la memoización de la lista virtual que lo recibe.
  const release = useCallback(() => {
    if (!stuckRef.current) return;
    stuckRef.current = false;
    setStuck(false);
  }, []);
  return { stuck, stuckRef, jump, release };
}

/**
 * ¿Toca pedir la página anterior? Cerca del principio y, o bien el usuario ha
 * subido (un desplazamiento propio del montaje no cuenta), o bien el hilo no
 * llena la vista.
 */
function wantsOlder(el: HTMLElement, stuck: boolean): boolean {
  if (el.scrollTop >= LOAD_OLDER_PX) return false;
  return !stuck || el.scrollHeight <= el.clientHeight;
}

/** Espera tras el primer fallo antes de admitir otro intento; se duplica en cada fallo seguido. */
export const OLDER_RETRY_BASE_MS = 1000;
const OLDER_RETRY_MAX_MS = 30_000;

/**
 * Estado de las peticiones de la página anterior. `pendingCount` = mensajes que
 * había al pedirla: si la carga termina sin que cambie, ha fallado (el fallo ya lo
 * notifica `loadOlder`). Tras un fallo no se reintenta solo: hace falta un gesto
 * del usuario y que haya pasado la espera, que crece con cada fallo seguido.
 */
interface OlderGate {
  pendingCount: number | null;
  failures: number;
  retryAt: number;
}

function retryDelay(failures: number): number {
  return Math.min(OLDER_RETRY_BASE_MS * 2 ** (failures - 1), OLDER_RETRY_MAX_MS);
}

/** Cierra la petición en vuelo al volver a poder cargar: sin mensajes nuevos, cuenta como fallo. */
function settle(gate: OlderGate, count: number): OlderGate {
  if (gate.pendingCount === null) return gate;
  if (gate.pendingCount !== count) return { pendingCount: null, failures: 0, retryAt: 0 };
  const failures = gate.failures + 1;
  return { pendingCount: null, failures, retryAt: Date.now() + retryDelay(failures) };
}

/** ¿Se admite una petición? Sin fallos, siempre; tras un fallo, solo por gesto y pasada la espera. */
function mayRequest(gate: OlderGate, byUser: boolean): boolean {
  if (gate.failures === 0) return true;
  return byUser && Date.now() >= gate.retryAt;
}

/** Pide la página anterior al acercarse arriba (o si el hilo no llena la vista). */
export function useLoadOlder(scrollRef: RefObject<HTMLDivElement | null>, stuckRef: RefObject<boolean>, canLoad: boolean, onLoadOlder: () => void, count: number) {
  const latest = useRef({ canLoad, onLoadOlder, count });
  latest.current = { canLoad, onLoadOlder, count };
  const gate = useRef<OlderGate>({ pendingCount: null, failures: 0, retryAt: 0 });
  // Estable: lo usan el efecto de los listeners (montado una vez) y el de la carga automática.
  const request = useCallback((byUser: boolean) => {
    const { canLoad: can, onLoadOlder: load, count: n } = latest.current;
    if (!can || !mayRequest(gate.current, byUser)) return;
    gate.current = { ...gate.current, pendingCount: n };
    load();
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Tras el fotograma: el listener de `useStickToBottom` tiene que haber
    // soltado el anclaje antes de evaluar (el orden de los listeners no lo fija).
    // Tras un fallo, un `scroll` también cuenta como gesto: sin contenido nuevo
    // el desplazamiento no cambia solo, y la espera creciente acota la cadencia.
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (wantsOlder(el, stuckRef.current)) request(true);
      });
    };
    // Rueda o tecla hacia arriba ya arriba del todo: no hay evento `scroll`
    // (el desplazamiento no cambia) pero el usuario pide claramente lo anterior.
    const upAtTop = () => {
      if (el.scrollTop < LOAD_OLDER_PX) request(true);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) upAtTop();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") upAtTop();
    };
    el.addEventListener("scroll", check, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", check);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKey);
    };
  }, [scrollRef, stuckRef, request]);
  // Otro hilo (cambio de sesión o de agente): los fallos del anterior no cuentan.
  useEffect(() => {
    gate.current = { pendingCount: null, failures: 0, retryAt: 0 };
  }, [onLoadOlder]);
  // Carga automática (hilo que no llena la vista o recién llegado arriba). Si la
  // anterior falló, no se repite: sin esta parada, `loading` volvía a `false`,
  // `canLoad` a `true` y el efecto pedía otra vez la misma página en bucle.
  useEffect(() => {
    if (!canLoad) return;
    gate.current = settle(gate.current, count);
    const el = scrollRef.current;
    if (el && gate.current.failures === 0 && wantsOlder(el, stuckRef.current)) request(false);
  }, [scrollRef, stuckRef, canLoad, onLoadOlder, count, request]);
}
