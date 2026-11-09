// Mascota — partículas: polvo, anillos, chispas, corazones, notas y lágrimas.
//
// Funciones puras: reciben la caja de la mascota y el generador aleatorio y
// devuelven las partículas nuevas; el motor las añade a su lista. El orden de
// las llamadas a `rand` es parte del contrato (los tests usan semillas).

import type { Effect, EffectKind, Surface } from "./engineTypes";

/** Posición (centro de los pies) y medidas de la mascota, en px CSS. */
export interface BodyBox {
  readonly x: number;
  readonly y: number;
  readonly S: number;
  readonly halfW: number;
  readonly height: number;
}

const PARTICLE_GRAVITY: Record<EffectKind, number> = {
  dust: 300,
  ring: 0,
  spark: 140,
  heart: -30,
  note: -15,
  tear: 900,
};

/** Avanza las partículas `dt` segundos y devuelve las que siguen vivas. */
export function stepEffects(effects: Effect[], dt: number): Effect[] {
  for (const e of effects) {
    e.age += dt;
    if (e.kind === "heart" || e.kind === "note") e.vx = Math.sin(e.age * 5 + e.x) * 25;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.vy += PARTICLE_GRAVITY[e.kind] * dt;
  }
  return effects.filter((e) => e.age < e.life);
}

/** Estallido de `n` partículas alrededor del cuerpo. */
export function burstEffects(
  b: BodyBox,
  kind: EffectKind,
  n: number,
  color: string | undefined,
  spread: number,
  rand: () => number,
): Effect[] {
  const out: Effect[] = [];
  const cx = b.x;
  const cy = b.y - b.height * 0.6;
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const sp = (60 + rand() * 140) * spread;
    out.push({
      kind,
      x: cx + Math.cos(a) * b.halfW * 0.6,
      y: cy + Math.sin(a) * b.height * 0.3,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 60,
      age: 0,
      life: 0.5 + rand() * 0.5,
      color,
    });
  }
  return out;
}

/** Corazones o notas que suben flotando desde la cabeza. */
export function floatEffects(b: BodyBox, kind: "heart" | "note", n: number, rand: () => number): Effect[] {
  const out: Effect[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      kind,
      x: b.x + (rand() * 2 - 1) * b.halfW,
      y: b.y - b.height - b.S * 2,
      vx: (rand() * 2 - 1) * 20,
      vy: -40 - rand() * 30,
      age: 0,
      life: 1.2 + rand() * 0.5,
    });
  }
  return out;
}

/** Una lágrima que salta de un ojo. */
export function tearEffect(b: BodyBox, rand: () => number): Effect {
  const side = rand() < 0.5 ? -1 : 1;
  return {
    kind: "tear",
    x: b.x + side * 3 * b.S,
    y: b.y - b.height + 5 * b.S,
    vx: side * (20 + rand() * 30),
    vy: -60,
    age: 0,
    life: 0.7,
  };
}

/** Polvo del choque contra `side` (suelo, pared o techo). */
export function dustEffects(b: BodyBox, side: Surface, rand: () => number): Effect[] {
  const out: Effect[] = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / (n - 1) - 0.5) * Math.PI * 0.9;
    const sp = 60 + rand() * 90;
    let x = b.x;
    let y = b.y;
    let vx = Math.sin(a) * sp;
    let vy = -Math.abs(Math.cos(a)) * sp * 0.6;
    if (side === "left" || side === "right") {
      x = side === "left" ? b.x - b.halfW : b.x + b.halfW;
      y = b.y - b.height / 2;
      vx = (side === "left" ? 1 : -1) * Math.abs(Math.cos(a)) * sp * 0.6;
      vy = Math.sin(a) * sp;
    } else if (side === "ceil") {
      y = b.y - b.height;
      vy = Math.abs(vy);
    }
    out.push({ kind: "dust", x, y, vx, vy, age: 0, life: 0.35 + rand() * 0.2 });
  }
  return out;
}
