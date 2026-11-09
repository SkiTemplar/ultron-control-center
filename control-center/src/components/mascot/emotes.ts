// Mascota — gestos con guion (emotes): nombres, duraciones y la pose de
// cada uno en el instante `tt`. Funciones puras, sin estado del motor.

import type { Eyes, Pose } from "./sprite";

/** Animaciones con guion (gestos, reacciones). */
export type Emote =
  | "lookAround"
  | "stretch"
  | "yawn"
  | "hop"
  | "dance"
  | "tapFoot"
  | "sigh"
  | "wiggle"
  | "peek"
  | "jealous"
  | "joy"
  | "poof"
  | "angry"
  | "love"
  | "surprised"
  | "sneeze"
  | "twirl";

export const EMOTE_DURATION: Record<Emote, number> = {
  lookAround: 2.4,
  stretch: 1.8,
  yawn: 2.0,
  hop: 1.0,
  dance: 3.0,
  tapFoot: 2.0,
  sigh: 2.2,
  wiggle: 1.4,
  peek: 1.6,
  jealous: 2.6,
  joy: 1.6,
  poof: 0.7,
  angry: 1.6,
  love: 1.8,
  surprised: 0.9,
  sneeze: 1.7,
  twirl: 1.0,
};

/** Instante del «disfraz» dentro de la reacción de celos. */
export const JEALOUS_COLOR_AT = 2.1;

/** Pose de un gesto con guion en el instante `tt`. */
export function emotePose(e: Emote, tt: number, p: Pose): Eyes | null {
  const alt = (hz: number) => Math.floor(tt * hz) % 2 === 0;
  const hopLift = (period: number, height: number) => Math.abs(Math.sin((Math.PI * tt) / period)) * height;
  switch (e) {
    case "lookAround":
      p.lookX = Math.sin(tt * 2.6) * 1.4;
      p.lookY = -0.4;
      return null;
    case "stretch":
      p.armL = p.armR = "up";
      if (tt < 1.0) {
        p.sx = 0.88;
        p.sy = 1.2;
        return "closed";
      }
      return "happy";
    case "yawn":
      p.armR = tt > 0.3 && tt < 1.4 ? "wave2" : "out";
      p.sy = tt > 0.3 && tt < 1.4 ? 1.12 : 1;
      p.dx = tt > 1.5 ? Math.sin(tt * 18) * 0.6 : 0;
      return tt > 0.2 && tt < 1.5 ? "closed" : "sleepy";
    case "hop": {
      p.lift = hopLift(0.5, 3);
      p.legs = p.lift > 0.6 ? "dangle" : "stand";
      p.armL = p.armR = p.lift > 0.6 ? "up" : "out";
      return "happy";
    }
    case "dance": {
      p.lift = hopLift(0.25, 1.2);
      p.legs = alt(4) ? "walk1" : "walk2";
      const a = alt(4);
      p.armL = a ? "wave1" : "flail1";
      p.armR = a ? "flail1" : "wave1";
      p.blush = true;
      return "happy";
    }
    case "twirl":
      p.lift = Math.sin((Math.PI * Math.min(tt, 0.9)) / 0.9) * 2.5;
      p.armL = p.armR = alt(8) ? "out" : "up";
      p.legs = "dangle";
      return "happy";
    case "tapFoot":
      p.legs = alt(6) ? "walk1" : "stand";
      p.armL = p.armR = "cross";
      p.brows = "angry";
      p.lookX = -1;
      return null;
    case "sigh":
      p.sy = tt > 0.4 && tt < 1.6 ? 0.86 : 1;
      p.sx = tt > 0.4 && tt < 1.6 ? 1.06 : 1;
      p.armL = p.armR = "down";
      p.brows = "sad";
      p.lookY = 1;
      p.breath = Math.sin(tt * 2.8) * 0.8;
      return tt > 0.5 && tt < 1.5 ? "sleepy" : null;
    case "wiggle":
      p.dx = Math.sin(tt * 14) * 1.2;
      p.armL = alt(7) ? "flail1" : "out";
      p.armR = alt(7) ? "out" : "flail1";
      return "happy";
    case "peek":
      p.dx = 1;
      p.brows = "up";
      p.lookX = 1.4;
      return tt < 0.6 ? "wide" : null;
    case "jealous":
      if (tt < 0.5) {
        p.brows = "up";
        p.armL = p.armR = "up";
        p.lift = Math.sin((Math.PI * tt) / 0.5) * 1.5;
        return "wide";
      }
      if (tt < 1.5) {
        p.brows = "sad";
        p.armL = p.armR = "down";
        p.sy = 0.9;
        p.sx = 1.05;
        p.lookY = 1;
        p.lookX = -1;
        p.breath = Math.sin(tt * 9) * 0.5; // sollozos
        return null;
      }
      p.armL = p.armR = "cross";
      p.brows = tt < JEALOUS_COLOR_AT ? "angry" : "sad";
      p.lookX = -1;
      return tt < JEALOUS_COLOR_AT + 0.25 && tt > JEALOUS_COLOR_AT - 0.1 ? "closed" : null;
    case "joy":
      p.lift = hopLift(0.55, 3.2);
      p.armL = p.armR = p.lift > 0.5 ? "up" : "wave1";
      p.legs = p.lift > 0.5 ? "dangle" : "stand";
      p.blush = true;
      return "happy";
    case "poof":
      p.armL = p.armR = "up";
      return tt < 0.35 ? "closed" : "happy";
    case "angry":
      p.lift = Math.abs(Math.sin(tt * 12)) * 0.7;
      p.legs = alt(10) ? "walk1" : "walk2";
      p.armL = p.armR = alt(5) ? "flail1" : "cross";
      p.brows = "angry";
      p.dx = Math.sin(tt * 30) * 0.5;
      return "squint";
    case "love":
      p.dx = Math.sin(tt * 6) * 1;
      p.blush = true;
      p.armL = p.armR = "cross";
      return "heart";
    case "surprised":
      p.lift = tt < 0.35 ? Math.sin((Math.PI * tt) / 0.35) * 3 : 0;
      p.armL = p.armR = tt < 0.35 ? "up" : "out";
      p.brows = "up";
      return "wide";
    case "sneeze":
      if (tt < 1.0) {
        p.sy = 1 + 0.15 * tt;
        p.brows = "up";
        return tt > 0.6 ? "squint" : "sleepy";
      }
      p.armL = p.armR = "flail1";
      return tt < 1.3 ? "closed" : "happy";
  }
}
