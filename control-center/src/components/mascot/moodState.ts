// Mascota — estado de ánimo con nombre y con histéresis (modelo puro).
//
// Cada estado recibe una puntuación a partir del ánimo (mood.ts), los
// sentimientos (feelings.ts), la escena (hora, lo que haces, el cursor) y
// la memoria de sucesos (episodes.ts). Gana el más alto, pero solo si
// supera al actual por un margen y el actual ya ha durado su mínimo: así no
// parpadea entre dos estados. Los urgentes (miedo, enfado, celos) entran al
// momento.
//
// El estado NUNCA se pinta como etiqueta ni icono: solo cambia la cara, la
// postura, el ritmo y las conductas (moodTable.ts, expression.ts).

import type { Emote } from "./engine";
import type { Activity } from "./ambient";
import { isFocusActivity } from "./ambient";
import { isGrumpyStreak, lastOf, type Episode } from "./episodes";
import type { Feelings } from "./feelings";
import type { Mood, MoodName } from "./mood";
import { isNight } from "./outfits";

export type MoodState =
  | MoodName
  | "jugueton"
  | "curioso"
  | "concentrado"
  | "orgulloso"
  | "somnoliento"
  | "solitario"
  | "grunon"
  | "asustado";

export const MOOD_STATES: readonly MoodState[] = [
  "contento",
  "feliz",
  "emocionado",
  "jugueton",
  "curioso",
  "concentrado",
  "orgulloso",
  "aburrido",
  "somnoliento",
  "cansado",
  "solitario",
  "grunon",
  "asustado",
  "triste",
  "enfadado",
  "celoso",
];

/** Entran al momento, sin esperar la permanencia mínima del estado actual. */
export const URGENT: ReadonlySet<MoodState> = new Set<MoodState>(["asustado", "enfadado", "celoso"]);

/** Ventaja mínima para cambiar de estado. */
export const MARGIN = 0.12;

export interface Scene {
  now: Date;
  activity: Activity;
  /** Has tocado teclado o ratón hace poco. */
  userActive: boolean;
  /** El cursor se mueve cerca de Pupus sin estar encima (ganas de jugar). */
  cursorPlay: boolean;
}

const WOKEN_GRUMPY_MS = 60_000;

function lateNight(d: Date): boolean {
  const h = d.getHours();
  return h >= 22 || h < 1;
}

function grumpyScore(m: Mood, eps: readonly Episode[], nowMs: number): number {
  const woke = lastOf(eps, "despertado");
  const justWoken = !!woke && nowMs - woke.at < WOKEN_GRUMPY_MS;
  return (m.anger > 0.25 && m.anger <= 0.5) || justWoken || isGrumpyStreak(eps) ? 0.6 : 0;
}

function sleepyScore(m: Mood, now: Date): number {
  if (isNight(now) || (lateNight(now) && m.energy < 0.6)) return 0.58;
  return m.energy < 0.35 ? 0.5 : 0;
}

/** Puntuación de cada estado (0 = no aplica). */
export function scoreStates(
  m: Mood,
  f: Feelings,
  scene: Scene,
  eps: readonly Episode[],
  nowMs: number,
): Record<MoodState, number> {
  const playful = m.happy > 0.4 && m.energy > 0.6 && m.boredom >= 0.3 && m.boredom <= 0.7 && scene.cursorPlay;
  return {
    contento: 0.3,
    feliz: m.happy > 0.45 ? 0.35 + m.happy * 0.3 : 0,
    emocionado: m.happy > 0.7 && m.energy > 0.6 ? 0.75 : 0,
    jugueton: playful ? 0.62 : 0,
    curioso: f.curiosity > 0.35 ? 0.4 + f.curiosity * 0.3 : 0,
    concentrado: isFocusActivity(scene.activity) && scene.userActive ? 0.5 : 0,
    orgulloso: f.pride > 0.3 ? 0.45 + f.pride * 0.4 : 0,
    aburrido: m.boredom > 0.75 ? 0.55 : 0,
    somnoliento: sleepyScore(m, scene.now),
    cansado: m.energy < 0.2 ? 0.7 + (0.2 - m.energy) : 0,
    solitario: f.lonely > 0.4 ? 0.4 + f.lonely * 0.3 : 0,
    grunon: grumpyScore(m, eps, nowMs),
    asustado: f.fear > 0.45 ? 0.6 + f.fear * 0.4 : 0,
    triste: m.happy < -0.3 ? 0.6 - m.happy * 0.3 : 0,
    enfadado: m.anger > 0.5 ? 0.9 + m.anger * 0.1 : 0,
    celoso: m.jealousy > 0.45 ? 0.85 + m.jealousy * 0.1 : 0,
  };
}

function best(scores: Record<MoodState, number>): MoodState {
  let top: MoodState = "contento";
  for (const s of MOOD_STATES) if (scores[s] > scores[top]) top = s;
  return top;
}

/**
 * Estado siguiente con histéresis. `dwellS` = permanencia mínima del estado
 * actual; `sinceChangeS` = cuánto lleva en él.
 */
export function pickState(
  prev: MoodState,
  scores: Record<MoodState, number>,
  sinceChangeS: number,
  dwellS: number,
): MoodState {
  const top = best(scores);
  if (top === prev) return prev;
  const lead = scores[top] - scores[prev];
  if (URGENT.has(top) && lead > 0) return top;
  return lead > MARGIN && sinceChangeS >= dwellS ? top : prev;
}

const CUES: [MoodState | "*", MoodState | "*", Emote][] = [
  ["*", "asustado", "surprised"],
  ["somnoliento", "emocionado", "stretch"],
  ["somnoliento", "feliz", "stretch"],
  ["solitario", "emocionado", "hop"],
  ["solitario", "feliz", "hop"],
  ["grunon", "contento", "sigh"],
  ["concentrado", "contento", "stretch"],
  ["aburrido", "jugueton", "hop"],
  ["contento", "curioso", "lookAround"],
];

/** Gesto de transición entre dos estados (tabla), o null. */
export function transitionCue(from: MoodState, to: MoodState): Emote | null {
  if (from === to) return null;
  const hit = CUES.find(([a, b]) => (a === "*" || a === from) && (b === "*" || b === to));
  return hit ? hit[2] : null;
}
