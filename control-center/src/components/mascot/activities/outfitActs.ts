// Mascota — actividades con disfraz de juego (gameOutfits.ts): catalejo de
// pirata, arrastrarse con el chaleco táctico y conducir el coche. Solo se
// eligen con ese disfraz puesto; en silencio de juego las pide
// useForeground con el tramo de suelo libre (nunca pisan el juego).

import type { Body } from "../outfits";
import type { ActivityDef, ActivityId, Px } from "./types";
import { alt, arms, once, WALK_PX } from "./util";

/** Actividad propia de cada disfraz. */
export const OUTFIT_ACTIVITY: Record<Body, ActivityId> = {
  eyepatch: "catalejo",
  vest: "arrastrarse",
  car: "conducir",
};

const flip = (f: 1 | -1): 1 | -1 => (f === 1 ? -1 : 1);

// ---------------------------------------------------------------------------
// Catalejo (pirata): lo apoya en el ojo sin parche, el de atrás.
// ---------------------------------------------------------------------------

const SCOPE: Px[] = [
  [-8, 1, 2, 3, "#8A6A1E"],
  [-11, 1, 3, 2, "#C9A227"],
  [-14, 1, 3, 2, "#E0BC4A"],
  [-15, 1, 1, 2, "#9AD1FF"],
];

/** Catalejo desplegándose: un tramo cada 0,25 s (origen en la coronilla). */
export function scopePx(tt: number): Px[] {
  const n = Math.min(SCOPE.length, Math.floor(tt / 0.25) + 1);
  return SCOPE.slice(0, n);
}

export const catalejo: ActivityDef = {
  id: "catalejo",
  dur: [6, 6],
  cooldownS: 300,
  weight: (c) => (c.outfit === "eyepatch" && !c.night ? 6 : 0),
  begin(run, _a, kit) {
    run.data.spotAt = 2 + kit.rand() * 2.5;
  },
  step(run, a, _kit, inp) {
    once(run, inp.tt, "spot", run.data.spotAt, () => {
      a.showIcon("exclaim", 1.2);
      a.kick(3, -4);
    });
    return inp.tt < run.dur ? "go" : "idle";
  },
  pose(run, tt, p) {
    p.armL = "wave1";
    p.armR = "down";
    p.lookX = -1;
    const spotted = tt >= run.data.spotAt;
    if (spotted) p.brows = "up";
    return spotted && tt < run.data.spotAt + 0.6 ? "wide" : null;
  },
  props: (_run, tt) => [{ anchor: "head", px: scopePx(tt) }],
};

// ---------------------------------------------------------------------------
// Arrastrarse (táctico): cuerpo a tierra, avance lento y asomarse al final.
// ---------------------------------------------------------------------------

const CRAWL_S = 5;

export const arrastrarse: ActivityDef = {
  id: "arrastrarse",
  dur: [6, 6],
  cooldownS: 300,
  weight: (c) => (c.outfit === "vest" && !c.night ? 6 : 0),
  begin(_run, a, _kit, ctx) {
    if (ctx.ahead < 30 && ctx.behind > ctx.ahead) a.facing = flip(a.facing);
  },
  step(run, a, kit, inp) {
    if (inp.tt < CRAWL_S && !kit.moveX(a, a.facing * 0.45 * WALK_PX * a.S * inp.dt)) a.facing = flip(a.facing);
    return inp.tt < run.dur ? "go" : "idle";
  },
  pose(_run, tt, p) {
    if (tt >= CRAWL_S) {
      p.sy = 0.7;
      p.dx = 1;
      p.brows = "up";
      p.lookX = 1.4;
      p.legs = "none";
      arms(p, "flat");
      return "wide";
    }
    p.sy = 0.6;
    p.sx = 1.25;
    p.legs = "none";
    const s = alt(tt, 3);
    arms(p, s ? "flat" : "type2", s ? "type2" : "flat");
    p.brows = "flat";
    p.lookX = 1;
    return null;
  },
};

// ---------------------------------------------------------------------------
// Conducir (coche): ida y vuelta por su superficie, con humo y bocinazo.
// ---------------------------------------------------------------------------

const DRIVE_SPEED = 3; // veces la velocidad de paseo
/** Primeros segundos con turbo (gameOutfits.ts pinta la llama con las patas «run»). */
const BOOST_S = 1;

export const conducir: ActivityDef = {
  id: "conducir",
  dur: [8, 15],
  cooldownS: 120,
  weight: (c) => (c.outfit === "car" && !c.calmOnly && !c.night ? 8 : 0),
  begin(_run, a, _kit, ctx) {
    if (ctx.ahead < 60 && ctx.behind > ctx.ahead) a.facing = flip(a.facing);
    a.kick(3, -3);
  },
  step(run, a, kit, inp) {
    if (!kit.moveX(a, a.facing * DRIVE_SPEED * WALK_PX * a.S * inp.dt)) {
      a.facing = flip(a.facing);
      a.showIcon("note", 0.8);
    }
    const k = Math.floor(inp.tt / 0.3);
    once(run, inp.tt, `smoke${k}`, k * 0.3, () => {
      a.effects.push({ kind: "dust", x: a.x - a.facing * 11 * a.S, y: a.y - 2 * a.S, vx: -a.facing * 30, vy: -25, age: 0, life: 0.6, color: "#9A9A9A" });
    });
    once(run, inp.tt, "honk", run.dur * 0.5, () => a.showIcon("note", 1.0));
    return inp.tt < run.dur ? "go" : "idle";
  },
  pose(_run, tt, p) {
    p.legs = tt < BOOST_S ? (alt(tt, 10) ? "run1" : "run2") : "tuck";
    p.armR = "type1";
    p.armL = "out";
    p.lookX = 1;
    return tt < BOOST_S ? "happy" : null;
  },
};
