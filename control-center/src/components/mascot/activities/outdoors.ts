// Mascota — al aire libre: pescar desde el borde de una ventana (clic cuando
// pica para recoger) y perseguir una mariposa (de marzo a octubre).

import { nudge } from "../mood";
import { CATCH_KINDS, rollCatch } from "./catches";
import { lively } from "./play";
import type { Actor, ActivityDef, ActivityRun, CatchKind, Kit, Px } from "./types";
import { arms, between, bounce, dirTo, num, once, walkLegs, WALK_PX } from "./util";

// ---------------------------------------------------------------------------
// Pescar
// ---------------------------------------------------------------------------

/** Caída libre mínima bajo el borde (px CSS) para echar el sedal. */
export const FISH_MIN_DROP = 120;
const CAST_S = 0.8;
/** Ventana para recoger con un clic cuando pica. */
export const BITE_WINDOW_S = 1.5;
const SHOW_S = 2.5;
const MISS_S = 1.0;
const SELF_CATCH = 0.4;

/** Fases de la pesca (run.data.phase). */
export const FISH = { approach: 0, cast: 1, wait: 2, bite: 3, show: 4, miss: 5 } as const;

const ROD = "#8A5A2B";
/** Punta de la caña respecto a los pies, en px de sprite. */
export const ROD_TIP: [number, number] = [12, -11];

/** Caña (origen en los pies): levantada al lanzar, en diagonal al esperar. */
export function rodPx(raised: boolean): Px[] {
  if (raised) return [[7, -12, 1, 7, ROD], [7, -5, 1, 1, "#9A9A9A"]];
  const px: Px[] = [];
  for (let i = 0; i < 6; i++) px.push([7 + i, -6 - i, 1, 1, ROD]);
  px.push([7, -5, 1, 1, "#9A9A9A"]);
  return px;
}

/** Capturas en alto (origen en la coronilla, encima de la cabeza). */
export const CATCH_PX: Record<CatchKind, Px[]> = {
  sardina: [[-3, -4, 6, 2, "#AFC4D6"], [-2, -3, 4, 1, "#E3ECF3"], [3, -5, 1, 4, "#8FA6BA"], [-2, -4, 1, 1, "#141413"]],
  payaso: [[-3, -4, 6, 2, "#F97316"], [-1, -4, 1, 2, "#F4F1EA"], [1, -4, 1, 2, "#F4F1EA"], [3, -5, 1, 4, "#F97316"], [-2, -4, 1, 1, "#141413"]],
  bota: [[-2, -7, 3, 4, "#7A4A23"], [-2, -3, 5, 2, "#7A4A23"], [-2, -2, 5, 1, "#3D2A18"], [-2, -7, 3, 1, "#5C3519"]],
  tmp: [[-2, -7, 4, 5, "#F4F1EA"], [1, -7, 1, 1, "#C9C3B6"], [-1, -5, 2, 1, "#9A958B"], [-1, -3, 2, 1, "#9A958B"]],
};

function hooked(run: ActivityRun, a: Actor, kit: Kit, tt: number) {
  const kind = rollCatch(kit.rand());
  const first = kit.recordCatch(kind);
  run.data.catch = CATCH_KINDS.indexOf(kind);
  run.data.first = first ? 1 : 0;
  run.data.phase = FISH.show;
  run.data.showT = tt;
  a.kick(5, -6);
  a.mood = nudge(a.mood, { happy: first ? 0.25 : 0.12, boredom: -1 });
  const junk = kind === "bota" || kind === "tmp";
  a.showIcon(first ? "exclaim" : junk ? "sweat" : "spark", 1.4);
  if (first) {
    a.floatUp("heart", 3);
    a.happyUntil = a.t + 2;
  }
}

function waitAgain(run: ActivityRun, kit: Kit, tt: number) {
  run.data.phase = FISH.wait;
  run.data.biteAt = tt + between(6, 18, kit.rand());
}

/** Camina hasta el borde; true al llegar. */
function approach(run: ActivityRun, a: Actor, kit: Kit, dt: number): boolean {
  const d = num(run, "edgeX") - a.x;
  if (Math.abs(d) < 1) return true;
  a.facing = dirTo(a.x, num(run, "edgeX"));
  return !kit.moveX(a, Math.sign(d) * Math.min(Math.abs(d), WALK_PX * a.S * dt));
}

function fishStep(run: ActivityRun, a: Actor, kit: Kit, tt: number, dt: number): "go" | "idle" {
  const ph = num(run, "phase");
  if (ph === FISH.approach && approach(run, a, kit, dt)) {
    a.facing = num(run, "dir") === -1 ? -1 : 1;
    run.data.phase = FISH.cast;
    run.data.castT = tt;
  } else if (ph === FISH.cast && tt >= num(run, "castT") + CAST_S) {
    waitAgain(run, kit, tt);
  } else if (ph === FISH.wait && tt >= num(run, "biteAt")) {
    run.data.phase = FISH.bite;
    run.data.biteT = tt;
    a.showIcon("exclaim", BITE_WINDOW_S);
  } else if (ph === FISH.bite && (run.data.reel || tt >= num(run, "biteT") + BITE_WINDOW_S)) {
    if (run.data.reel || kit.rand() < SELF_CATCH) hooked(run, a, kit, tt);
    else {
      run.data.phase = FISH.miss;
      run.data.missT = tt;
      a.showIcon("sweat", 1.0);
    }
  } else if (ph === FISH.miss && tt >= num(run, "missT") + MISS_S) {
    waitAgain(run, kit, tt);
  } else if (ph === FISH.show && tt >= num(run, "showT") + SHOW_S) {
    return "idle";
  }
  // Se acabó el rato: recoge el sedal (salvo si está enseñando la captura).
  return ph !== FISH.show && tt >= run.dur ? "idle" : "go";
}

export const pescar: ActivityDef = {
  id: "pescar",
  dur: [20, 45],
  cooldownS: 600,
  weight(c) {
    if (!lively(c) || c.outfit === "car" || !c.edge || c.edge.drop < FISH_MIN_DROP) return 0;
    return ["aburrido", "contento", "curioso"].includes(c.state) ? 4 : 3;
  },
  begin(run, _a, kit, ctx) {
    const e = ctx.edge;
    run.data.edgeX = e?.x ?? 0;
    run.data.dir = e?.dir ?? 1;
    run.data.depth = between(40, Math.max(40, Math.min(90, (e?.drop ?? 0) - 40)), kit.rand());
    run.data.phase = FISH.approach;
  },
  step: (run, a, kit, inp) => fishStep(run, a, kit, inp.tt, inp.dt),
  pose(run, tt, p) {
    const ph = num(run, "phase");
    if (ph === FISH.approach) {
      p.legs = walkLegs(tt);
      return null;
    }
    if (ph === FISH.show) {
      arms(p, "up");
      p.blush = !!run.data.first;
      p.lookY = -1;
      return "happy";
    }
    p.legs = "dangle";
    p.armR = "out";
    p.armL = "down";
    p.lookX = 1;
    p.lookY = 1;
    if (ph === FISH.bite) p.brows = "up";
    if (ph === FISH.miss) p.brows = "sad";
    return ph === FISH.bite ? "wide" : null;
  },
  props(run, tt) {
    const ph = num(run, "phase");
    if (ph === FISH.approach) return [];
    if (ph === FISH.show) return [{ anchor: "head", px: CATCH_PX[CATCH_KINDS[num(run, "catch")]] }];
    const raised = ph === FISH.cast && tt < num(run, "castT") + CAST_S * 0.6;
    return [{ anchor: "feet", px: rodPx(raised) }];
  },
  line(run, tt) {
    const ph = num(run, "phase");
    const cast = ph === FISH.cast && tt >= num(run, "castT") + CAST_S * 0.6;
    if (!cast && ph !== FISH.wait && ph !== FISH.bite && ph !== FISH.miss) return null;
    const bob = Math.sin(tt * 2.2) * 1.5;
    return { tip: ROD_TIP, depth: num(run, "depth") + bob, dip: ph === FISH.bite };
  },
  poke(run) {
    if (num(run, "phase") !== FISH.bite) return false;
    run.data.reel = 1;
    return true;
  },
};

// ---------------------------------------------------------------------------
// Mariposa
// ---------------------------------------------------------------------------

const PERCH_CHANCE = 0.3;
const PERCH_S = 3;

function chase(run: ActivityRun, a: Actor, kit: Kit, bx: number, by: number, tt: number, dt: number) {
  const d = bx - a.x;
  run.data.walking = Math.abs(d) > 8 * a.S ? 1 : 0;
  if (run.data.walking) {
    a.facing = dirTo(a.x, bx);
    kit.moveX(a, Math.sign(d) * Math.min(Math.abs(d), 1.3 * WALK_PX * a.S * dt));
  }
  const close = Math.abs(d) < 30 * a.S && by > a.y - a.height - 60;
  if (close && tt - num(run, "hopAt", -9) > 1.2) {
    run.data.hopAt = tt;
    a.kick(4, -5);
  }
}

function flyAway(kit: Kit, id: number, dir: number) {
  kit.patch(id, { stage: 2, vx: dir * 90, vy: -40 });
}

export const mariposa: ActivityDef = {
  id: "mariposa",
  dur: [12, 14],
  cooldownS: 1200,
  weight: (c) => (lively(c) && c.month >= 3 && c.month <= 10 && c.outfit !== "car" ? 1.5 : 0),
  begin(run, a, kit) {
    const x = Math.min(Math.max(a.x + a.facing * between(150, 250, kit.rand()), 20), a.W - 20);
    const y = Math.max(30, a.y - a.height - between(30, 70, kit.rand()));
    run.data.bf = kit.spawn({ kind: "butterfly", x, y, vx: 0, vy: 0, life: 40, stage: 0, seed: kit.rand(), r: 0 });
    run.data.perchAt = between(6, 8, kit.rand());
    run.data.perch = kit.rand() < PERCH_CHANCE ? 1 : 0;
  },
  step(run, a, kit, inp) {
    const id = num(run, "bf");
    const b = kit.item(id);
    if (!b) return "idle";
    once(run, inp.tt, "decide", num(run, "perchAt"), () => {
      if (run.data.perch) kit.patch(id, { stage: 1 });
      else flyAway(kit, id, a.facing);
      run.data.perchT = inp.tt;
    });
    if (b.stage === 0) chase(run, a, kit, b.x, b.y, inp.tt, inp.dt);
    if (b.stage === 1) {
      kit.patch(id, { x: a.x + a.facing * a.S, y: a.y - a.height - 2 * a.S });
      if (inp.tt >= num(run, "perchT") + PERCH_S) flyAway(kit, id, kit.rand() < 0.5 ? -1 : 1);
    }
    run.data.perched = b.stage === 1 ? 1 : 0;
    if (inp.tt < run.dur) return "go";
    if (b.stage !== 2) flyAway(kit, id, a.facing);
    return "idle";
  },
  pose(run, tt, p) {
    if (run.data.perched) {
      arms(p, "down");
      p.blush = true;
      p.lookY = -1;
      return "happy";
    }
    if (run.data.walking) p.legs = walkLegs(tt, 1.3);
    const hop = tt - num(run, "hopAt", -9);
    if (hop < 0.5) {
      p.lift = bounce(hop, 0.5, 3);
      arms(p, "up");
    }
    p.lookY = -1;
    p.lookX = 1;
    return null;
  },
};
