// Mascota — dónde está la cabeza de Pupus en cada fotograma.
//
// El gorro, la hélice, el fichero en brazos y los iconos se colocan respecto
// a la coronilla REAL del cuerpo pintado: altura con aplastamiento (sy),
// patas (recogidas, ninguna o de pie), bote (lift), respiración (breath),
// desplazamiento del cuerpo (dx/dy: meneo, mareo, pared, techo) y reflejo.
// La cuenta sale de las mismas funciones que usa drawPet (bodyRect y
// layerOffsets de sprite.ts), así que no pueden divergir.
//
// No hay rotación: el sprite es pixel art alineado a los ejes, así que el
// ancla lleva posición y anchura, no ángulo.

import { bodyRect, layerOffsets, type Pose } from "./sprite";
import type { Mode, Surface } from "./engine";

export interface HeadAnchor {
  /** Centro horizontal del cuerpo, px de dispositivo. */
  cx: number;
  /** Borde superior del cuerpo (coronilla), px de dispositivo. */
  top: number;
  /** Anchura del cuerpo, px de dispositivo. */
  w: number;
  facing: 1 | -1;
}

/** Ancla de la cabeza con los pies en (fx, fy) y un píxel de sprite = S. */
export function headAnchor(pose: Pose, fx: number, fy: number, S: number, facing: 1 | -1): HeadAnchor {
  const [x, y, w] = bodyRect(pose);
  const { liftPx, breathPx } = layerOffsets(pose, S);
  // drawPet refleja alrededor de fx: el centro del cuerpo (x + w/2) cambia
  // de lado con `facing`.
  return { cx: fx + facing * (x + w / 2) * S, top: fy + y * S - liftPx - breathPx, w: w * S, facing };
}

/** Altura de los brazos (fichero y calendario en la mano). */
export function armY(a: HeadAnchor, S: number): number {
  return a.top + 2 * S;
}

/** Altura de referencia de los iconos, estrellas y zetas (1 px sobre la coronilla). */
export function iconY(a: HeadAnchor, S: number): number {
  return a.top - S;
}

/** Qué pasa con el gorro en cada modo. */
export type HatPolicy = "on" | "off" | "knocked";

/**
 * Con la hélice no hay gorro (ocupa su sitio). Espachurrado contra el techo
 * o una pared se le cae: en el techo atravesaría el borde de arriba y en la
 * pared el ala (12-16 px) quedaría sobre un cuerpo de 6.
 */
export function hatPolicy(mode: Mode, splatSide: Surface): HatPolicy {
  if (mode === "fly") return "off";
  if (mode === "splat" && splatSide !== "floor") return "knocked";
  return "on";
}
