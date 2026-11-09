// Mascota — ratón sobre la mascota (MascotApp.tsx): clic = saltito o atender
// un aviso, arrastrar = coger, soltar = lanzar (con Ctrl = colgarla de una
// chincheta). Un puntero cancelado (scroll táctil, captura perdida) termina
// el arrastre o la pulsación sin contar como clic.

import type { MutableRefObject, PointerEvent } from "react";
import type { MascotEngine } from "./engine";

export interface Press {
  x: number;
  y: number;
  t: number;
  dragging: boolean;
}

export interface PressDeps {
  pressRef: MutableRefObject<Press | null>;
  engineRef: MutableRefObject<MascotEngine | null>;
  driveRef: MutableRefObject<boolean>;
  cursorRef: MutableRefObject<{ ctrl: boolean } | null>;
  /** Clic sin arrastrar (avisos pendientes primero; si no, saltito). */
  onClick: (eng: MascotEngine) => void;
}

type Handler = (e: PointerEvent<HTMLDivElement>) => void;

export interface PressHandlers {
  onPointerDown: Handler;
  onPointerMove: Handler;
  onPointerUp: Handler;
  onPointerCancel: Handler;
}

/** Distancia (px CSS) a partir de la cual una pulsación pasa a ser arrastre. */
const DRAG_THRESHOLD = 5;

export function pressHandlers({ pressRef, engineRef, driveRef, cursorRef, onClick }: PressDeps): PressHandlers {
  const onPointerDown: Handler = (e) => {
    if (e.button !== 0 || driveRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pressRef.current = { x: e.clientX, y: e.clientY, t: performance.now(), dragging: false };
  };

  const onPointerMove: Handler = (e) => {
    const p = pressRef.current;
    const eng = engineRef.current;
    if (!p || !eng) return;
    if (!p.dragging) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
      p.dragging = true;
      eng.startDrag(p.x, p.y, p.t / 1000);
    }
    eng.dragTo(e.clientX, e.clientY, performance.now() / 1000);
  };

  const onPointerUp: Handler = (e) => {
    const p = pressRef.current;
    const eng = engineRef.current;
    pressRef.current = null;
    if (!p || !eng) return;
    if (p.dragging) eng.endDrag(e.ctrlKey || !!cursorRef.current?.ctrl);
    else onClick(eng);
  };

  // Cancelado: suelta si arrastraba; una pulsación sin arrastre se descarta.
  const onPointerCancel: Handler = () => {
    const p = pressRef.current;
    pressRef.current = null;
    if (p?.dragging) engineRef.current?.endDrag(!!cursorRef.current?.ctrl);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
