// Mascota — pintado de un fotograma en el canvas (mascota, sombra,
// chincheta, iconos de emoción, partículas). Trabaja en píxeles de
// DISPOSITIVO para que el pixel art salga nítido también con escalados de
// Windows no enteros (125 %, 150 %).

import { COLORS, drawGlyph, drawPet, drawStar, drawZ, type Box } from "./sprite";
import type { ChatState, MascotEngine } from "./engine";

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

/** Curva de «pop» para que los iconos aparezcan con un pequeño rebote. */
function popScale(age: number): number {
  if (age >= 0.25) return 1;
  const k = age / 0.25;
  // Crece hasta 1.3 y se asienta en 1.
  return Math.max(0.25, k < 0.6 ? (k / 0.6) * 1.3 : 1.3 - ((k - 0.6) / 0.4) * 0.3);
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
  const liftPx = f.pose.lift * S;

  // Sombra en el suelo (se encoge cuando da saltitos).
  if (engine.isGrounded() && engine.mode !== "splat") {
    const k = Math.max(0.5, 1 - liftPx / (14 * S));
    const w = 8 * S * k;
    ctx.fillStyle = `rgba(0, 0, 0, ${(0.16 * k).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(fx, fy - S * 0.3, w, S * 0.9 * k, 0, 0, Math.PI * 2);
    ctx.fill();
    grow(d, { x: fx - 8 * S, y: fy - 2 * S, w: 16 * S, h: 3 * S });
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

  grow(d, drawPet(ctx, f.pose, fx, fy, S, f.facing, f.color));

  const headY = fy - 11 * S - liftPx;
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
    const z = Math.max(1, r(S * 0.5));
    for (let i = 0; i < 3; i++) {
      const ph = (engine.t * 0.5 + i / 3) % 1;
      const zx = fx + f.facing * (6 + ph * 8) * S + Math.sin(ph * 6) * S;
      const zy = headY - ph * 14 * S;
      drawZ(ctx, zx, zy, z, 1 - ph);
    }
    grow(d, { x: fx - 18 * S, y: headY - 16 * S, w: 36 * S, h: 18 * S });
  }

  // Icono de emoción: aparece con un rebote, flota y se desvanece.
  if (f.icon) {
    const { glyph, age, life } = f.icon;
    const fade = Math.min(1, (life - age) / 0.3);
    const gs = Math.max(1, r(S * 0.8 * popScale(age)));
    const iy = headY - 6 * S - Math.sin(age * 4) * S * 0.6;
    const ix = fx + f.facing * 5 * S;
    grow(d, drawGlyph(ctx, glyph, ix, iy, gs, fade));
  }

  for (const e of engine.effects) {
    const k = 1 - e.age / e.life;
    const ex = r(e.x * dpr);
    const ey = r(e.y * dpr);
    switch (e.kind) {
      case "dust": {
        const s = Math.max(1, r(S * (0.6 + 0.6 * k)));
        ctx.fillStyle = `rgba(210, 200, 190, ${(0.85 * k).toFixed(3)})`;
        ctx.fillRect(ex, ey - s, s, s);
        grow(d, { x: ex - 1, y: ey - s - 1, w: s + 2, h: s + 2 });
        break;
      }
      case "ring": {
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
        break;
      }
      case "spark": {
        // Parpadea mientras se apaga.
        if (Math.sin(e.age * 40) < -0.3 && k < 0.7) break;
        const s = Math.max(1, r(S * 0.45 * (0.5 + k)));
        ctx.globalAlpha = Math.min(1, k * 1.5);
        drawStar(ctx, ex, ey, s, e.color ?? COLORS.star);
        ctx.globalAlpha = 1;
        grow(d, { x: ex - 2 * s, y: ey - 2 * s, w: 4 * s, h: 4 * s });
        break;
      }
      case "heart":
      case "note":
        grow(d, drawGlyph(ctx, e.kind, ex, ey, Math.max(1, r(S * 0.55)), Math.min(1, k * 2)));
        break;
      case "tear": {
        const s = Math.max(1, r(S * 0.6));
        ctx.fillStyle = `rgba(124, 200, 255, ${Math.min(1, k * 2).toFixed(3)})`;
        ctx.fillRect(ex, ey, s, 2 * s);
        grow(d, { x: ex - 1, y: ey - 1, w: s + 2, h: 2 * s + 2 });
        break;
      }
    }
  }
  return d;
}
