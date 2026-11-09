// Mascota — bailar cuando suena música (Spotify y similares; media.rs mira
// los controles multimedia de Windows). Rutina de cuatro pasos a 116 bpm
// fijos: detectar el tempo no es barato y queda fuera. Si la música para,
// deja de bailar.

import type { ActivityDef } from "./types";
import { arms, bounce, once } from "./util";

export const DANCE_BPM = 116;
const BEAT = 60 / DANCE_BPM;

/** Paso de la rutina (0-3) en el instante `tt`: cambia cada dos tiempos. */
export function danceMove(tt: number): 0 | 1 | 2 | 3 {
  return (Math.floor(tt / (2 * BEAT)) % 4) as 0 | 1 | 2 | 3;
}

export const bailar: ActivityDef = {
  id: "bailar",
  dur: [10, 16],
  cooldownS: 180,
  weight: () => 0, // solo por petición (hay música), nunca por sorteo
  step(run, a, kit, inp) {
    if (!inp.music) return "idle";
    const b = Math.floor(inp.tt / BEAT);
    once(run, inp.tt, `beat${b}`, b * BEAT, () => {
      if (b % 2 === 0) a.floatUp("note");
      const move = danceMove(inp.tt);
      if (move === 0) kit.moveX(a, (b % 2 ? 1 : -1) * 2 * a.S);
      if (move === 2 && b % 2 === 0) a.facing = a.facing === 1 ? -1 : 1;
      if (move === 3) a.kick(3, -3);
    });
    return inp.tt < run.dur ? "go" : "idle";
  },
  pose(_run, tt, p) {
    const b = Math.floor(tt / BEAT);
    p.blush = true;
    switch (danceMove(tt)) {
      case 0:
        p.legs = b % 2 ? "walk1" : "walk2";
        p.dx = b % 2 ? 1 : -1;
        arms(p, "hips");
        break;
      case 1:
        arms(p, "up");
        p.lift = bounce(tt, BEAT, 1.2);
        break;
      case 2:
        arms(p, b % 2 ? "wave1" : "flail1", b % 2 ? "flail1" : "wave1");
        p.legs = "walk1";
        break;
      case 3:
        p.lift = bounce(tt, BEAT / 2, 0.8);
        arms(p, b % 2 ? "out" : "up", b % 2 ? "up" : "out");
        break;
    }
    return "happy";
  },
};
