// Mascota — geometría multipantalla, en funciones puras (con tests).
//
// La ventana de Pupus cubre el área de trabajo de UN monitor (Env, en px
// físicos). Para saber por dónde puede salir a otro monitor y adónde, la
// app cruza su Env con la lista de monitores (mascot_screens, px físicos).

import type { Exits, Mode, Side } from "./engine";

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export interface Env {
  origin_x: number;
  origin_y: number;
  width: number;
  height: number;
  scale_factor: number;
  supported: boolean;
}

export interface ScreenInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  work_x: number;
  work_y: number;
  work_width: number;
  work_height: number;
  scale: number;
  current: boolean;
}

/** Tolerancia (px físicos) para considerar dos monitores pegados. */
const SNAP = 4;

/** Tramos de los bordes izquierdo y derecho (px CSS) que dan a otro monitor. */
export function exitsFor(env: Env, screens: ScreenInfo[]): Exits {
  const s = env.scale_factor || 1;
  const top = env.origin_y;
  const bottom = env.origin_y + env.height;
  const left = env.origin_x;
  const right = env.origin_x + env.width;
  const out: Exits = { left: [], right: [] };
  for (const m of screens) {
    if (m.current) continue;
    const a = Math.max(top, m.y);
    const b = Math.min(bottom, m.y + m.height);
    if (b - a < 20) continue; // apenas se tocan: no hay paso
    const span: [number, number] = [(a - top) / s, (b - top) / s];
    if (Math.abs(m.x - right) <= SNAP) out.right.push(span);
    if (Math.abs(m.x + m.width - left) <= SNAP) out.left.push(span);
  }
  return out;
}

/** ¿El punto físico (px, py) cae dentro del área de la ventana actual? */
export function insideEnv(env: Env, px: number, py: number): boolean {
  return px >= env.origin_x && px < env.origin_x + env.width && py >= env.origin_y && py < env.origin_y + env.height;
}

export function screenAt(screens: ScreenInfo[], px: number, py: number): ScreenInfo | null {
  return screens.find((m) => px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height) ?? null;
}

/**
 * Punto físico alcanzable más cercano a (px, py): él mismo si cae en el área
 * de trabajo de algún monitor; si no (encima de un monitor desalineado, en
 * una barra de tareas, en un hueco), el más próximo de las áreas de trabajo.
 * Sin monitores, null. Sin esto, un destino de nadie hace rebotar la ventana
 * entre dos monitores para siempre.
 */
export function reachablePoint(screens: readonly ScreenInfo[], px: number, py: number): { x: number; y: number } | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (const m of screens) {
    const x = clamp(px, m.work_x, m.work_x + m.work_width - 1);
    const y = clamp(py, m.work_y, m.work_y + m.work_height - 1);
    const d = Math.hypot(x - px, y - py);
    if (!best || d < best.d) best = { x, y, d };
  }
  return best && { x: best.x, y: best.y };
}

/** Punto físico justo al otro lado del borde `side`, a la altura `cssY`. */
export function acrossEdge(env: Env, side: Side, cssY: number): { x: number; y: number } {
  const y = Math.round(env.origin_y + cssY * env.scale_factor);
  return side === "right" ? { x: env.origin_x + env.width + 2, y } : { x: env.origin_x - 3, y };
}

/** Lado hacia el que queda un punto físico fuera de la ventana actual. */
export function sideToward(env: Env, px: number): Side {
  return px >= env.origin_x + env.width / 2 ? "right" : "left";
}

/** Físico → CSS de la ventana actual. */
export function toCssPoint(env: Env, px: number, py: number): { x: number; y: number } {
  return { x: (px - env.origin_x) / env.scale_factor, y: (py - env.origin_y) / env.scale_factor };
}

/** Modos en los que Pupus va pegado al cursor y debe seguirlo de monitor. */
const FOLLOWS_CURSOR: ReadonlySet<Mode> = new Set<Mode>(["drag", "drive"]);

/**
 * ¿Hay que mudar la ventana al monitor del cursor? Sí si Pupus va pegado a
 * él (arrastrado por ti o conducido por el MCP, que trabaja en el monitor
 * principal), el cursor ha salido del área actual y cae en algún monitor.
 */
export function shouldHopWithCursor(
  mode: Mode,
  env: Env,
  cursor: { x: number; y: number } | null,
  screens: ScreenInfo[],
): boolean {
  if (!cursor || !FOLLOWS_CURSOR.has(mode)) return false;
  return !insideEnv(env, cursor.x, cursor.y) && screenAt(screens, cursor.x, cursor.y) !== null;
}
