// Mascota — efectos con tiempo dentro de cada animación con guion (emotes).
//
// Cada emote declara sus marcas: en el instante `at` (segundos desde que
// empezó) dispara un efecto, una sola vez. El motor aporta `once` (que
// recuerda las marcas ya disparadas) y los efectos (CueFx).

import type { Glyph } from "./sprite";
import { JEALOUS_COLOR_AT, type Emote } from "./emotes";
import type { EffectKind } from "./engineTypes";

/** Dispara `fn` una sola vez cuando la animación pasa de `at` segundos. */
export type Once = (key: string, at: number, fn: () => void) => void;

/** Lo que las marcas pueden hacer sobre la mascota. */
export interface CueFx {
  /** Darse la vuelta. */
  flip(): void;
  kick(dx: number, dy: number): void;
  floatUp(kind: "heart" | "note", n?: number): void;
  burst(kind: EffectKind, n: number, color?: string, spread?: number): void;
  showIcon(glyph: Glyph, life?: number): void;
  tear(): void;
  /** Aplica el color pendiente (el del agente que provocó los celos). */
  settleColor(): void;
  /** Retroceso del estornudo: 2 px de sprite hacia atrás, sin salir de la pantalla. */
  recoil(): void;
}

type Cue = (once: Once, fx: CueFx) => void;

function jealousCue(once: Once, fx: CueFx) {
  once("i0", 0, () => {
    fx.showIcon("exclaim", 0.5);
    fx.kick(-4, 6);
  });
  once("i1", 0.5, () => fx.showIcon("cloud", 1.0));
  for (let i = 0; i < 6; i++) once(`t${i}`, 0.55 + i * 0.15, () => fx.tear());
  once("turn", 1.5, () => {
    fx.flip();
    fx.showIcon("puff", 1.0);
  });
  once("color", JEALOUS_COLOR_AT, () => fx.settleColor());
}

const CUES: Partial<Record<Emote, Cue>> = {
  lookAround: (once, fx) => once("flip", 1.2, () => fx.flip()),
  hop: (once, fx) => {
    once("l1", 0.5, () => fx.kick(4, -4));
    once("l2", 1.0, () => fx.kick(4, -4));
  },
  dance: (once, fx) => {
    for (let i = 1; i < 6; i++) once(`f${i}`, i * 0.5, () => fx.flip());
    for (let i = 0; i < 5; i++) once(`n${i}`, i * 0.6, () => fx.floatUp("note"));
  },
  twirl: (once, fx) => {
    for (let i = 1; i < 8; i++) once(`f${i}`, i * 0.12, () => fx.flip());
    once("sp", 0.9, () => fx.burst("spark", 8, "#FFF3B0", 0.7));
  },
  tapFoot: (once, fx) => once("i", 0, () => fx.showIcon("anger", 1.4)),
  sigh: (once, fx) => once("i", 0.2, () => fx.showIcon("cloud", 1.8)),
  peek: (once, fx) => once("i", 0, () => fx.showIcon("question", 1.4)),
  jealous: jealousCue,
  joy: (once, fx) => {
    once("h0", 0, () => fx.floatUp("heart", 2));
    once("h1", 0.6, () => fx.floatUp("heart", 2));
    once("k0", 0.5, () => fx.kick(4, -4));
    once("k1", 1.1, () => fx.kick(4, -4));
  },
  angry: (once, fx) => once("i", 0, () => fx.showIcon("anger", 1.6)),
  love: (once, fx) => {
    for (let i = 0; i < 5; i++) once(`h${i}`, i * 0.3, () => fx.floatUp("heart"));
  },
  surprised: (once, fx) =>
    once("i", 0, () => {
      fx.showIcon("exclaim", 0.9);
      fx.kick(-4, 6);
    }),
  sneeze: (once, fx) =>
    once("achis", 1.0, () => {
      fx.kick(6, -7);
      fx.burst("spark", 8, "#FFFFFF", 0.6);
      fx.recoil();
    }),
  stretch: (once, fx) => once("k", 1.0, () => fx.kick(4, -5)),
};

/** Dispara las marcas de `e` que ya tocan (las que no tiene, ninguna). */
export function runEmoteCues(e: Emote, once: Once, fx: CueFx) {
  CUES[e]?.(once, fx);
}
