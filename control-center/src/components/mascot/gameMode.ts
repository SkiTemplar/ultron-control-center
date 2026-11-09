// Mascota — «no molestar» con un juego delante. Funciones puras (con tests).
//
// Mientras dura el silencio (lo decide Rust en desk_watch.rs): sin pasear
// por su cuenta, sin saltar a ventanas, sin travesuras con el cursor, sin
// bocadillos ni botones y atravesable. Si el juego va en ventana en su
// monitor, Pupus aparca en el tramo de suelo que el juego deja libre.

import type { MascotSettings } from "./settings";
import { subtractInterval } from "./world";

/** Copia de los ajustes con todo lo que podría molestar apagado. */
export function quietSettings(s: MascotSettings): MascotSettings {
  return { ...s, wander: false, jump: false, cursor_pranks: false };
}

/** Los ajustes que usa el motor según haya silencio o no. */
export function effectiveSettings(s: MascotSettings, quiet: boolean): MascotSettings {
  return quiet ? quietSettings(s) : s;
}

/** ¿La ventana debe recibir el ratón? Nunca en silencio. */
export function isInteractive(quiet: boolean, base: boolean): boolean {
  return !quiet && base;
}

/**
 * Tramos de suelo (x de los pies, px CSS) donde cabe Pupus sin pisar el
 * juego. `game` = rango horizontal del juego en px CSS, o null si no está
 * en este monitor (todo el suelo vale).
 */
export function freeFloorSpans(
  W: number,
  game: { left: number; right: number } | null,
  halfW: number,
): [number, number][] {
  const free: [number, number][] = game ? subtractInterval([[0, W]], game.left, game.right) : [[0, W]];
  return free.filter(([a, b]) => b - a >= 2 * halfW).map(([a, b]) => [a + halfW, b - halfW]);
}

/** Punto de `spans` más cercano a `x`, o null si no hay sitio. */
export function parkX(x: number, spans: [number, number][]): number | null {
  let best: number | null = null;
  for (const [a, b] of spans) {
    const p = Math.min(Math.max(x, a), b);
    if (best === null || Math.abs(p - x) < Math.abs(best - x)) best = p;
  }
  return best;
}

/** Paseo corto (±`reach`) sin salir del tramo en el que está. */
export function strollX(x: number, spans: [number, number][], rand: () => number, reach = 120): number | null {
  const span = spans.find(([a, b]) => x >= a - 1 && x <= b + 1);
  if (!span) return null;
  const t = x + (rand() * 2 - 1) * reach;
  return Math.min(Math.max(t, span[0]), span[1]);
}
