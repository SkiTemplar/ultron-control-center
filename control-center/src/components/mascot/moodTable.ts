// Mascota — cómo se comporta Pupus en cada estado (solo datos).
//
// Sustituye a los `switch` por ánimo que tenía el motor (paseos y gestos al
// decidir, reacción al pasar el cursor) y añade lo nuevo: ritmo de
// parpadeo, respiración, microanimaciones y si se permite travesuras o
// paseos largos. La velocidad de los ocho estados de mood.ts sale de
// moodSpeed.

import type { Emote } from "./engine";
import type { MicroKind } from "./idleLife";
import type { MoodState } from "./moodState";
import { moodSpeed } from "./mood";
import type { Glyph } from "./sprite";

export type Choice = "walk" | "sit" | "idle" | "jumpUp" | "hopDown" | Emote;

/**
 * Reacción al pasar el cursor: saludar, menearse, darte la espalda, dar un
 * respingo, asomarse con curiosidad o nada.
 */
export type HoverAct = "wave" | "wiggle" | "turnAway" | "flinch" | "peek" | "none";

export interface StateTraits {
  /** Permanencia mínima en el estado, en segundos (histéresis). */
  dwellS: number;
  /** Multiplicador de la velocidad al pasear. */
  speed: number;
  /** Hueco entre parpadeos, en segundos [mín, máx]. */
  blinkGap: readonly [number, number];
  /** Respiración: frecuencia (rad/s) y amplitud (px de sprite). */
  breath: { hz: number; amp: number };
  /** Gestos que se suman a BASE_CHOICES al decidir qué hacer. */
  decide: readonly [Choice, number][];
  hover: HoverAct;
  /** Icono al pasar el cursor (solo los cuatro estados que ya lo tenían). */
  hoverIcon?: Glyph;
  micro: readonly [MicroKind, number][];
  microGap: readonly [number, number];
  /** Puede hacer travesuras con el cursor. */
  pranks: boolean;
  /** Paseos largos (si no, cortos y pocos). */
  wander: boolean;
  /** Sin energía para saltar. */
  lowEnergy: boolean;
}

/** Lo que puede hacer en cualquier estado al decidir (pesos). */
export const BASE_CHOICES: readonly [Choice, number][] = [
  ["walk", 40],
  ["sit", 10],
  ["idle", 8],
  ["lookAround", 9],
  ["stretch", 4],
  ["wiggle", 3],
  ["hop", 3],
  ["sneeze", 1.2],
];

const CALM: readonly [MicroKind, number][] = [
  ["glance", 4],
  ["glanceEdge", 2],
  ["shiftWeight", 2],
  ["scratch", 1],
];

type Base = Pick<StateTraits, "dwellS" | "speed" | "blinkGap" | "breath" | "hover" | "microGap" | "pranks" | "wander" | "lowEnergy">;

const BASE: Base = {
  dwellS: 6,
  speed: 1,
  blinkGap: [2.2, 5.7],
  breath: { hz: 2.4, amp: 0.28 },
  hover: "wave",
  microGap: [3, 8],
  pranks: true,
  wander: true,
  lowEnergy: false,
};

const S = (t: Partial<StateTraits> & Pick<StateTraits, "decide" | "micro">): StateTraits => ({ ...BASE, ...t });

export const STATE_TABLE: Record<MoodState, StateTraits> = {
  contento: S({ dwellS: 2, speed: moodSpeed("contento"), decide: [["peek", 3]], micro: CALM }),
  feliz: S({ speed: moodSpeed("feliz"), decide: [["dance", 8], ["hop", 6], ["twirl", 4]], hover: "wiggle", hoverIcon: "heart", micro: [...CALM, ["footTap", 2]] }),
  emocionado: S({
    speed: moodSpeed("emocionado"),
    breath: { hz: 3.4, amp: 0.3 },
    decide: [["dance", 16], ["twirl", 10], ["hop", 10]],
    hover: "wiggle",
    hoverIcon: "heart",
    micro: [["footTap", 3], ["glance", 2], ["sniff", 2]],
    microGap: [1.5, 4],
  }),
  jugueton: S({
    speed: 1.3,
    decide: [["hop", 12], ["wiggle", 10], ["peek", 8], ["twirl", 4]],
    hover: "wiggle",
    micro: [["footTap", 3], ["glance", 3], ["sniff", 2]],
    microGap: [1.5, 4],
  }),
  curioso: S({ dwellS: 8, decide: [["lookAround", 14], ["peek", 10]], hover: "peek", micro: [["sniff", 4], ["glance", 3], ["lookBack", 2]], microGap: [2, 5] }),
  concentrado: S({
    dwellS: 15,
    speed: 0.8,
    blinkGap: [4, 8],
    breath: { hz: 1.8, amp: 0.22 },
    decide: [["sit", 30], ["idle", 20]],
    hover: "none",
    micro: [["typeAlong", 4], ["glance", 1]],
    microGap: [4, 10],
    pranks: false,
    wander: false,
  }),
  orgulloso: S({ dwellS: 20, breath: { hz: 1.8, amp: 0.4 }, decide: [["hop", 4], ["stretch", 4]], micro: [["puffChest", 5], ["glance", 2]], microGap: [3, 7] }),
  aburrido: S({ speed: moodSpeed("aburrido"), decide: [["yawn", 12], ["sigh", 8], ["lookAround", 12], ["sit", 10]], micro: [["footTap", 3], ["glanceEdge", 3], ["scratch", 2]] }),
  somnoliento: S({
    dwellS: 30,
    speed: 0.6,
    blinkGap: [1.2, 3],
    breath: { hz: 1.2, amp: 0.42 },
    decide: [["yawn", 16], ["sit", 25]],
    // Saluda igual, con los ojos a media asta (expression.ts).
    micro: [["nod", 5], ["scratch", 1]],
    microGap: [4, 9],
    lowEnergy: true,
  }),
  cansado: S({ speed: moodSpeed("cansado"), blinkGap: [1.5, 3.5], breath: { hz: 1.6, amp: 0.4 }, decide: [["yawn", 18], ["sit", 25]], micro: [["nod", 3], ["shiftWeight", 2]], pranks: false, lowEnergy: true }),
  solitario: S({ dwellS: 20, speed: 0.75, decide: [["lookAround", 18], ["sigh", 6], ["sit", 8]], micro: [["glanceEdge", 5], ["lookBack", 2]], microGap: [2, 6] }),
  grunon: S({
    dwellS: 12,
    speed: 0.9,
    blinkGap: [3, 7],
    decide: [["tapFoot", 14], ["sigh", 6]],
    hover: "turnAway",
    micro: [["footTap", 4], ["shiftWeight", 1]],
    pranks: false,
  }),
  asustado: S({
    dwellS: 4,
    speed: 1.6,
    blinkGap: [0.8, 2],
    breath: { hz: 7, amp: 0.15 },
    decide: [["idle", 30], ["lookAround", 12]],
    hover: "flinch",
    micro: [["shiver", 4], ["glance", 3], ["lookBack", 2]],
    microGap: [0.8, 2.5],
    pranks: false,
    wander: false,
  }),
  triste: S({ speed: moodSpeed("triste"), breath: { hz: 1.6, amp: 0.34 }, decide: [["sigh", 20], ["sit", 18]], hover: "none", hoverIcon: "cloud", micro: [["glanceEdge", 3]], pranks: false, lowEnergy: true }),
  enfadado: S({ dwellS: 3, speed: moodSpeed("enfadado"), decide: [["tapFoot", 22]], hover: "turnAway", hoverIcon: "anger", micro: [["footTap", 4]], pranks: false }),
  celoso: S({ dwellS: 3, speed: moodSpeed("celoso"), decide: [["sigh", 10], ["tapFoot", 10], ["lookAround", 6]], hover: "turnAway", hoverIcon: "puff", micro: [["glanceEdge", 3], ["footTap", 2]], pranks: false }),
};

/**
 * Opciones y pesos al decidir qué hacer en el estado `s`. Sin `wander`
 * (estado quieto o estás concentrado), casi no pasea ni salta a ventanas.
 */
export function choicesFor(s: MoodState, canJump: boolean, onWindow: boolean, wander: boolean): [Choice, number][] {
  const t = STATE_TABLE[s];
  const jump = canJump && !t.lowEnergy;
  const walk = wander ? 1 : 0.15;
  return [
    ...BASE_CHOICES.map(([c, n]): [Choice, number] => [c, c === "walk" ? n * walk : n]),
    ["jumpUp", jump && wander ? 16 : 0],
    ["hopDown", jump && onWindow ? 8 : 0],
    ...t.decide,
  ];
}

/** Elemento de una lista con pesos; `r` en [0, 1). */
export function pickWeighted<T>(list: readonly [T, number][], r: number): T {
  const total = list.reduce((a, [, n]) => a + n, 0);
  let left = r * total;
  for (const [c, n] of list) if ((left -= n) < 0) return c;
  return list[list.length - 1][0];
}
