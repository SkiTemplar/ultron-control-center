// Mascota — superficies de dentro de las ventanas de Sessions: el borde
// superior del cuadro de texto del chat (plataforma) y los laterales de la
// ventana (paredes por las que trepar). Funciones puras (px CSS relativos a
// la ventana de la mascota), con tests.
//
// El backend da, por cada ventana de Sessions visible, su HWND (el mismo
// `id` que las ventanas de `mascot_windows`) y el rectángulo del cuadro de
// texto (mascot/sessions_surfaces.rs). El orden Z sale de la lista de
// ventanas que ya tiene el motor: si Sessions no está en ella (minimizada,
// en otro monitor, en silencio de juego) no hay plataforma ni paredes, y lo
// que la tape le quita los mismos tramos que a cualquier otro borde.

import type { WinRect } from "./world";

/** Ventana de Sessions vista por la mascota: `id` = HWND; cuadro de texto en px CSS. */
export interface SessionsInside {
  id: number;
  composer: Omit<WinRect, "id"> | null;
}

/** Lado de la ventana por el que trepa (por fuera). */
export type WallSide = "left" | "right";

/** Lateral VISIBLE de una ventana de Sessions, desde su borde superior hacia abajo. */
export interface Wall {
  /** Ventana (HWND): su borde superior es la plataforma donde acaba la trepada. */
  id: number;
  side: WallSide;
  /** x del borde (px CSS). */
  x: number;
  /** Borde superior de la ventana. */
  top: number;
  /** Fin del tramo visible que arranca en `top`. */
  bottom: number;
}

/** Id de la plataforma del cuadro de texto: negativo, no choca con ningún HWND. */
export const composerId = (winId: number): number => -Math.abs(winId);

/**
 * Lista de ventanas para sacar plataformas: el cuadro de texto de cada
 * Sessions entra justo encima de su ventana en el orden Z (está dentro de
 * ella), recortado a la ventana. Las ventanas que tapan Sessions tapan
 * también el cuadro. Solo para plataformas: el cuadro no es sólido.
 */
export function withComposers(wins: WinRect[], inside: SessionsInside[]): WinRect[] {
  const out: WinRect[] = [];
  for (const w of wins) {
    const c = inside.find((s) => s.id === w.id)?.composer;
    if (c && c.top > w.top && c.top < w.bottom) {
      const left = Math.max(c.left, w.left);
      const right = Math.min(c.right, w.right);
      if (right > left) out.push({ id: composerId(w.id), left, right, top: c.top, bottom: Math.min(c.bottom, w.bottom) });
    }
    out.push(w);
  }
  return out;
}

/** Tramo visible de la columna x de la ventana `i`, desde su borde superior. */
function visibleFromTop(wins: WinRect[], i: number, x: number): number | null {
  const w = wins[i];
  let segs: [number, number][] = [[w.top, w.bottom]];
  for (let j = 0; j < i && segs.length; j++) {
    const o = wins[j];
    if (x < o.left || x >= o.right) continue;
    segs = segs.flatMap(([a, b]): [number, number][] => {
      if (o.bottom <= a || o.top >= b) return [[a, b]];
      const keep: [number, number][] = [];
      if (o.top > a) keep.push([a, o.top]);
      if (o.bottom < b) keep.push([o.bottom, b]);
      return keep;
    });
  }
  const first = segs[0];
  return first && first[0] === w.top ? first[1] : null;
}

/**
 * Laterales trepables de las ventanas de Sessions. `wins` en orden Z (la más
 * alta primero). Se descartan las maximizadas (sin borde superior al que
 * llegar), los laterales fuera del área y los que tienen la esquina de
 * arriba tapada.
 */
export function visibleWalls(wins: WinRect[], inside: SessionsInside[], areaWidth: number, minTop = 4): Wall[] {
  const out: Wall[] = [];
  wins.forEach((w, i) => {
    if (w.top <= minTop || !inside.some((s) => s.id === w.id)) return;
    for (const side of ["left", "right"] as const) {
      const col = side === "left" ? w.left : w.right - 1;
      if (col < 0 || col >= areaWidth) continue;
      const bottom = visibleFromTop(wins, i, col);
      if (bottom !== null) out.push({ id: w.id, side, x: side === "left" ? w.left : w.right, top: w.top, bottom });
    }
  });
  return out;
}

/** x del centro de los pies pegado a la pared, por fuera de la ventana. */
export function wallBodyX(w: Wall, halfW: number): number {
  return w.side === "left" ? w.x - halfW : w.x + halfW;
}

/** x de los pies sobre el borde superior, junto a la esquina de la pared. */
export function wallTopX(w: Wall, halfW: number): number {
  return w.side === "left" ? w.x + halfW + 2 : w.x - halfW - 2;
}

/** ¿Cabe pegado a la pared sin salirse del área de la mascota? */
export function wallFits(w: Wall, halfW: number, areaWidth: number): boolean {
  const bx = wallBodyX(w, halfW);
  return bx >= halfW && bx <= areaWidth - halfW;
}

/**
 * Plataformas a las que se puede saltar desde (x, y). Con las ventanas
 * sólidas, el cuadro de texto de Sessions solo se alcanza desde dentro de
 * esa ventana: desde fuera, el salto choca con su lateral o su techo y
 * rebota en cada intento.
 */
export function jumpablePlatforms<P extends { id: number }>(plats: P[], wins: WinRect[], x: number, y: number, solid: boolean): P[] {
  if (!solid) return plats;
  return plats.filter((p) => {
    if (p.id >= 0) return true;
    const w = wins.find((v) => v.id === -p.id);
    return !!w && x > w.left && x < w.right && y > w.top;
  });
}

/** Mirando a la pared: la izquierda de la ventana queda a su derecha. */
export const wallFacing = (w: Wall): 1 | -1 => (w.side === "left" ? 1 : -1);

/** Medidas de Pupus y del área para elegir pared (px CSS). */
export interface ClimbDims {
  halfW: number;
  height: number;
  areaWidth: number;
  /** Lo más lejos que va andando hasta la pared. */
  maxWalk: number;
}

/** Superficie en la que está: tramo [left, right] a la altura `y` de los pies. */
export interface Footing {
  x: number;
  y: number;
  left: number;
  right: number;
}

/**
 * Pared a la que subir desde donde está: alcanzable andando por su superficie,
 * con algo que trepar (la esquina de arriba por encima de su cabeza) y con
 * el tramo visible llegando hasta sus manos. La más cercana.
 */
export function wallToClimbUp(walls: Wall[], at: Footing, d: ClimbDims): Wall | null {
  let best: Wall | null = null;
  let bestD = Infinity;
  for (const w of walls) {
    const bx = wallBodyX(w, d.halfW);
    if (!wallFits(w, d.halfW, d.areaWidth)) continue;
    if (bx < at.left || bx > at.right) continue;
    if (w.top >= at.y - d.height || w.bottom < at.y - d.height / 2) continue;
    const dist = Math.abs(bx - at.x);
    if (dist <= d.maxWalk && dist < bestD) {
      best = w;
      bestD = dist;
    }
  }
  return best;
}

/**
 * Pared por la que bajar desde el borde superior de la ventana `winId` en el
 * que está: la de la esquina más cercana, con sitio fuera para colgarse y al
 * menos dos cuerpos de tramo visible.
 */
export function wallToClimbDown(walls: Wall[], winId: number, at: Footing, d: ClimbDims): Wall | null {
  let best: Wall | null = null;
  let bestD = Infinity;
  for (const w of walls) {
    if (w.id !== winId || Math.abs(w.top - at.y) > 1) continue;
    if (!wallFits(w, d.halfW, d.areaWidth) || w.bottom - w.top < 2 * d.height) continue;
    const tx = wallTopX(w, d.halfW);
    if (tx < at.left || tx > at.right) continue;
    const dist = Math.abs(tx - at.x);
    if (dist <= d.maxWalk && dist < bestD) {
      best = w;
      bestD = dist;
    }
  }
  return best;
}
