// Mascota — tipos y constantes compartidos por las capas del motor.
//
// engine.ts reexporta los tipos públicos: los importadores siguen usando
// "./engine". Unidades: px CSS dentro de la ventana de la mascota; (x, y) =
// centro de los pies.

import type { DroppedHat } from "./hatDrop";
import type { Hat } from "./outfits";
import type { Glyph, Pose } from "./sprite";

export type Mode =
  | "idle"
  | "walk"
  | "sit"
  | "sleep"
  | "crouch"
  | "air"
  | "land"
  | "drag"
  | "hang"
  | "splat"
  | "dizzy"
  | "wave"
  | "emote"
  | "drive"
  /** Volando con la hélice hacia un punto (Ctrl+Alt+clic). */
  | "fly"
  /** Trepando por el lateral de la ventana de Sessions (engineClimb.ts). */
  | "climb"
  /** Actividad con guion: leer, pescar, malabares… (activities/). */
  | "act";

/** Lado de la pantalla por el que sale hacia otro monitor. */
export type Side = "left" | "right";

/** Tramos verticales (px CSS) de cada borde que dan a otro monitor. */
export interface Exits {
  left: [number, number][];
  right: [number, number][];
}

export type ChatState = "none" | "listen" | "think" | "talk";
/** Lado del cuerpo que recibe el golpe. */
export type Surface = "floor" | "left" | "right" | "ceil";

export interface FrameInput {
  dt: number;
  /** Cursor en px CSS (null = desconocido). */
  cursor: { x: number; y: number } | null;
  /** Cursor encima de la mascota o de sus botones/bocadillos. */
  hovered: boolean;
  /** Cursor encima del cuerpo de la mascota (para las caricias). */
  petHover?: boolean;
  chat: ChatState;
}

export type EffectKind = "dust" | "ring" | "spark" | "heart" | "note" | "tear";

export interface Effect {
  kind: EffectKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  color?: string;
}

export interface Frame {
  pose: Pose;
  facing: 1 | -1;
  x: number;
  y: number;
  /** Color del cuerpo (CSS). */
  color: string;
  /** Chincheta de la que cuelga (modo «hang»). */
  pin: { x: number; y: number } | null;
  zzz: boolean;
  stars: boolean;
  /** Icono de emoción encima de la cabeza. */
  icon: { glyph: Glyph; age: number; life: number } | null;
  /** Hélice de gorrocóptero en la cabeza (fase de giro 0..1). */
  heli: number | null;
  /** Gorro (uni, Unreal, Navidad, noche…) o null. */
  hat: Hat | null;
  /** Nombre del fichero que lleva en brazos. */
  carry: string | null;
  /** Gorro que se le ha caído (px CSS, hatDrop.ts), o null. */
  hatDrop: DroppedHat | null;
}

/** Superficie sobre la que se apoya: el suelo, el borde de una ventana o nada (en el aire). */
export type Ground = { kind: "floor" } | { kind: "win"; id: number; winLeft: number } | null;

/** Punto (px CSS). */
export type Point = { x: number; y: number };

export const GRAVITY = 2400; // px/s² con gravedad 1
export const WALK_SPEED = 14; // px de sprite por segundo
export const SPLAT_SPEED = 1500; // px/s de impacto para quedarse espachurrada
export const MAX_SPEED = 4200;
export const AIR_STEP = 1 / 120;
/** Viajes: saltos máximos antes de rendirse y volar, y velocidades. */
export const MAX_HOPS = 8;
export const RUN_SPEED = 45; // px de sprite por segundo (corre, no pasea)
/** Más lejos que esto (px CSS) no corre: saca la hélice. */
export const RUN_MAX = 900;
export const FLY_SPEED = 1100; // px CSS por segundo
/** Segundos mínimos entre travesuras con el cursor. */
export const PRANK_COOLDOWN = 600;

/** Modos en los que está apoyada en una superficie. */
export const GROUNDED: Mode[] = ["idle", "walk", "sit", "sleep", "crouch", "land", "dizzy", "wave", "emote", "act"];
