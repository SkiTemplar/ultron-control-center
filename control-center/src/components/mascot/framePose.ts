// Mascota — pose de cada modo, postura de conversación, parpadeo y muelle de
// aplastamiento.
//
// Puro salvo el estado propio de Blinker y Squash: el motor reúne en un
// PoseCtx lo que necesita cada modo y aplica aquí la pose sobre `p`.

import { BODY_W, SPRITE_H, type Arm, type Eyes, type Pose } from "./sprite";
import { emotePose, type Emote } from "./emotes";
import type { MoodState } from "./moodState";
import { alt, clamp } from "./activities/util";
import type { ChatState, Frame, Mode, Point, Surface } from "./engineTypes";

const SPRING_K = 340;
const SPRING_C = 15;

/** Fase del parpadeo: medio cerrado, cerrado o nada (ojos abiertos). */
export type BlinkPhase = "blink" | "closed" | null;

/** Lo que la pose de cada modo lee del motor en este fotograma. */
export interface PoseCtx {
  t: number;
  mode: Mode;
  modeT: number;
  vy: number;
  swing: number;
  facing: 1 | -1;
  splatSide: Surface;
  hangAnchor: Point | null;
  hangStruggle: boolean;
  /** Rapidez del arrastre (px/s). */
  dragSpeed: number;
  happyUntil: number;
  state: MoodState;
  /** Ritmo de paseo del estado de ánimo (StateTraits.speed). */
  walkPace: number;
  emote: Emote | null;
  driveAct: { kind: string; t: number } | null;
  blink: BlinkPhase;
  /** Pose de la actividad en curso (activities/). */
  actPose: (p: Pose) => Eyes | null;
}

/** Lo que el modo añade al fotograma además de la pose. */
export interface ModeLook {
  eyes: Eyes;
  pin: Frame["pin"];
  zzz: boolean;
  stars: boolean;
  /** Fija el aplastamiento de golpe (sin muelle). */
  snap: boolean;
  heli: number | null;
}

type ModePainter = (p: Pose, look: ModeLook, c: PoseCtx) => void;

/**
 * Balanceo de las piernas en el espacio del sprite. `c.swing` es un
 * desplazamiento del MUNDO (+ = hacia la derecha de la pantalla: las piernas
 * se quedan atrás al moverse), pero `legSwing` va en el espacio del sprite,
 * que drawPet refleja cuando Pupus mira a la izquierda. Sin pasar por
 * `facing`, al ir hacia la izquierda las piernas se adelantaban.
 */
function legSwingOf(c: PoseCtx, k = 1): number {
  return c.swing * k * c.facing;
}

function paintWalk(p: Pose, _look: ModeLook, c: PoseCtx) {
  const ph = c.t * 8 * c.walkPace;
  const step = Math.floor(ph) % 4;
  p.legs = step === 0 ? "walk1" : step === 2 ? "walk2" : "stand";
  p.lift = Math.abs(Math.sin((ph * Math.PI) / 2)) * 0.45;
  p.breath = 0;
}

function paintSit(p: Pose) {
  p.legs = "tuck";
  p.armL = p.armR = "down";
}

function paintSleep(p: Pose, look: ModeLook, c: PoseCtx) {
  p.legs = "tuck";
  p.armL = p.armR = "down";
  look.eyes = "closed";
  p.breath = (Math.sin(c.t * 1.3) + 1) * 0.45;
  p.sy = 0.92;
  look.zzz = true;
}

function paintCrouch(p: Pose) {
  p.sx = 1.18;
  p.sy = 0.72;
  p.legs = "tuck";
  p.armL = p.armR = "down";
}

function paintAir(p: Pose, look: ModeLook, c: PoseCtx) {
  // Estiramiento continuo según la velocidad vertical.
  const st = clamp(-c.vy / 2600, -0.22, 0.28);
  p.sy = 1 + st;
  p.sx = 1 - st * 0.6;
  p.breath = 0;
  if (c.vy < -150) {
    p.armL = p.armR = "up";
    p.legs = "dangle";
    return;
  }
  const f = alt(c.t, 8);
  p.armL = f ? "flail1" : "flail2";
  p.armR = f ? "flail2" : "flail1";
  p.legs = "spread";
  if (c.vy > 600) look.eyes = "wide";
}

function paintDrag(p: Pose, look: ModeLook, c: PoseCtx) {
  p.armL = p.armR = alt(c.t, 3) ? "flail1" : "out";
  p.legs = "dangle";
  p.legSwing = legSwingOf(c);
  p.breath = 0;
  look.eyes = c.dragSpeed > 900 ? "wide" : c.t < c.happyUntil ? "happy" : look.eyes;
}

function paintHang(p: Pose, look: ModeLook, c: PoseCtx) {
  p.legs = "dangle";
  p.legSwing = legSwingOf(c, -0.8);
  if (c.hangStruggle) {
    p.armL = p.armR = "up";
    p.brows = c.modeT > 4 ? "sad" : "up";
  } else {
    // Tranquilo: brazos abajo y, a ratos, ojos de siesta.
    p.armL = p.armR = "down";
    if (c.modeT > 3 && Math.sin(c.t * 0.6) > 0.4) look.eyes = "sleepy";
  }
  if (c.hangAnchor) look.pin = { ...c.hangAnchor };
}

function paintSplat(p: Pose, look: ModeLook, c: PoseCtx) {
  look.snap = true;
  p.legs = "none";
  p.armL = p.armR = "flat";
  p.breath = 0;
  if (c.splatSide === "floor") {
    look.eyes = "dizzy";
    p.sx = 1.5;
    p.sy = 0.35;
  } else if (c.splatSide === "ceil") {
    look.eyes = "dizzy";
    p.sx = 1.3;
    p.sy = 0.5;
    p.dy = -(SPRITE_H - 4);
  } else {
    // Contra una pared el cuerpo mide 6 px y las X se pisarían: > <.
    look.eyes = "squint";
    p.sx = 0.45;
    p.sy = 1.25;
    // Pegada a la pared: el cuerpo estrecho se desplaza hasta el borde.
    // En el espacio del sprite, «izquierda» depende de hacia dónde mira.
    const shift = (BODY_W - Math.round(BODY_W * 0.45)) / 2;
    const worldSide = c.splatSide === "left" ? -1 : 1;
    p.dx = shift * worldSide * c.facing;
  }
}

function paintDizzy(p: Pose, look: ModeLook, c: PoseCtx) {
  look.eyes = "dizzy";
  p.dx = Math.sin(c.t * 9) * 0.8;
  p.brows = "sad";
  look.stars = true;
}

function paintWave(p: Pose, look: ModeLook, c: PoseCtx) {
  look.eyes = "happy";
  const w = Math.sin(c.modeT * 14) > 0 ? "wave1" : "wave2";
  p.armR = w as Arm;
  p.blush = ["feliz", "emocionado", "jugueton"].includes(c.state);
}

function paintEmote(p: Pose, look: ModeLook, c: PoseCtx) {
  if (!c.emote) return;
  const e = emotePose(c.emote, c.modeT, p);
  if (e) look.eyes = e;
  else if (look.eyes === "sleepy" && c.emote !== "sigh") look.eyes = c.blink ?? "open";
}

function paintAct(p: Pose, look: ModeLook, c: PoseCtx) {
  const e = c.actPose(p);
  if (e) look.eyes = e;
}

function paintFly(p: Pose, look: ModeLook, c: PoseCtx) {
  p.legs = "dangle";
  p.legSwing = legSwingOf(c);
  p.armL = p.armR = "out";
  p.breath = 0;
  p.lift = Math.sin(c.t * 9) * 0.35;
  look.heli = (c.t * 7) % 1;
}

/** Trepando por una pared: mira a ella, brazos y patas alternos, la vista hacia donde va. */
function paintClimb(p: Pose, _look: ModeLook, c: PoseCtx) {
  const f = alt(c.t, 6);
  // armR es el brazo del lado hacia el que mira: el de la pared.
  p.armR = f ? "up" : "out";
  p.armL = f ? "out" : "up";
  p.legs = f ? "walk1" : "walk2";
  p.breath = 0;
  p.lookX = 1;
  p.lookY = c.vy > 0 ? 1 : -1;
}

function paintDrive(p: Pose, look: ModeLook, c: PoseCtx) {
  p.armR = "up";
  p.legs = alt(c.t, 10) ? "run1" : "run2";
  p.legSwing = legSwingOf(c);
  p.breath = 0;
  const a = c.driveAct;
  const since = a ? c.t - a.t : 99;
  if (a && since < 0.25 && (a.kind === "click" || a.kind === "grab" || a.kind === "drop")) {
    p.armR = "down";
    look.eyes = "squint";
  } else if (a && since < 0.9 && (a.kind === "type" || a.kind === "key")) {
    p.armL = alt(c.t, 12) ? "type1" : "type2";
    p.armR = alt(c.t, 12) ? "type2" : "type1";
    look.eyes = "squint";
  }
}

const PAINTERS: Partial<Record<Mode, ModePainter>> = {
  walk: paintWalk,
  sit: paintSit,
  sleep: paintSleep,
  crouch: paintCrouch,
  air: paintAir,
  land: (p) => {
    p.legs = "tuck";
  },
  drag: paintDrag,
  hang: paintHang,
  splat: paintSplat,
  dizzy: paintDizzy,
  wave: paintWave,
  emote: paintEmote,
  act: paintAct,
  fly: paintFly,
  climb: paintClimb,
  drive: paintDrive,
};

/** Aplica sobre `p` la pose del modo actual; `eyes` son los ojos de partida. */
export function modePose(p: Pose, eyes: Eyes, c: PoseCtx): ModeLook {
  const look: ModeLook = { eyes, pin: null, zzz: false, stars: false, snap: false, heli: null };
  PAINTERS[c.mode]?.(p, look, c);
  return look;
}

/** Postura de conversación. `other`: hablas con otro agente que no es Claude. */
export function chatPose(p: Pose, chat: ChatState, other: boolean, t: number) {
  if (other) {
    // Hablando con «el otro»: brazos cruzados y mirada de reojo.
    p.armL = p.armR = "cross";
    p.brows = "sad";
    p.lookX = Math.sin(t * 0.8) > 0.3 ? 1 : -1;
    p.lookY = 0;
    if (chat === "think") p.breath = (Math.sin(t * 1.5) + 1) * 0.4;
  } else if (chat === "listen") {
    p.armL = p.armR = "down";
    p.brows = "up";
  } else if (chat === "think") {
    p.armR = "up";
    p.armL = "down";
    p.lookX = -1;
    p.lookY = -1;
    p.lift = Math.abs(Math.sin(t * 3)) * 0.4;
  } else if (chat === "talk") {
    const f = alt(t, 3);
    p.armL = f ? "out" : "down";
    p.armR = f ? "down" : "out";
    p.blush = true;
  }
}

/**
 * Le están arrastrando un fichero encima: brazos arriba para cogerlo, cejas
 * subidas, mirada hacia el fichero y saltitos de impaciencia. `dx`, `dy`:
 * fichero respecto a la cabeza (px CSS, espacio del MUNDO); `facing` lo pasa
 * al espacio del sprite, que drawPet refleja cuando Pupus mira a la izquierda
 * (como `legSwingOf` y la mirada al cursor). Devuelve los ojos («como platos»).
 */
export function catchPose(p: Pose, dx: number, dy: number, facing: 1 | -1, t: number): Eyes {
  p.armL = p.armR = "up";
  p.brows = "up";
  p.lookX = clamp((dx * facing) / 40, -1, 1);
  p.lookY = clamp(dy / 40, -1, 1);
  p.lift = Math.abs(Math.sin(t * 9)) * 0.8;
  return "wide";
}

/** Parpadeo en 3 fases (medio, cerrado, medio), a veces doble. */
export class Blinker {
  private at = 2;
  private double = false;

  /** Fase en `t`; al acabar un parpadeo programa el siguiente con `gap()`. */
  phase(t: number, rand: () => number, gap: () => number): BlinkPhase {
    if (t > this.at + 0.5) {
      this.double = rand() < 0.2;
      this.at = t + gap();
    }
    let d = t - this.at;
    if (this.double && d > 0.25) d -= 0.25;
    if (d < 0 || d > 0.16) return null;
    return d < 0.05 || d > 0.11 ? "blink" : "closed";
  }
}

/**
 * Muelle de aplastamiento: la pose da el objetivo y el cuerpo lo alcanza
 * rebotando. Al espachurrarse se fija de golpe.
 */
export class Squash {
  private sq = { x: 1, y: 1, vx: 0, vy: 0 };
  private frameT = 0;

  /** Impulso al muelle (+x = más ancha, +y = más alta). */
  kick(dx: number, dy: number) {
    this.sq.vx += dx;
    this.sq.vy += dy;
  }

  /** Avanza el muelle hasta `t` y deja en `p.sx`/`p.sy` la escala resultante. */
  settle(p: Pose, t: number, snap: boolean) {
    const dtF = Math.min(Math.max(t - this.frameT, 0), 1 / 15);
    this.frameT = t;
    if (snap) {
      this.sq = { x: p.sx, y: p.sy, vx: 0, vy: 0 };
      return;
    }
    const steps = Math.max(1, Math.ceil(dtF / (1 / 120)));
    const h = dtF / steps;
    for (let i = 0; i < steps; i++) {
      this.sq.vx += (SPRING_K * (p.sx - this.sq.x) - SPRING_C * this.sq.vx) * h;
      this.sq.vy += (SPRING_K * (p.sy - this.sq.y) - SPRING_C * this.sq.vy) * h;
      this.sq.x += this.sq.vx * h;
      this.sq.y += this.sq.vy * h;
    }
    this.sq.x = clamp(this.sq.x, 0.5, 1.7);
    this.sq.y = clamp(this.sq.y, 0.4, 1.6);
    p.sx = this.sq.x;
    p.sy = this.sq.y;
  }
}
