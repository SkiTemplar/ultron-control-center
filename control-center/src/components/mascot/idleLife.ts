// Mascota — microanimaciones en reposo: mirar a un lado, cambiar el peso de
// pata, rascarse, dar golpecitos con el pie, cabezadas, escalofríos…
//
// Solo en reposo (idle, sit) y, las de mirada, también andando. Nunca en el
// aire, arrastrado, colgado, espachurrado, volando, conduciendo el cursor ni
// durante una conversación. Qué micro toca y cada cuánto depende del estado
// (moodTable.ts). Pura salvo el azar, que se inyecta.

import type { ChatState, Mode } from "./engine";
import type { Eyes, Pose } from "./sprite";

export type MicroKind =
  | "glance"
  | "glanceEdge"
  | "lookBack"
  | "shiftWeight"
  | "scratch"
  | "footTap"
  | "nod"
  | "shiver"
  | "puffChest"
  | "typeAlong"
  | "sniff";

export interface MicroTraits {
  micro: readonly [MicroKind, number][];
  /** Hueco entre micros, en segundos [mín, máx]. */
  microGap: readonly [number, number];
}

export interface Overlay {
  pose: Partial<Pose>;
  eyes: Eyes | null;
}

/** Duración de cada micro, en segundos. */
export const MICRO_DURATION: Record<MicroKind, number> = {
  glance: 0.9,
  glanceEdge: 1.4,
  lookBack: 1.1,
  shiftWeight: 1.2,
  scratch: 1.5,
  footTap: 1.4,
  nod: 1.2,
  shiver: 0.6,
  puffChest: 1.5,
  typeAlong: 1.5,
  sniff: 0.9,
};

const LIVELY: ReadonlySet<Mode> = new Set<Mode>(["idle", "sit", "walk"]);
/** Andando solo se mueve la mirada: lo demás pisaría el paso. */
const ON_WALK: ReadonlySet<MicroKind> = new Set<MicroKind>(["glance", "glanceEdge", "lookBack"]);

const alt = (t: number, hz: number) => Math.floor(t * hz) % 2 === 0;

/** Pose de un micro en su fase `k` (0..1); `side` = ±1 (a qué lado). */
export function microPose(kind: MicroKind, k: number, t: number, side: 1 | -1): Overlay {
  switch (kind) {
    case "glance":
      return { pose: { lookX: side * 1.4, lookY: -0.2 }, eyes: null };
    case "glanceEdge":
      return { pose: { lookX: side * 1.4, lookY: 0.6 }, eyes: k > 0.45 && k < 0.55 ? "blink" : null };
    case "lookBack":
      return { pose: { lookX: -1.4, brows: "up" }, eyes: null };
    case "shiftWeight":
      return { pose: { dx: k < 0.5 ? side : 0, sx: 1.04, sy: 0.97 }, eyes: null };
    case "scratch":
      return { pose: { armR: "scratch", lookY: -0.5 }, eyes: k > 0.25 && k < 0.75 ? "closed" : null };
    case "footTap":
      return { pose: { legs: alt(t, 6) ? "walk1" : "stand" }, eyes: null };
    case "nod":
      // Cabezada: se le cae la cabeza y se despierta de golpe.
      return k < 0.7 ? { pose: { lookY: 1, sy: 0.94 }, eyes: "closed" } : { pose: { lookY: -0.4 }, eyes: "wide" };
    case "shiver":
      return { pose: { dx: alt(t, 14) ? 1 : 0, armL: "down", armR: "down" }, eyes: "wide" };
    case "puffChest":
      return { pose: { sx: 0.96, sy: 1.08, armL: "hips", armR: "hips", lookY: -0.8 }, eyes: null };
    case "typeAlong":
      return { pose: { armL: alt(t, 10) ? "type1" : "type2", armR: alt(t, 10) ? "type2" : "type1", lookY: 0.6 }, eyes: null };
    case "sniff":
      return { pose: { lift: Math.abs(Math.sin(k * Math.PI * 4)) * 0.4, lookY: 0.5, brows: "up" }, eyes: null };
  }
}

function pick(list: readonly [MicroKind, number][], r: number): MicroKind | null {
  const total = list.reduce((a, [, n]) => a + n, 0);
  if (total <= 0) return null;
  let left = r * total;
  for (const [k, n] of list) if ((left -= n) < 0) return k;
  return list[list.length - 1][0];
}

export class IdleLife {
  private cur: { kind: MicroKind; t0: number; side: 1 | -1 } | null = null;
  private nextAt = 2;

  /** Avanza al instante `t`: termina el micro en curso o lanza otro. */
  step(t: number, traits: MicroTraits, mode: Mode, chat: ChatState, rand: () => number) {
    const gap = () => traits.microGap[0] + rand() * (traits.microGap[1] - traits.microGap[0]);
    if (!LIVELY.has(mode) || chat !== "none") {
      this.cur = null;
      this.nextAt = Math.max(this.nextAt, t + 1);
      return;
    }
    if (this.cur && t - this.cur.t0 >= MICRO_DURATION[this.cur.kind]) {
      this.cur = null;
      this.nextAt = t + gap();
    }
    if (this.cur || t < this.nextAt) return;
    const options = mode === "walk" ? traits.micro.filter(([k]) => ON_WALK.has(k)) : traits.micro;
    const kind = pick(options, rand());
    if (kind) this.cur = { kind, t0: t, side: rand() < 0.5 ? -1 : 1 };
    else this.nextAt = t + gap();
  }

  /** Micro en curso (para tests y depuración). */
  current(): MicroKind | null {
    return this.cur?.kind ?? null;
  }

  /** Lo que el micro en curso cambia de la pose, o null. */
  overlay(t: number, mode: Mode): Overlay | null {
    const c = this.cur;
    if (!c || !LIVELY.has(mode)) return null;
    if (mode === "walk" && !ON_WALK.has(c.kind)) return null;
    const k = Math.min(1, Math.max(0, (t - c.t0) / MICRO_DURATION[c.kind]));
    const o = microPose(c.kind, k, t, c.side);
    if (mode !== "sit") return o;
    // Sentado, las patas siguen recogidas.
    const { legs: _legs, ...pose } = o.pose;
    return { pose, eyes: o.eyes };
  }
}
