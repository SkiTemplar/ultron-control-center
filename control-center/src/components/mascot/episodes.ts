// Mascota — memoria de sucesos recientes (modelo puro).
//
// Pupus recuerda QUÉ pasó y CUÁNDO (nunca títulos, rutas ni nombres: el
// repo es público y la memoria se guarda en localStorage). Con eso cambia
// su forma de ser durante un rato: tras varios lanzamientos seguidos se
// queda receloso, dos fallos seguidos lo ponen gruñón, al volver tras una
// ausencia larga te saluda con más ganas, etc.

import type { Emote } from "./engine";
import type { Feelings } from "./feelings";
import type { Mood } from "./mood";

export type EpisodeKind =
  | "caricia"
  | "cosquillas"
  | "lanzado"
  | "zarandeado"
  | "espachurrado"
  | "pinchado"
  | "despertado"
  | "ficheroCogido"
  | "turnoTerminado"
  | "sesionFallida"
  | "sesionEspera"
  /** Build o tests en rojo (alerts.rs: hook run-project-tests y transcripts). */
  | "testsRojos"
  /** Build o tests otra vez en verde tras un fallo. */
  | "testsArreglados"
  | "juegoEmpieza"
  | "juegoTermina"
  | "llamadaEmpieza"
  | "llamadaTermina"
  | "teVas"
  | "vuelves";

export interface Episode {
  k: EpisodeKind;
  /** Hora (epoch ms). */
  at: number;
}

export const MAX_EPISODES = 40;
export const EPISODE_TTL_MS = 24 * 3600_000;

const MIN = 60_000;

export interface Impact {
  mood?: Partial<Mood>;
  feel?: Partial<Feelings>;
  /** Gesto con el que reacciona (si quien lo anota lo permite). */
  react?: Emote;
}

/**
 * Efecto inmediato de cada suceso. Los del ratón (caricia, lanzamiento…) no
 * llevan `mood`: el motor ya mueve el ánimo en ese momento.
 */
export const EPISODE_IMPACT: Record<EpisodeKind, Impact> = {
  caricia: { feel: { fear: -0.4, lonely: -0.6 } },
  cosquillas: { feel: { fear: -0.3, lonely: -0.4, curiosity: 0.1 } },
  lanzado: { feel: { fear: 0.3 } },
  zarandeado: { feel: { fear: 0.25 } },
  espachurrado: { feel: { fear: 0.15 } },
  pinchado: { feel: { lonely: -0.3, curiosity: 0.05 } },
  despertado: {},
  ficheroCogido: { feel: { curiosity: 0.35, pride: 0.1 } },
  turnoTerminado: { mood: { happy: 0.08 }, feel: { pride: 0.35 } },
  sesionFallida: { mood: { happy: -0.1 }, feel: { fear: 0.15 } },
  sesionEspera: { feel: { curiosity: 0.3 } },
  testsRojos: { mood: { happy: -0.08, anger: 0.1 } },
  testsArreglados: { mood: { happy: 0.15 }, feel: { pride: 0.5 }, react: "joy" },
  juegoEmpieza: { feel: { curiosity: -0.2 } },
  juegoTermina: { feel: { curiosity: 0.35 }, react: "stretch" },
  llamadaEmpieza: {},
  llamadaTermina: { react: "stretch" },
  teVas: {},
  vuelves: { mood: { happy: 0.15, boredom: -1 }, feel: { lonely: -1 }, react: "hop" },
};

/** Lista nueva con el suceso, sin los caducados (TTL) y con tope MAX_EPISODES. */
export function remember(list: readonly Episode[], ep: Episode): Episode[] {
  return [...list, ep].filter((e) => ep.at - e.at < EPISODE_TTL_MS).slice(-MAX_EPISODES);
}

export function countSince(list: readonly Episode[], k: EpisodeKind, nowMs: number, windowMs: number): number {
  return list.filter((e) => e.k === k && nowMs - e.at <= windowMs).length;
}

export function lastOf(list: readonly Episode[], k: EpisodeKind): Episode | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].k === k) return list[i];
  return null;
}

/** Cuántos `k` seguidos hay al final, sin contar otros sucesos salvo los que la rompen. */
export function streak(list: readonly Episode[], k: EpisodeKind, breakers: readonly EpisodeKind[]): number {
  let n = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].k === k) n++;
    else if (breakers.includes(list[i].k)) break;
  }
  return n;
}

const KINDS = new Set<string>(Object.keys(EPISODE_IMPACT));

/** Memoria guardada: descarta lo que no sea un suceso válido. */
export function parseEpisodes(raw: unknown): Episode[] {
  if (!Array.isArray(raw)) return [];
  const ok = raw.filter(
    (e): e is Episode =>
      !!e && typeof e === "object" && KINDS.has((e as Episode).k) && Number.isFinite((e as Episode).at),
  );
  return ok.map((e) => ({ k: e.k, at: e.at })).slice(-MAX_EPISODES);
}

/** ¿Se ha llevado varios lanzamientos en 10 min sin una caricia después? */
export function isWary(list: readonly Episode[], nowMs: number): boolean {
  if (countSince(list, "lanzado", nowMs, 10 * MIN) < 3) return false;
  const lastThrow = lastOf(list, "lanzado");
  const lastPet = lastOf(list, "caricia");
  return !lastPet || !lastThrow || lastPet.at < lastThrow.at;
}

/** Dos o más fallos seguidos (sin un arreglo entre medias). */
export function isGrumpyStreak(list: readonly Episode[]): boolean {
  return streak(list, "testsRojos", ["testsArreglados"]) >= 2;
}

/** Cuánto duró la última ausencia (teVas → ahora), o 0 si no consta. */
export function absenceMs(list: readonly Episode[], nowMs: number): number {
  const away = lastOf(list, "teVas");
  const back = lastOf(list, "vuelves");
  if (!away || (back && back.at > away.at)) return 0;
  return nowMs - away.at;
}

/**
 * Reposo extra de los sentimientos según lo que recuerda: receloso tras
 * varios lanzamientos; curioso al terminar una partida de más de una hora.
 */
export function memoryBias(list: readonly Episode[], nowMs: number): Partial<Feelings> {
  const bias: Partial<Feelings> = {};
  if (isWary(list, nowMs)) bias.fear = 0.2;
  const end = lastOf(list, "juegoTermina");
  const start = lastOf(list, "juegoEmpieza");
  if (end && start && nowMs - end.at < 10 * MIN && end.at - start.at > 60 * MIN) bias.curiosity = 0.45;
  return bias;
}

/** Suceso de un aviso de build o tests (deskAlerts.ts). */
export function deskEpisode(state: "failed" | "cleared"): EpisodeKind {
  return state === "failed" ? "testsRojos" : "testsArreglados";
}

/** Suceso de un aviso de Sessions (sessionsWatch.ts), o null. */
export function sessionEpisode(kind: string): EpisodeKind | null {
  if (kind === "turnDone") return "turnoTerminado";
  if (kind === "failed") return "sesionFallida";
  if (kind === "waiting") return "sesionEspera";
  return null;
}
