// Mascota — actividades quietas: leer, mirar estrellas (de noche) y la
// bienvenida cuando vuelves tras una ausencia. Son las únicas que se
// permiten mientras programas o estás en una llamada (y de noche).

import { emotePose } from "../emotes";
import { nudge } from "../mood";
import type { MoodState } from "../moodState";
import type { ActivityDef, Px } from "./types";
import { alt, arms, between, dirTo, num, once, sit, walkLegs } from "./util";

const READERS: ReadonlySet<MoodState> = new Set<MoodState>([
  "contento",
  "aburrido",
  "cansado",
  "somnoliento",
  "curioso",
  "concentrado",
  "solitario",
  "triste",
]);

const BOOK = { cover: "#2F6FE4", page: "#F4F1EA", gutter: "#C9C3B6", ink: "#9A958B" };

/** Libro abierto en las manos (origen en la coronilla, mirando a +x). */
export function bookPx(lowered: boolean, turn: number | null): Px[] {
  const y = lowered ? 5 : 4;
  const px: Px[] = [
    [1, y + 1, 8, 3, BOOK.cover],
    [2, y, 6, 3, BOOK.page],
    [5, y, 1, 3, BOOK.gutter],
    [2, y + 1, 2, 1, BOOK.ink],
    [6, y + 1, 2, 1, BOOK.ink],
  ];
  // La hoja que pasa: un píxel claro que cruza de la derecha a la izquierda por arriba.
  if (turn !== null) px.push([Math.round(7 - turn * 4), y - 1, 1, 1, BOOK.page]);
  return px;
}

const PAGE_TURN_S = 0.4;

export const leer: ActivityDef = {
  id: "leer",
  dur: [14, 28],
  cooldownS: 360,
  weight: (c) => (READERS.has(c.state) ? (c.night ? 10 : 5) : 0),
  begin(run, _a, kit) {
    run.data.nextPage = between(2.5, 4, kit.rand());
  },
  step(run, _a, kit, inp) {
    if (run.data.closed) return "idle";
    if (inp.tt >= num(run, "nextPage")) {
      run.data.turnAt = inp.tt;
      run.data.nextPage = inp.tt + between(2.5, 4, kit.rand());
    }
    if (inp.tt < run.dur) return "go";
    // De noche, al acabar el capítulo, a veces se queda dormido.
    return run.night && kit.rand() < 0.6 ? "sleep" : "idle";
  },
  pose(run, tt, p) {
    sit(p);
    arms(p, "type1");
    if (run.hovered) return null; // baja el libro y te mira (la mirada la pone el motor)
    p.lookY = 0.4;
    p.lookX = Math.sin(Math.PI * tt) * 0.9;
    if (tt - num(run, "turnAt", -9) < PAGE_TURN_S) return "happy";
    return run.night && tt > run.dur * 0.6 ? "sleepy" : null;
  },
  props(run, tt) {
    const since = tt - num(run, "turnAt", -9);
    const turn = since < PAGE_TURN_S ? since / PAGE_TURN_S : null;
    return [{ anchor: "head", px: bookPx(run.hovered, turn) }];
  },
  poke(run) {
    // Un clic cierra el libro.
    run.data.closed = 1;
    return true;
  },
};

export const estrellas: ActivityDef = {
  id: "estrellas",
  dur: [8, 14],
  cooldownS: 600,
  weight: (c) => (c.night ? 6 : 0),
  begin(run, _a, kit) {
    run.data.starAt = between(2.5, 6, kit.rand());
  },
  step(run, a, kit, inp) {
    const at = num(run, "starAt");
    once(run, inp.tt, "star", at, () => {
      const y = Math.max(30, a.y - a.height - 200);
      kit.spawn({ kind: "star", x: a.x - a.facing * 260, y, vx: a.facing * 420, vy: 110, life: 1.3, stage: 0, seed: kit.rand(), r: 0 });
    });
    once(run, inp.tt, "point", at + 0.35, () => {
      a.showIcon("spark", 1.2);
      a.mood = nudge(a.mood, { happy: 0.1, boredom: -0.3 });
    });
    return inp.tt < run.dur ? "go" : "idle";
  },
  pose(run, tt, p) {
    sit(p);
    arms(p, "down");
    const since = tt - num(run, "starAt");
    p.lookY = -1;
    p.lookX = since < 0 ? Math.sin(tt * 0.8) * 0.6 : 1;
    if (since > 0.35 && since < 1.8) p.armR = "up";
    if (since > 0.2 && since < 0.7) return "wide";
    return since >= 0.7 && since < 2.2 ? "happy" : null;
  },
};

/** Lo que bosteza antes de saludar si lo despiertas de noche. */
const YAWN_S = 1.6;
const WALK_S = 0.6;

export const bienvenida: ActivityDef = {
  id: "bienvenida",
  dur: [2.6, 2.6],
  cooldownS: 0,
  fromSleep: true,
  weight: () => 0, // solo por suceso («vuelves»), nunca por sorteo
  begin(run, a, kit) {
    run.data.yawn = run.woke && run.night ? YAWN_S : 0;
    run.dur = run.data.yawn + 2.6;
    run.data.steps = 2 + Math.floor(kit.rand() * 3);
    a.showIcon("exclaim", 0.8);
  },
  step(run, a, kit, inp) {
    const y = num(run, "yawn");
    once(run, inp.tt, "face", y, () => {
      if (inp.cursor) a.facing = dirTo(a.x, inp.cursor.x);
      a.kick(4, -4);
    });
    const u = inp.tt - y;
    if (u >= 0 && u < WALK_S) kit.moveX(a, (a.facing * num(run, "steps") * 2 * a.S * inp.dt) / WALK_S);
    once(run, inp.tt, "hearts", y + 1.0, () => a.floatUp("heart", 2));
    once(run, inp.tt, "kick", y + 1.4, () => a.kick(4, -4));
    return inp.tt < run.dur ? "go" : "idle";
  },
  pose(run, tt, p) {
    const y = num(run, "yawn");
    if (tt < y) return emotePose("yawn", (tt * 2) / y, p);
    const u = tt - y;
    if (u < WALK_S) {
      p.legs = walkLegs(u);
      p.brows = "up";
      return "wide";
    }
    const a = alt(u, 7);
    arms(p, a ? "wave1" : "wave2", a ? "wave2" : "wave1");
    p.blush = true;
    return "happy";
  },
};
