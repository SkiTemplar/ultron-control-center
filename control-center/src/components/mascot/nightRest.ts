// Mascota — la noche de Pupus (01:00-06:59, isNight de outfits.ts): se
// duerme en la mitad del tiempo de «Se duerme tras» y, si lo despiertas,
// bosteza antes de nada (el bostezo lo lanza el motor).

import { isNight } from "./outfits";

/** De noche se duerme en esta fracción del tiempo configurado. */
export const NIGHT_SLEEP_FACTOR = 0.5;

/** Segundos sin caso antes de dormirse (0 = nunca), según la hora. */
export function sleepAfterS(sleepAfterMin: number, now: Date): number {
  const s = Math.max(0, sleepAfterMin) * 60;
  return isNight(now) ? s * NIGHT_SLEEP_FACTOR : s;
}

/** ¿Bosteza al despertar? Solo de noche. */
export function yawnsOnWake(now: Date): boolean {
  return isNight(now);
}
