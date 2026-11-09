// Mascota — qué gorro y qué disfraz lleva Pupus. Funciones puras (con tests).
//
// Prioridad: el juego que tienes delante (tabla de Settings: coche, pirata,
// táctico) > lo que tienes abierto (uni, Unreal, Unity, Blender) > la
// temporada (Navidad, Halloween) > la noche (gorro de dormir). Fuera de
// eso, nada: Pupus es simplón.

import type { GameEntry, GameOutfit } from "./settings";

export type Hat = "grad" | "hardhat" | "cap" | "beret" | "santa" | "witch" | "nightcap" | "pirate" | "helmet";

/** Disfraz pintado sobre (o bajo) el cuerpo (gameOutfits.ts). */
export type Body = "car" | "eyepatch" | "vest";

export interface Look {
  hat: Hat | null;
  body: Body | null;
}

export interface Foreground {
  /** Nombre del ejecutable en minúsculas (p. ej. "unrealeditor.exe"). */
  exe: string;
  title: string;
  /** Carpetas de las asignaturas (en minúsculas), de projects.json. */
  uni_keys: string[];
}

const BY_EXE: [RegExp, Hat][] = [
  [/^unrealeditor(-win64-debuggame)?\.exe$|^ue4editor\.exe$/, "hardhat"],
  [/^unity( hub)?\.exe$/, "cap"],
  [/^blender\.exe$/, "beret"],
];

/** Gorro por lo que hay en primer plano, o null. */
export function contextHat(fg: Foreground | null): Hat | null {
  if (!fg) return null;
  const exe = fg.exe.toLowerCase();
  for (const [re, hat] of BY_EXE) if (re.test(exe)) return hat;
  const title = fg.title.toLowerCase();
  if (title && fg.uni_keys.some((k) => k.length >= 3 && title.includes(k))) return "grad";
  return null;
}

/** Navidad (15 dic – 6 ene) y Halloween (24 oct – 2 nov). */
export function seasonalHat(d: Date): Hat | null {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if ((m === 12 && day >= 15) || (m === 1 && day <= 6)) return "santa";
  if ((m === 10 && day >= 24) || (m === 11 && day <= 2)) return "witch";
  return null;
}

/** La noche de Pupus: de 01:00 a 06:59 (hora local). */
export const NIGHT_START_H = 1;
export const NIGHT_END_H = 7;

/** ¿Es de noche (01:00–06:59)? */
export function isNight(d: Date): boolean {
  const h = d.getHours();
  return h >= NIGHT_START_H && h < NIGHT_END_H;
}

/** De noche (01:00–06:59), o de 22:00 a 00:59 si duerme: gorro de dormir. */
export function nightHat(d: Date, sleeping: boolean): Hat | null {
  const h = d.getHours();
  const late = h >= 22 || h < NIGHT_START_H;
  return isNight(d) || (late && sleeping) ? "nightcap" : null;
}

/** Disfraz de un juego de la tabla. */
export function gameLook(outfit: GameOutfit): Look {
  switch (outfit) {
    case "car":
      return { hat: null, body: "car" };
    case "pirate":
      return { hat: "pirate", body: "eyepatch" };
    case "tactical":
      return { hat: "helmet", body: "vest" };
    default:
      return { hat: null, body: null };
  }
}

/** Gorro y disfraz: el juego manda; si no hay, la cadena de gorros. */
export function chooseLook(fg: Foreground | null, game: GameEntry | null, d: Date, sleeping: boolean): Look {
  if (game && game.outfit !== "none") return gameLook(game.outfit);
  return { hat: contextHat(fg) ?? seasonalHat(d) ?? nightHat(d, sleeping), body: null };
}

export function chooseHat(fg: Foreground | null, d: Date, sleeping: boolean): Hat | null {
  return chooseLook(fg, null, d, sleeping).hat;
}
