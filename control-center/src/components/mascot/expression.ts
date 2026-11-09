// Mascota — cara y cuerpo en reposo según el estado (puro).
//
// Es lo único que delata el estado: cejas, ojos, mirada, brazos,
// aplastamiento, temblor y respiración. Ningún estado lleva etiqueta ni
// icono propio. Lo que pinta cada modo (andar, dormir, en el aire…) manda
// después sobre esto, así que aquí solo va la «postura de fondo».

import type { Overlay } from "./idleLife";
import { STATE_TABLE } from "./moodTable";
import type { MoodState } from "./moodState";

/** Onda cuadrada: true la mitad de cada periodo de `hz`. */
const alt = (t: number, hz: number) => Math.floor(t * hz) % 2 === 0;

/** Pose y ojos de fondo del estado `s` en el instante `t` (segundos). */
export function expressionFor(s: MoodState, t: number): Overlay {
  switch (s) {
    case "feliz":
      return { pose: { blush: Math.sin(t * 0.7) > 0.6 }, eyes: null };
    case "emocionado":
      return { pose: { blush: true, lookY: -0.3 }, eyes: null };
    case "jugueton":
      return { pose: { brows: "up", blush: alt(t, 0.5), lift: Math.abs(Math.sin(t * 5)) * 0.3 }, eyes: null };
    case "curioso":
      // Cejas arriba y, a ratos, ojos como platos.
      return { pose: { brows: "up", lookY: -0.4 }, eyes: Math.sin(t * 0.9) > 0.85 ? "wide" : null };
    case "concentrado":
      return { pose: { brows: "flat", lookY: 0.6 }, eyes: null };
    case "orgulloso":
      return { pose: { sx: 0.97, sy: 1.05, lookY: -0.8, armL: "hips", armR: "hips" }, eyes: null };
    case "aburrido":
      return { pose: { sx: 1.03, sy: 0.97, lookY: 0.3 }, eyes: Math.sin(t * 0.5) > 0.4 ? "sleepy" : null };
    case "somnoliento":
      return { pose: { lookY: 0.6, sy: 0.97 }, eyes: Math.sin(t * 0.8) > -0.3 ? "sleepy" : null };
    case "cansado":
      return { pose: { sy: 0.95, armL: "down", armR: "down" }, eyes: "sleepy" };
    case "solitario":
      // Mira a los bordes, como buscándote.
      return { pose: { brows: "sad", lookY: 0.5, lookX: Math.sin(t * 0.4) > 0 ? 1.4 : -1.4 }, eyes: null };
    case "grunon":
      return { pose: { brows: "flat", armL: "cross", armR: "cross" }, eyes: "sleepy" };
    case "asustado":
      return {
        pose: { sx: 1.02, sy: 0.94, armL: "down", armR: "down", brows: "sad", dx: Math.floor(t * 16) % 4 === 0 ? 1 : 0, lookX: Math.sin(t * 3) * 1.4 },
        eyes: "wide",
      };
    case "triste":
      return { pose: { brows: "sad", lookY: 0.6, armL: "down", armR: "down" }, eyes: null };
    case "enfadado":
      return { pose: { brows: "angry", armL: "cross", armR: "cross" }, eyes: null };
    case "celoso":
      return { pose: { brows: "sad" }, eyes: null };
    case "contento":
      return { pose: {}, eyes: null };
  }
}

/** Respiración (elevación del cuerpo, px de sprite) del estado `s`. */
export function breathFor(s: MoodState, t: number): number {
  const { hz, amp } = STATE_TABLE[s].breath;
  return (Math.sin(t * hz) + 1) * amp;
}
