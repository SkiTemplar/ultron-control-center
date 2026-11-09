// Mascota — disfraces de juego pintados por código (sin hojas de sprites):
// el coche de Rocket League, el parche de pirata y el chaleco táctico. Los
// gorros a juego (tricornio y casco) están en accessories.ts.
//
// Píxeles de DISPOSITIVO en rectángulos de `S` (un píxel de sprite). Origen
// en el centro de los pies, mirando a la derecha (+x); `facing` = -1 refleja.

import { spriteRects, type Box, type Pose } from "./sprite";

const CAR = {
  chassis: "#2F6FE4",
  trim: "#1F4FB0",
  glass: "#9AD7F5",
  light: "#F5C451",
  tire: "#1A1A1A",
  hub: "#9A9A9A",
  flameA: "#F97316",
  flameB: "#F5C451",
};

/** Cuánto sube Pupus para ir sentado en el coche (px de sprite). */
export const CAR_SEAT = 3;

type Px = [number, number, number, number, string];

function paint(ctx: CanvasRenderingContext2D, rects: Px[], fx: number, fy: number, S: number, facing: 1 | -1): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y, w, h, color] of rects) {
    const px = facing === 1 ? fx + x * S : fx - (x + w) * S;
    const py = fy + y * S;
    ctx.fillStyle = color;
    ctx.fillRect(px, py, w * S, h * S);
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px + w * S);
    y1 = Math.max(y1, py + h * S);
  }
  return { x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 };
}

/** Rueda de 3×3; el buje cambia de sitio con `phase` para que parezca girar. */
function wheel(x: number, phase: number): Px[] {
  return [
    [x, -3, 3, 3, CAR.tire],
    phase === 0 ? [x + 1, -2, 1, 1, CAR.hub] : [x + 1, -3, 1, 1, CAR.hub],
  ];
}

/**
 * Coche pequeño (chasis de 18×4 y dos ruedas de 3×3). Todo queda por encima
 * de `fy` (el suelo no lo recorta). `phase` 0/1 alterna el buje de las
 * ruedas y `boosting` añade la llama del turbo detrás.
 */
export function drawCar(
  ctx: CanvasRenderingContext2D,
  fx: number,
  fy: number,
  S: number,
  facing: 1 | -1,
  phase: number,
  boosting: boolean,
): Box {
  const rects: Px[] = [
    [-9, -6, 18, 3, CAR.chassis],
    [-9, -3, 18, 1, CAR.trim],
    [6, -8, 2, 2, CAR.glass],
    [8, -6, 1, 1, CAR.light],
    [-9, -7, 3, 1, CAR.trim],
    ...wheel(-7, phase),
    ...wheel(4, phase),
  ];
  if (boosting) rects.push([-12, -6, 3, 2, CAR.flameA], [-11, -6, 2, 1, CAR.flameB]);
  return paint(ctx, rects, fx, fy, S, facing);
}

/** Desplazamiento vertical con el que drawPet pinta el cuerpo (px de dispositivo). */
function bodyUp(pose: Pose, S: number): number {
  return Math.round(pose.lift * S) + Math.round(Math.min(0.9, Math.max(-0.9, pose.breath)) * S);
}

/** Parche negro sobre el ojo delantero, con su cinta a lo ancho de la cabeza. */
export function drawEyepatch(
  ctx: CanvasRenderingContext2D,
  pose: Pose,
  fx: number,
  fy: number,
  S: number,
  facing: 1 | -1,
): Box | null {
  const parts = spriteRects(pose);
  const [left, top, w] = parts.body[0];
  const mid = left + w / 2;
  const front = parts.eye.filter(([x]) => x >= mid);
  if (!front.length) return null;
  const ex0 = Math.min(...front.map(([x]) => x));
  const ex1 = Math.max(...front.map(([x, , ew]) => x + ew));
  const ey0 = Math.min(...front.map(([, y]) => y));
  const ey1 = Math.max(...front.map(([, y, , eh]) => y + eh));
  const ink = "#141413";
  const strapY = Math.max(top, ey0 - 1);
  const rects: Px[] = [
    [left, strapY, w, 1, ink],
    [ex0 - 1, ey0, ex1 - ex0 + 2, ey1 - ey0, ink],
  ];
  return paint(ctx, rects, fx, fy - bodyUp(pose, S), S, facing);
}

/** Chaleco oliva sobre la mitad de abajo del cuerpo, con dos bolsillos. */
export function drawVest(
  ctx: CanvasRenderingContext2D,
  pose: Pose,
  fx: number,
  fy: number,
  S: number,
  facing: 1 | -1,
): Box {
  const [left, top, w, h] = spriteRects(pose).body[0];
  const vy = top + Math.floor(h / 2);
  const vh = top + h - vy;
  const rects: Px[] = [
    [left, vy, w, vh, "#4B5320"],
    [left + 1, vy + 1, 2, 1, "#3A4119"],
    [left + w - 3, vy + 1, 2, 1, "#3A4119"],
    [left + Math.floor(w / 2) - 1, vy, 2, 1, "#2B2B2B"],
  ];
  return paint(ctx, rects, fx, fy - bodyUp(pose, S), S, facing);
}
