// Mascota — planificar un viaje: ¿se llega saltando de ventana en ventana o
// hay que sacar la hélice? Funciones puras (px CSS de la ventana), con tests.
//
// Una «superficie» es un sitio donde posarse: el suelo (borde superior de la
// barra de tareas) o el borde superior visible de una ventana. El viaje se
// replanifica tras cada aterrizaje (`nextHop`), así que si un salto acaba en
// otra ventana por el camino, se sigue desde allí.

import type { Platform } from "./world";

export interface Surface {
  /** id de la ventana o "floor". */
  id: number | "floor";
  left: number;
  right: number;
  top: number;
}

export interface Limits {
  /** Medio ancho de la mascota: no se posa a menos de esto de un borde. */
  hw: number;
  /** Subida máxima de un salto (px). */
  maxRise: number;
  /** Distancia horizontal máxima entre bordes de un salto (px). */
  maxReach: number;
}

export interface Hop {
  /** Dónde coger impulso en la superficie actual. */
  takeoffX: number;
  /** Dónde caer en la siguiente. */
  landX: number;
  to: Surface;
}

export function floorSurface(W: number, H: number): Surface {
  return { id: "floor", left: 0, right: W, top: H };
}

/**
 * Superficies del viaje. `gaps` = tramos del suelo entre las islas de una
 * barra transparente (world.ts, floorGaps); sin islas, el suelo entero.
 */
export function surfacesOf(plats: Platform[], W: number, H: number, gaps: [number, number][] = [[0, W]]): Surface[] {
  const floors = gaps.map(([left, right]): Surface => ({ id: "floor", left, right, top: H }));
  return [...floors, ...plats.map((p) => ({ id: p.id, left: p.left, right: p.right, top: p.top }))];
}

/**
 * Carrerilla (px) delante de una pared para saltar a lo alto de ella sin
 * chocar con su lateral. El salto de `planJump` lleva velocidad horizontal
 * constante y sube hasta `apex` px por encima del destino: los pies deben
 * pasar el borde superior (subida `rise`) antes de que el cuerpo llegue a la
 * pared. `ahead` = medio ancho + lo que cae dentro de la plataforma.
 */
export function wallRunUp(rise: number, apex: number, ahead: number): number {
  if (rise <= 0) return 0;
  const a = Math.sqrt(rise + apex);
  const b = Math.sqrt(apex);
  const share = (a - b) / (a + b); // parte del recorrido hecha al pasar el borde
  return (share * ahead) / (1 - share);
}

export function sameSurface(a: Surface, b: Surface): boolean {
  return a.id === b.id && Math.abs(a.top - b.top) < 1 && a.left < b.right && b.left < a.right;
}

/** Tramo donde caben los pies sin asomar por los bordes. */
function standable(s: Surface, hw: number): [number, number] | null {
  const lo = s.left + hw;
  const hi = s.right - hw;
  return hi >= lo ? [lo, hi] : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Superficie a la que apunta un clic en (x, y): el borde de una ventana si
 * se clica cerca de él (en la barra de título o justo encima), el suelo si
 * se clica cerca de la barra de tareas, o null (= en el aire: colgarse ahí).
 */
export function surfaceAt(surfaces: Surface[], x: number, y: number, hw: number): Surface | null {
  let best: Surface | null = null;
  for (const s of surfaces) {
    const st = standable(s, hw);
    if (!st || x < s.left || x > s.right) continue;
    const below = y - s.top; // > 0: el clic está por debajo del borde
    const near = s.id === "floor" ? below > -60 : below > -40 && below < 36;
    if (near && (!best || Math.abs(s.top - y) < Math.abs(best.top - y))) best = s;
  }
  return best;
}

function canHop(a: Surface, b: Surface, lim: Limits): Hop | null {
  // De un tramo de suelo a otro hay una isla de la barra en medio: se sube a ella.
  if (a.id === "floor" && b.id === "floor") return null;
  const sa = standable(a, lim.hw);
  const sb = standable(b, lim.hw);
  if (!sa || !sb) return null;
  if (a.top - b.top > lim.maxRise) return null; // demasiado alto
  // Hueco horizontal entre los dos tramos (0 si se solapan).
  const gap = Math.max(0, sb[0] - sa[1], sa[0] - sb[1]);
  if (gap > lim.maxReach) return null;
  if (gap === 0) {
    // Solapan: salta en vertical desde el punto común más cercano.
    const x = clamp((Math.max(sa[0], sb[0]) + Math.min(sa[1], sb[1])) / 2, sa[0], sa[1]);
    return { takeoffX: x, landX: clamp(x, sb[0], sb[1]), to: b };
  }
  const goingRight = sb[0] > sa[1];
  const takeoffX = goingRight ? sa[1] : sa[0];
  // Cae un poco dentro para no quedarse en el filo.
  const inset = Math.min(2 * lim.hw, (sb[1] - sb[0]) / 2);
  const landX = goingRight ? sb[0] + inset : sb[1] - inset;
  return { takeoffX, landX, to: b };
}

/**
 * Primer salto del camino más corto (en saltos) de `cur` a `goal`, o null
 * si no hay camino de como mucho `maxHops` saltos.
 */
export function nextHop(cur: Surface, goal: Surface, surfaces: Surface[], lim: Limits, maxHops = 6): Hop | null {
  if (sameSurface(cur, goal)) return null;
  const all = surfaces.some((s) => sameSurface(s, goal)) ? surfaces : [...surfaces, goal];
  const start = all.findIndex((s) => sameSurface(s, cur));
  const nodes = start >= 0 ? all : [cur, ...all];
  const from = start >= 0 ? start : 0;
  const prev = new Map<number, number>([[from, -1]]);
  let frontier = [from];
  for (let depth = 0; depth < maxHops && frontier.length; depth++) {
    const next: number[] = [];
    for (const i of frontier) {
      for (let j = 0; j < nodes.length; j++) {
        if (prev.has(j) || !canHop(nodes[i], nodes[j], lim)) continue;
        prev.set(j, i);
        if (sameSurface(nodes[j], goal)) {
          // Rebobinar hasta el primer salto.
          let k = j;
          while (prev.get(k) !== from) k = prev.get(k)!;
          return canHop(nodes[from], nodes[k], lim);
        }
        next.push(j);
      }
    }
    frontier = next;
  }
  return null;
}
