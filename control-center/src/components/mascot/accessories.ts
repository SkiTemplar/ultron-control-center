// Mascota — complementos pintados encima del sprite: hélice de
// gorrocóptero, gorros y el fichero que lleva en brazos. Píxeles de
// DISPOSITIVO, en rectángulos de `S` (un píxel de sprite), como el resto del
// pixel art. Todo se coloca respecto al ancla de la cabeza (headAnchor.ts).

import type { Box } from "./sprite";
import type { Hat } from "./outfits";
import { armY, type HeadAnchor } from "./headAnchor";

const HELI = {
  stick: "#3D3A36",
  bladeA: "#5B8DEF",
  bladeB: "#E5484D",
  cap: "#F5C451",
};

const PAPER = {
  sheet: "#F4F1EA",
  fold: "#C9C3B6",
  line: "#9A958B",
  edge: "#141413",
};

/**
 * Hélice sobre la coronilla (`a`). `phase` 0..1 alterna pala ancha (de
 * frente) y estrecha (de canto) para que gire.
 */
export function drawHeli(ctx: CanvasRenderingContext2D, a: HeadAnchor, S: number, phase: number): Box {
  const fx = a.cx;
  const stickTop = a.top - 2 * S;
  ctx.fillStyle = HELI.stick;
  ctx.fillRect(fx - Math.round(S / 2), stickTop, S, 2 * S);
  const wide = phase < 0.5;
  const half = wide ? 5 : 2;
  const y = stickTop - S;
  ctx.fillStyle = HELI.bladeA;
  ctx.fillRect(fx - half * S, y, half * S, S);
  ctx.fillStyle = HELI.bladeB;
  ctx.fillRect(fx, y, half * S, S);
  ctx.fillStyle = HELI.cap;
  ctx.fillRect(fx - Math.round(S / 2), y - S, S, S);
  return { x: fx - 6 * S, y: y - 2 * S, w: 12 * S, h: 6 * S };
}

/**
 * Flecha hacia abajo en el borde inferior del lienzo, botando: señala un
 * botón de la barra de tareas, que queda justo debajo de la ventana.
 * `x` y `bottom` en px de dispositivo; `t` en segundos (para el bote).
 */
export function drawPointer(ctx: CanvasRenderingContext2D, x: number, bottom: number, S: number, t: number): Box {
  const bob = Math.round(Math.abs(Math.sin(t * 6)) * 2 * S);
  const tip = bottom - 1 - bob;
  const x0 = x - Math.round(S / 2);
  const y0 = tip - 5 * S;
  // Columna, fila, ancho y alto en píxeles de sprite: astil y punta.
  const cells: [number, number, number, number][] = [
    [0, 0, 1, 2],
    [-2, 2, 5, 1],
    [-1, 3, 3, 1],
    [0, 4, 1, 1],
  ];
  for (const [color, pad] of [
    ["#141413", 1],
    ["#F5C451", 0],
  ] as const) {
    ctx.fillStyle = color;
    for (const [c, row, w, h] of cells) {
      ctx.fillRect(x0 + c * S - pad, y0 + row * S - pad, w * S + 2 * pad, h * S + 2 * pad);
    }
  }
  return { x: x0 - 2 * S - 1, y: y0 - 1, w: 5 * S + 2, h: 5 * S + 2 };
}

/** Hoja de papel (un fichero) delante del cuerpo, a la altura de los brazos. */
export function drawCarry(ctx: CanvasRenderingContext2D, a: HeadAnchor, S: number): Box {
  const w = 4 * S;
  const h = 5 * S;
  const x = a.facing === 1 ? a.cx + 3 * S : a.cx - 3 * S - w;
  const y = armY(a, S);
  ctx.fillStyle = PAPER.edge;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = PAPER.sheet;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = PAPER.fold;
  ctx.fillRect(x + w - S, y, S, S);
  ctx.fillStyle = PAPER.line;
  ctx.fillRect(x + Math.round(S / 2), y + 2 * S, w - S, Math.max(1, Math.round(S / 3)));
  ctx.fillRect(x + Math.round(S / 2), y + 3 * S + Math.round(S / 2), w - 2 * S, Math.max(1, Math.round(S / 3)));
  return { x: x - 2, y: y - 2, w: w + 4, h: h + 4 };
}

// ---------------------------------------------------------------------------
// Gorros (outfits.ts decide cuál). Rectángulos en píxeles de sprite con
// origen en el centro de la coronilla, mirando a la derecha (+x).
// ---------------------------------------------------------------------------

type Px = [number, number, number, number, string];

const HATS: Record<Hat, Px[]> = {
  // Gorro de dormir azul que cae hacia atrás, con pompón.
  nightcap: [
    [-6, -1, 12, 1, "#3E63DD"],
    [-5, -2, 9, 1, "#5B7FE8"],
    [-4, -3, 6, 1, "#5B7FE8"],
    [-6, -4, 4, 1, "#5B7FE8"],
    [-8, -4, 2, 2, "#F4F1EA"],
  ],
  // Papá Noel: rojo con ribete y pompón blancos.
  santa: [
    [-6, -1, 12, 1, "#F4F1EA"],
    [-5, -3, 10, 2, "#D92D20"],
    [-3, -5, 7, 2, "#D92D20"],
    [-1, -6, 5, 1, "#D92D20"],
    [3, -6, 2, 1, "#D92D20"],
    [5, -7, 2, 2, "#F4F1EA"],
  ],
  // Bruja: ala ancha negra, cinta morada y punta torcida.
  witch: [
    [-8, -1, 16, 1, "#232323"],
    [-4, -2, 8, 1, "#8E4EC6"],
    [-4, -5, 8, 3, "#232323"],
    [-2, -7, 5, 2, "#232323"],
    [0, -8, 3, 1, "#232323"],
    [2, -9, 2, 1, "#232323"],
  ],
  // Birrete con borla dorada.
  grad: [
    [-4, -1, 8, 1, "#1C1C1C"],
    [-7, -2, 14, 1, "#1C1C1C"],
    [-1, -3, 2, 1, "#1C1C1C"],
    [5, -2, 1, 3, "#F5C451"],
  ],
  // Casco de obra (Unreal).
  hardhat: [
    [-6, -1, 12, 1, "#E0A800"],
    [-5, -3, 10, 2, "#F5C400"],
    [-3, -4, 6, 1, "#F5C400"],
    [-1, -4, 2, 3, "#FFE066"],
  ],
  // Gorra con visera hacia delante (Unity).
  cap: [
    [-5, -3, 9, 2, "#2F6FE4"],
    [-4, -4, 7, 1, "#2F6FE4"],
    [3, -1, 6, 1, "#1F4FB0"],
    [-5, -1, 8, 1, "#2F6FE4"],
    [0, -5, 2, 1, "#1F4FB0"],
  ],
  // Boina de pintor (Blender).
  beret: [
    [-6, -2, 12, 2, "#B42318"],
    [-4, -3, 9, 1, "#B42318"],
    [0, -4, 1, 1, "#7A1A12"],
  ],
  // Tricornio pirata (Sea of Thieves): ala negra con las puntas
  // levantadas, ribete dorado y calavera de 2×2.
  pirate: [
    [-7, -1, 14, 1, "#232323"],
    [-7, -2, 2, 1, "#232323"],
    [5, -2, 2, 1, "#232323"],
    [-5, -2, 10, 1, "#D4A93C"],
    [-4, -4, 8, 2, "#232323"],
    [-1, -4, 2, 2, "#F4F1EA"],
  ],
  // Casco táctico oliva con gafas (Counter-Strike 2).
  helmet: [
    [-6, -1, 12, 1, "#3F4A1E"],
    [-5, -3, 10, 2, "#5B6B2E"],
    [-3, -4, 6, 1, "#5B6B2E"],
    [-5, -2, 10, 1, "#2B2B2B"],
    [0, -2, 2, 1, "#9AD7F5"],
    [3, -2, 2, 1, "#9AD7F5"],
  ],
};

export interface HatRect extends Box {
  color: string;
}

/**
 * Rectángulos del gorro en px de dispositivo (pura): la fila -1 apoya en la
 * coronilla y el reflejo es alrededor del centro del cuerpo.
 */
export function hatRects(hat: Hat, a: HeadAnchor, S: number): HatRect[] {
  return HATS[hat].map(([x, y, w, h, color]) => ({
    x: a.facing === 1 ? a.cx + x * S : a.cx - (x + w) * S,
    y: a.top + y * S,
    w: w * S,
    h: h * S,
    color,
  }));
}

/** Filas de sprite que el gorro sube por encima de la coronilla. */
export function hatHeight(hat: Hat): number {
  return -Math.min(...HATS[hat].map(([, y]) => y));
}

/** Pinta el gorro sobre la coronilla. Devuelve la caja que ensucia. */
export function drawHat(ctx: CanvasRenderingContext2D, hat: Hat, a: HeadAnchor, S: number): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of hatRects(hat, a, S)) {
    ctx.fillStyle = r.color;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 };
}
