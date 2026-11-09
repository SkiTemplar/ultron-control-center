// Mascota — calendario diminuto que Pupus lleva en la mano el día anterior y
// el mismo día de una entrega (useDeskAlerts.ts lo pone en Decor).
//
// Pixel art de 5 × 7 píxeles de sprite (más las anillas): cabecera roja y,
// si la entrega es hoy, un «!» rojo; si es mañana, una cuadrícula con el
// día siguiente marcado. Misma posición que el fichero en brazos (drawCarry).

import type { Box } from "./sprite";

export type CalendarWhen = "today" | "tomorrow";

const C = {
  edge: "#3A3F4B",
  page: "#F7F4EE",
  head: "#E5484D",
  ring: "#2B2F38",
  cell: "#C9C3B8",
  mark: "#E5484D",
};

/** Anchura y altura del calendario en píxeles de sprite. */
export const CAL_W = 5;
export const CAL_H = 7;

/** Pinta el calendario y devuelve la caja que ensucia (con las anillas). */
export function drawCalendar(
  ctx: CanvasRenderingContext2D,
  fx: number,
  fy: number,
  S: number,
  facing: 1 | -1,
  when: CalendarWhen,
): Box {
  const w = CAL_W * S;
  const h = CAL_H * S;
  const x = facing === 1 ? fx + 3 * S : fx - 3 * S - w;
  const y = fy - 9 * S;
  const ring = Math.max(1, Math.round(S / 2));
  ctx.fillStyle = C.edge;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = C.page;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = C.head;
  ctx.fillRect(x, y, w, S);
  ctx.fillStyle = C.ring;
  ctx.fillRect(x + S, y - ring, ring, 2 * ring);
  ctx.fillRect(x + 3 * S, y - ring, ring, 2 * ring);
  if (when === "today") {
    ctx.fillStyle = C.mark;
    ctx.fillRect(x + 2 * S, y + 2 * S, S, 2 * S);
    ctx.fillRect(x + 2 * S, y + 5 * S, S, S);
  } else {
    for (const [cx, cy] of [
      [1, 2],
      [3, 2],
      [1, 4],
    ] as const) {
      ctx.fillStyle = C.cell;
      ctx.fillRect(x + cx * S, y + cy * S, S, S);
    }
    ctx.fillStyle = C.mark;
    ctx.fillRect(x + 3 * S, y + 4 * S, S, S);
  }
  return { x: x - 2, y: y - ring - 2, w: w + 4, h: h + ring + 4 };
}
