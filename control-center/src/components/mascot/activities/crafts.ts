// Mascota — manualidades: barrer el polvo del borde de una ventana y lanzar
// un avión de papel.

import { lively } from "./play";
import type { Actor, ActivityDef, Px } from "./types";
import { alt, arms, num, once, walkLegs, WALK_PX } from "./util";

const WOOD = "#8A5A2B";

/** Polvo o arena en (x, y) px CSS, hacia `dir`. */
function puff(a: Actor, x: number, y: number, dir: number, color: string, n: number, rand: () => number) {
  for (let i = 0; i < n; i++) {
    a.effects.push({
      kind: "dust",
      x,
      y,
      vx: dir * (40 + rand() * 60),
      vy: -(30 + rand() * 70),
      age: 0,
      life: 0.4 + rand() * 0.3,
      color,
    });
  }
}

// ---------------------------------------------------------------------------
// Barrer
// ---------------------------------------------------------------------------

const SWEEP_SPEED = 0.4; // fracción de la velocidad de paseo
const SWEEP_EVERY = 0.4;

/** Escoba (origen en los pies): palo en diagonal y cerdas que se mueven. */
export function broomPx(swish: boolean): Px[] {
  const d = swish ? 1 : 0;
  return [
    [6, -7, 1, 1, WOOD],
    [7, -6, 1, 2, WOOD],
    [8, -4, 1, 2, WOOD],
    [9, -2, 1, 1, WOOD],
    [8 + d, -1, 4, 1, "#E0B84A"],
    [9 + d, -2, 2, 1, "#C99A2E"],
  ];
}

export const barrer: ActivityDef = {
  id: "barrer",
  dur: [8, 12],
  cooldownS: 480,
  weight: (c) => (!lively(c) || c.outfit === "car" ? 0 : c.onWindow ? 3 : 1),
  begin(_run, a, _kit, ctx) {
    if (ctx.ahead < 40 && ctx.behind > ctx.ahead) a.facing = a.facing === 1 ? -1 : 1;
  },
  step(run, a, kit, inp) {
    if (!kit.moveX(a, a.facing * WALK_PX * SWEEP_SPEED * a.S * inp.dt)) a.facing = a.facing === 1 ? -1 : 1;
    const k = Math.floor(inp.tt / SWEEP_EVERY);
    once(run, inp.tt, `d${k}`, k * SWEEP_EVERY, () => {
      puff(a, a.x + a.facing * 10 * a.S, a.y - a.S, a.facing, "#D2C8BE", 3, kit.rand);
    });
    if (inp.tt < run.dur) return "go";
    // El polvo hace estornudar.
    return kit.rand() < 0.25 ? "sneeze" : "idle";
  },
  pose(_run, tt, p) {
    p.legs = walkLegs(tt, SWEEP_SPEED);
    const s = alt(tt, 5);
    arms(p, s ? "type2" : "type1", s ? "type1" : "type2");
    p.lookY = 1;
    p.lookX = 0.6;
    return null;
  },
  props: (_run, tt) => [{ anchor: "feet", px: broomPx(alt(tt, 5)) }],
};

// ---------------------------------------------------------------------------
// Avión de papel
// ---------------------------------------------------------------------------

export const FOLD_S = 1.5;
/** Hueco libre mínimo (px CSS) para lanzarlo. */
export const PLANE_ROOM = 250;
const PAPER = { sheet: "#F4F1EA", fold: "#C9C3B6", edge: "#9A958B" };

/** Hoja en las manos mientras la dobla (origen en la coronilla). */
export function paperPx(tt: number): Px[] {
  if (tt < 0.5) return [[4, 1, 4, 5, PAPER.sheet], [7, 1, 1, 1, PAPER.fold]];
  if (tt < 1.0) return [[4, 3, 4, 3, PAPER.sheet], [4, 3, 4, 1, PAPER.fold]];
  return [[3, 5, 5, 1, PAPER.sheet], [4, 4, 3, 1, PAPER.sheet], [6, 3, 1, 1, PAPER.fold], [3, 6, 2, 1, PAPER.edge]];
}

export const avion: ActivityDef = {
  id: "avion",
  dur: [8, 8],
  cooldownS: 420,
  weight(c) {
    if (!lively(c) || Math.max(c.ahead, c.behind) < PLANE_ROOM) return 0;
    return ["feliz", "jugueton", "curioso"].includes(c.state) ? 3.5 : 2.5;
  },
  begin(_run, a, _kit, ctx) {
    if (ctx.ahead < PLANE_ROOM) a.facing = a.facing === 1 ? -1 : 1;
  },
  step(run, a, kit, inp) {
    once(run, inp.tt, "throw", FOLD_S + 0.1, () => {
      const y = a.y - a.height + 2 * a.S;
      run.data.plane = kit.spawn({ kind: "plane", x: a.x + a.facing * 8 * a.S, y, vx: a.facing * 220, vy: -50, life: 40, stage: 0, seed: kit.rand(), r: 0 });
      a.kick(5, -5);
    });
    const plane = run.data.plane ? kit.item(num(run, "plane")) : undefined;
    if (plane) {
      run.data.lookX = Math.sign(plane.x - a.x) * a.facing;
      run.data.lookY = plane.y < a.y - a.height ? -1 : 0;
      if (plane.landed && !run.data.landedAt) run.data.landedAt = inp.tt;
    }
    const settled = run.data.landedAt && inp.tt > num(run, "landedAt") + 1.2;
    return settled || inp.tt >= run.dur ? "idle" : "go";
  },
  pose(run, tt, p) {
    if (tt < FOLD_S) {
      arms(p, alt(tt, 6) ? "type1" : "type2", alt(tt, 6) ? "type2" : "type1");
      p.lookY = 1;
      p.lookX = 0.5;
      return null;
    }
    if (tt < FOLD_S + 0.4) {
      p.armR = "up";
      p.armL = "out";
      return "happy";
    }
    p.lookX = num(run, "lookX", 1);
    p.lookY = num(run, "lookY");
    return null;
  },
  props: (_run, tt) => (tt < FOLD_S + 0.1 ? [{ anchor: "head", px: paperPx(tt) }] : []),
};
