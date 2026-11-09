// Mascota — juego y ejercicio: malabares, pompas de jabón (se revientan con
// el cursor), voltereta y gimnasia de buena mañana.

import { nudge } from "../mood";
import type { MoodState } from "../moodState";
import type { ActivityCtx, ActivityDef, Px } from "./types";
import { alt, arms, between, bounce, once } from "./util";

const GLUM: ReadonlySet<MoodState> = new Set<MoodState>([
  "triste",
  "enfadado",
  "asustado",
  "celoso",
  "grunon",
  "cansado",
  "somnoliento",
]);

/** ¿Está para jaleo? Ni de noche, ni mientras te concentras, ni con mal cuerpo. */
export function lively(c: ActivityCtx): boolean {
  return !c.night && !c.calmOnly && !GLUM.has(c.state);
}

const by = (c: ActivityCtx, table: Partial<Record<MoodState, number>>, dflt = 0) =>
  lively(c) ? (table[c.state] ?? dflt) : 0;

// ---------------------------------------------------------------------------
// Malabares
// ---------------------------------------------------------------------------

const BALLS = ["#E5484D", "#5B8DEF", "#F5C451"];
const JUGGLE_HZ = 1.6;
/** Cuándo se le cae una bola, contando desde el final. */
const DROP_BEFORE_END = 0.9;

/** Posición de la bola `i` (origen en la coronilla): cascada entre las dos manos. */
export function ballAt(tt: number, i: number): [number, number] {
  const ph = (tt * JUGGLE_HZ + i / 3) % 1;
  if (ph < 0.5) {
    const s = ph * 2;
    return [Math.round(-7 + 14 * s), Math.round(5 - 12 * Math.sin(Math.PI * s))];
  }
  const s = (ph - 0.5) * 2;
  return [Math.round(7 - 14 * s), Math.round(5 - 3 * Math.sin(Math.PI * s))];
}

export const malabares: ActivityDef = {
  id: "malabares",
  dur: [6, 6],
  cooldownS: 240,
  weight: (c) => (c.outfit === "car" ? 0 : by(c, { feliz: 5, emocionado: 5, jugueton: 5, contento: 2, orgulloso: 2 })),
  begin(run, _a, kit) {
    run.data.drop = kit.rand() < 0.2 ? 1 : 0;
  },
  step(run, a, kit, inp) {
    if (run.data.drop) {
      once(run, inp.tt, "drop", run.dur - DROP_BEFORE_END, () => {
        kit.spawn({ kind: "ball", x: a.x + a.facing * 6 * a.S, y: a.y - a.height - 2 * a.S, vx: a.facing * 70, vy: -160, life: 6, stage: 0, seed: kit.rand(), r: a.S });
        a.showIcon("sweat", 1.2);
      });
    }
    return inp.tt < run.dur ? "go" : "idle";
  },
  pose(run, tt, p) {
    const dropped = run.data.drop && tt >= run.dur - DROP_BEFORE_END;
    if (dropped) {
      arms(p, "out");
      p.brows = "up";
      p.lookY = 1;
      return "wide";
    }
    const h = alt(tt, JUGGLE_HZ * 2);
    arms(p, h ? "up" : "type1", h ? "type1" : "up");
    p.lookY = -1;
    p.lookX = Math.sin(tt * Math.PI * JUGGLE_HZ) * 0.8;
    return null;
  },
  props(run, tt) {
    const dropped = run.data.drop && tt >= run.dur - DROP_BEFORE_END;
    const px: Px[] = [];
    BALLS.forEach((color, i) => {
      if (dropped && i === 0) return;
      const [x, y] = ballAt(tt, i);
      px.push([x - 1, y - 1, 2, 2, color]);
    });
    return [{ anchor: "head", px }];
  },
};

// ---------------------------------------------------------------------------
// Pompas de jabón
// ---------------------------------------------------------------------------

const BUBBLES = 5;
const BUBBLE_GAP = 0.75;
const WAND = { stick: "#8A5A2B", ring: "#7CC8FF" };

export const WAND_PX: Px[] = [
  [8, 1, 1, 4, WAND.stick],
  [8, -3, 3, 1, WAND.ring],
  [8, -1, 3, 1, WAND.ring],
  [8, -2, 1, 1, WAND.ring],
  [10, -2, 1, 1, WAND.ring],
];

export const pompas: ActivityDef = {
  id: "pompas",
  dur: [4.6, 4.6],
  cooldownS: 360,
  weight: (c) => by(c, { feliz: 3, jugueton: 3, contento: 3, curioso: 3 }),
  step(run, a, kit, inp) {
    for (let i = 0; i < BUBBLES; i++) {
      once(run, inp.tt, `b${i}`, 0.6 + i * BUBBLE_GAP, () => {
        const r = between(2, 4, kit.rand()) * a.S;
        const x = a.x + a.facing * 11 * a.S;
        const y = a.y - a.height - 2 * a.S;
        kit.spawn({ kind: "bubble", x, y, vx: 0, vy: -25, life: between(8, 12, kit.rand()), stage: 0, seed: kit.rand(), r });
        a.kick(2, -2);
      });
    }
    return inp.tt < run.dur ? "go" : "idle";
  },
  pose(_run, tt, p) {
    p.armR = "out";
    p.armL = "down";
    p.blush = true;
    const blowing = tt > 0.4 && (tt - 0.4) % BUBBLE_GAP < 0.3;
    if (blowing) p.sx = 1.08;
    p.lookX = 1;
    p.lookY = -0.6;
    return blowing ? "closed" : "happy";
  },
  props: () => [{ anchor: "head", px: WAND_PX }],
};

// ---------------------------------------------------------------------------
// Voltereta
// ---------------------------------------------------------------------------

const CROUCH_S = 0.15;
const QUARTER_S = 0.15;
const ROLL_S = 4 * QUARTER_S;
const ROLL_PX = 8; // px de sprite que avanza rodando

/** Cuartos de giro de la voltereta en el instante `tt` (0 fuera del giro). */
export function rollQuarter(tt: number): 0 | 1 | 2 | 3 {
  if (tt < CROUCH_S || tt >= CROUCH_S + ROLL_S) return 0;
  return ((Math.floor((tt - CROUCH_S) / QUARTER_S) + 1) % 4) as 0 | 1 | 2 | 3;
}

export const voltereta: ActivityDef = {
  id: "voltereta",
  dur: [1.1, 1.1],
  cooldownS: 120,
  weight: (c) => (c.outfit ? 0 : by(c, { emocionado: 6, feliz: 3, jugueton: 3, contento: 1 })),
  begin(_run, a, _kit, ctx) {
    if (ctx.ahead < 14 * a.S && ctx.behind > ctx.ahead) a.facing = a.facing === 1 ? -1 : 1;
  },
  step(run, a, kit, inp) {
    const rolling = inp.tt >= CROUCH_S && inp.tt < CROUCH_S + ROLL_S;
    if (rolling) kit.moveX(a, (a.facing * ROLL_PX * a.S * inp.dt) / ROLL_S);
    once(run, inp.tt, "land", CROUCH_S + ROLL_S, () => {
      a.burst("dust", 6, "#D2C8BE", 0.6);
      a.kick(6, -6);
      a.mood = nudge(a.mood, { happy: 0.08, boredom: -0.4 });
    });
    return inp.tt < run.dur ? "go" : "idle";
  },
  pose(_run, tt, p) {
    if (tt < CROUCH_S) {
      p.sx = 1.15;
      p.sy = 0.8;
      p.legs = "tuck";
      arms(p, "down");
      return "squint";
    }
    if (tt < CROUCH_S + ROLL_S) {
      p.rot = rollQuarter(tt);
      p.lift = Math.sin((Math.PI * (tt - CROUCH_S)) / ROLL_S) * 4;
      p.legs = "tuck";
      arms(p, "down");
      return "closed";
    }
    arms(p, "up");
    return "happy";
  },
};

// ---------------------------------------------------------------------------
// Gimnasia (saltos de tijera y sentadillas)
// ---------------------------------------------------------------------------

const JACKS_S = 4;
const MORNING: ReadonlySet<MoodState> = new Set<MoodState>(["contento", "feliz", "emocionado", "jugueton", "curioso", "orgulloso"]);

export const gimnasia: ActivityDef = {
  id: "gimnasia",
  dur: [8, 8],
  cooldownS: 1200,
  weight(c) {
    if (!lively(c) || c.outfit === "car") return 0;
    const morning = c.hour >= 7 && c.hour < 11 && MORNING.has(c.state) ? 2 : 0;
    return morning + (c.state === "emocionado" ? 1 : 0);
  },
  step(run, a, _kit, inp) {
    once(run, inp.tt, "sweat", run.dur - 0.6, () => a.showIcon("sweat", 1.2));
    once(run, inp.tt, "fit", run.dur - 0.1, () => (a.mood = nudge(a.mood, { energy: 0.05, boredom: -0.5 })));
    return inp.tt < run.dur ? "go" : "idle";
  },
  pose(_run, tt, p) {
    if (tt < JACKS_S) {
      const open = alt(tt, 2.8);
      arms(p, open ? "up" : "down");
      p.legs = open ? "spread" : "stand";
      p.lift = open ? bounce(tt, 0.36, 1.5) : 0;
      return "happy";
    }
    const down = (tt - JACKS_S) % 1.2 < 0.6;
    if (!down) return null;
    p.sy = 0.78;
    p.sx = 1.12;
    p.legs = "tuck";
    arms(p, "out");
    p.brows = "flat";
    return "squint";
  },
};
