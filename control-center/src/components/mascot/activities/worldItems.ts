// Mascota — física de los objetos que dejan las actividades en el mundo:
// avión de papel, pompas, pelota de malabares, mariposa y estrella fugaz.
// Funciones puras: devuelven copias nuevas y nunca mutan la entrada. Unidades: px CSS y segundos, como el motor.

import type { Platform } from "../world";
import type { ItemEvent, WorldItem } from "./types";

export interface ItemsEnv {
  cursor: { x: number; y: number } | null;
  plats: Platform[];
  W: number;
  H: number;
}

interface Stepped {
  item: WorldItem | null;
  events: ItemEvent[];
}

/** Lo que el cursor tiene que acercarse a una pompa para reventarla, además de su radio. */
export const POP_MARGIN = 6;
/** Lo que reposa el avión en el suelo antes de desvanecerse. */
export const PLANE_REST_S = 20;
const PLANE_GLIDE_G = 40;
const BALL_G = 1800;
const BUBBLE_RISE = 25;

const keep = (item: WorldItem): Stepped => ({ item, events: [] });
const gone: Stepped = { item: null, events: [] };

/** Primer borde (plataforma o suelo) que cruza al bajar de y0 a y1 en x, o null. */
export function landingTop(plats: Platform[], H: number, x: number, y0: number, y1: number): number | null {
  let best: number | null = null;
  for (const p of plats) {
    if (x < p.left || x > p.right || y0 > p.top + 0.5 || y1 < p.top) continue;
    if (best === null || p.top < best) best = p.top;
  }
  if (best !== null) return best;
  return y1 >= H ? H : null;
}

function stepPlane(it: WorldItem, dt: number, env: ItemsEnv): Stepped {
  const age = it.age + dt;
  if (it.landed) return age >= it.life ? gone : keep({ ...it, age });
  const near = env.cursor && Math.hypot(env.cursor.x - it.x, env.cursor.y - it.y) < 18;
  const loop = near && it.stage === 0;
  let vy = loop ? -170 : it.vy + (PLANE_GLIDE_G - Math.sin(age * 3) * 30) * dt;
  vy = Math.min(vy, 140);
  let vx = it.vx * (1 - 0.08 * dt);
  let x = it.x + vx * dt;
  const y = it.y + vy * dt;
  if (x < 0 || x > env.W) {
    x = Math.min(Math.max(x, 0), env.W);
    vx = -vx * 0.6;
  }
  const top = vy > 0 ? landingTop(env.plats, env.H, x, it.y, y) : null;
  const stage = loop ? 1 : it.stage;
  if (top === null) return keep({ ...it, age, x, y: Math.max(0, y), vx, vy, stage });
  const landed = { ...it, age, x, y: top, vx: 0, vy: 0, stage, landed: true, life: age + PLANE_REST_S };
  return { item: landed, events: [{ kind: "planeLanded", x, y: top, dist: Math.abs(x - it.x0) }] };
}

function stepBubble(it: WorldItem, dt: number, env: ItemsEnv): Stepped {
  const age = it.age + dt;
  const x = it.x + Math.sin(age * 2 + it.seed * 6) * 15 * dt;
  const y = it.y - BUBBLE_RISE * dt;
  const c = env.cursor;
  if (c && Math.hypot(c.x - x, c.y - y) <= it.r + POP_MARGIN) {
    return { item: null, events: [{ kind: "bubblePop", x, y }] };
  }
  if (age >= it.life || y < -it.r) return gone;
  return keep({ ...it, age, x, y });
}

function stepBall(it: WorldItem, dt: number, env: ItemsEnv): Stepped {
  const age = it.age + dt;
  if (age >= it.life) return gone;
  if (it.landed) return keep({ ...it, age });
  let vx = it.vx;
  let vy = it.vy + BALL_G * dt;
  const x = Math.min(Math.max(it.x + vx * dt, 0), env.W);
  let y = it.y + vy * dt;
  const top = vy > 0 ? landingTop(env.plats, env.H, x, it.y, y) : null;
  let landed = false;
  if (top !== null) {
    y = top;
    vy = Math.abs(vy) > 120 ? -vy * 0.4 : 0;
    vx *= vy === 0 ? 1 - Math.min(1, 3 * dt) : 0.8;
    landed = vy === 0 && Math.abs(vx) < 5;
  }
  return keep({ ...it, age, x, y, vx, vy, landed });
}

function stepButterfly(it: WorldItem, dt: number, env: ItemsEnv): Stepped {
  const age = it.age + dt;
  if (age >= it.life) return gone;
  if (it.stage === 1) return keep({ ...it, age });
  if (it.stage === 2) {
    const x = it.x + it.vx * dt;
    const y = it.y + it.vy * dt;
    return x < -20 || x > env.W + 20 || y < -20 ? gone : keep({ ...it, age, x, y });
  }
  const vx = 45 * Math.sin(age * 0.9 + it.seed * 10);
  const vy = 30 * Math.sin(age * 1.7 + it.seed * 4);
  const x = Math.min(Math.max(it.x + vx * dt, 10), env.W - 10);
  const y = Math.min(Math.max(it.y + vy * dt, 20), env.H - 20);
  return keep({ ...it, age, x, y, vx, vy });
}

function stepStar(it: WorldItem, dt: number): Stepped {
  const age = it.age + dt;
  if (age >= it.life) return gone;
  return keep({ ...it, age, x: it.x + it.vx * dt, y: it.y + it.vy * dt });
}

function stepOne(it: WorldItem, dt: number, env: ItemsEnv): Stepped {
  switch (it.kind) {
    case "plane":
      return stepPlane(it, dt, env);
    case "bubble":
      return stepBubble(it, dt, env);
    case "ball":
      return stepBall(it, dt, env);
    case "butterfly":
      return stepButterfly(it, dt, env);
    case "star":
      return stepStar(it, dt);
  }
}

/** Avanza todos los objetos `dt` segundos. No muta `items`. */
export function stepItems(
  items: readonly WorldItem[],
  dt: number,
  env: ItemsEnv,
): { items: WorldItem[]; events: ItemEvent[] } {
  const out: WorldItem[] = [];
  const events: ItemEvent[] = [];
  for (const it of items) {
    const s = stepOne(it, dt, env);
    if (s.item) out.push(s.item);
    events.push(...s.events);
  }
  return { items: out, events };
}

/** Opacidad al final de la vida (se desvanece en los últimos `fadeS` segundos). */
export function itemAlpha(it: WorldItem, fadeS = 5): number {
  return Math.max(0, Math.min(1, (it.life - it.age) / fadeS));
}
