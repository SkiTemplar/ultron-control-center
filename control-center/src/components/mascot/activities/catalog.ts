// Mascota — catálogo de actividades y su rareza.
//
// Rareza: tras cada actividad pasan al menos GLOBAL_GAP_S segundos antes de
// ofrecer otra, y cada una tiene su propio cooldown. Al decidir qué hacer
// (cada 2-6 s cuando nadie le hace caso), la opción «actividad» pesa
// OFFER_WEIGHT frente a unos 100-130 del resto de opciones: sale una cada
// 1,5-3 min de inactividad. Estimación sin medir: hay que calibrarla.

import { avion, barrer } from "./crafts";
import { bailar } from "./music";
import { arrastrarse, catalejo, conducir } from "./outfitActs";
import { mariposa, pescar } from "./outdoors";
import { gimnasia, malabares, pompas, voltereta } from "./play";
import { bienvenida, estrellas, leer } from "./quiet";
import type { ActivityDef, ActivityId } from "./types";

export const GLOBAL_GAP_S = 75;
export const OFFER_WEIGHT = 10;
/** Tope de objetos sueltos por el mundo a la vez. */
export const MAX_ITEMS = 14;
/** Probabilidad por minuto de ponerse a bailar mientras suena música. */
export const DANCE_PER_MIN = 0.25;
/** Hueco mínimo tras otra actividad para bailar o saludar. */
export const REQUEST_GAP_S = 20;

const ALL: ActivityDef[] = [
  leer,
  estrellas,
  bienvenida,
  malabares,
  pompas,
  voltereta,
  gimnasia,
  barrer,
  avion,
  pescar,
  mariposa,
  bailar,
  catalejo,
  arrastrarse,
  conducir,
];

export const CATALOG: Readonly<Record<ActivityId, ActivityDef>> = Object.fromEntries(
  ALL.map((d) => [d.id, d]),
) as Record<ActivityId, ActivityDef>;

export const ACTIVITY_IDS = ALL.map((d) => d.id);
