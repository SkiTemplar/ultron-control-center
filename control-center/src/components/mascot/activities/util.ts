// Mascota — utilidades comunes de los guiones de actividades (puras).

import type { Arm, Legs, Pose } from "../sprite";
import type { ActivityRun } from "./types";

/** Velocidad de paseo del motor: px de sprite por segundo. */
export const WALK_PX = 14;

/** Ejecuta `fn` una sola vez cuando `tt` pasa de `at`. */
export function once(run: ActivityRun, tt: number, key: string, at: number, fn: () => void) {
  if (tt < at || run.marks.has(key)) return;
  run.marks.add(key);
  fn();
}

/** Alterna true/false `hz` veces por segundo. */
export function alt(tt: number, hz: number): boolean {
  return Math.floor(tt * hz) % 2 === 0;
}

/** Bote de altura `h` con periodo `period` (siempre ≥ 0). */
export function bounce(tt: number, period: number, h: number): number {
  return Math.abs(Math.sin((Math.PI * tt) / period)) * h;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Valor entre `lo` y `hi` según `r` en [0, 1). */
export function between(lo: number, hi: number, r: number): number {
  return lo + (hi - lo) * r;
}

/** Patas de paseo según el tiempo (mismo ciclo que el motor). */
export function walkLegs(tt: number, speed = 1): Legs {
  const step = Math.floor(tt * 8 * speed) % 4;
  return step === 0 ? "walk1" : step === 2 ? "walk2" : "stand";
}

/** Los dos brazos en la misma postura. */
export function arms(p: Pose, a: Arm, b: Arm = a) {
  p.armL = a;
  p.armR = b;
}

/** Sentado: patas recogidas. */
export function sit(p: Pose) {
  p.legs = "tuck";
}

/** Dirección de `from` a `to` (-1 o 1). */
export function dirTo(from: number, to: number): 1 | -1 {
  return to < from ? -1 : 1;
}

/** Número de `data` o el valor por defecto. */
export function num(run: ActivityRun, key: string, dflt = 0): number {
  return run.data[key] ?? dflt;
}
