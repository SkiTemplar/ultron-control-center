// Mascota — pintado de un fotograma en el canvas (mascota, sombra,
// chincheta, efectos). Trabaja en píxeles de DISPOSITIVO para que el pixel
// art salga nítido también con escalados de Windows no enteros (125 %, 150 %).

import { COLORS, drawPet, drawStar, drawZ, type Box } from "./sprite";
import type { MascotEngine } from "./engine";
import type { ChatState } from "./engine";

export interface Dirty {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function grow(d: Dirty, b: Box) {
  d.x0 = Math.min(d.x0, b.x);
  d.y0 = Math.min(d.y0, b.y);
  d.x1 = Math.max(d.x1, b.x + b.w);
  d.y1 = Math.max(d.y1, b.y + b.h);
}

/**
 * Borra lo pintado en el fotograma anterior (`prev`) y pinta el actual.
 * Devuelve la zona ensuciada para el siguiente borrado.
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  engine: MascotEngine,
  chat: ChatState,
  dpr: number,
  prev: Dirty | null,
): Dirty {
  if (prev) {
    ctx.clearRect(prev.x0 - 2, prev.y0 - 2, prev.x1 - prev.x0 + 4, prev.y1 - prev.y0 + 4);
  }
  const d: Dirty = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const f = engine.frame(chat);
  const S = Math.max(1, Math.round(engine.S * dpr));
  const fx = Math.round(f.x * dpr);
  const fy = Math.round(f.y * dpr);
  const r = Math.round;

  // Sombra en el suelo.
  if (engine.isGrounded() && engine.mode !== "splat") {
    const w = 8 * S;
    ctx.fillStyle = "rgba(0, 0, 0, 0.16)";
    ctx.beginPath();
    ctx.ellipse(fx, fy - S * 0.3, w, S * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    grow(d, { x: fx - w, y: fy - 2 * S, w: 2 * w, h: 3 * S });
  }

  // Chincheta + hilo.
  if (f.pin) {
    const px = r(f.pin.x * dpr);
    const py = r(f.pin.y * dpr);
    const topY = fy - 13 * S;
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = Math.max(1, r(dpr));
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(fx, topY);
    ctx.stroke();
    ctx.fillStyle = COLORS.pinShade;
    ctx.fillRect(px - S, py - S, 3 * S, 3 * S);
    ctx.fillStyle = COLORS.pin;
    ctx.fillRect(px - S, py - 2 * S, 3 * S, 2 * S);
    grow(d, {
      x: Math.min(px, fx) - 2 * S,
      y: Math.min(py, topY) - 3 * S,
      w: Math.abs(px - fx) + 5 * S,
      h: Math.abs(py - topY) + 5 * S,
    });
  }

  grow(d, drawPet(ctx, f.pose, fx, fy, S, f.facing));

  const headY = fy - 11 * S;
  if (f.stars) {
    for (let i = 0; i < 3; i++) {
      const a = engine.t * 5 + (i * Math.PI * 2) / 3;
      const sx = fx + Math.cos(a) * 8 * S;
      const sy = headY - 2 * S + Math.sin(a) * 2 * S;
      drawStar(ctx, sx, sy, Math.max(1, r(S * 0.6)));
    }
    grow(d, { x: fx - 10 * S, y: headY - 6 * S, w: 20 * S, h: 8 * S });
  }

  if (f.zzz) {
    const z = Math.max(1, r(S * 0.7));
    for (let i = 0; i < 3; i++) {
      const ph = (engine.t * 0.5 + i / 3) % 1;
      const zx = fx + f.facing * (6 + ph * 8) * S;
      const zy = headY - ph * 14 * S;
      drawZ(ctx, zx, zy, z, 1 - ph);
    }
    grow(d, { x: fx - 16 * S, y: headY - 16 * S, w: 32 * S, h: 18 * S });
  }

  for (const e of engine.effects) {
    const k = 1 - e.age / e.life;
    const ex = r(e.x * dpr);
    const ey = r(e.y * dpr);
    if (e.kind === "dust") {
      const s = Math.max(1, r(S * (0.6 + 0.6 * k)));
      ctx.fillStyle = `rgba(210, 200, 190, ${(0.85 * k).toFixed(3)})`;
      ctx.fillRect(ex, ey - s, s, s);
      grow(d, { x: ex - 1, y: ey - s - 1, w: s + 2, h: s + 2 });
    } else {
      const rad = (4 + 10 * (1 - k)) * S;
      ctx.lineWidth = Math.max(1, r(S * 0.6));
      ctx.strokeStyle = `rgba(255, 255, 255, ${k.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(ex, ey, rad, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(217, 119, 87, ${k.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(ex, ey, rad + ctx.lineWidth, 0, Math.PI * 2);
      ctx.stroke();
      grow(d, { x: ex - rad - 4 * S, y: ey - rad - 4 * S, w: 2 * rad + 8 * S, h: 2 * rad + 8 * S });
    }
  }
  return d;
}
