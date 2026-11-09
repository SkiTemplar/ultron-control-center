// Mascota — pintado de las actividades: accesorios en las manos (libro,
// escoba, caña…), el sedal y los objetos sueltos por el mundo (avión,
// pompas, pelota, mariposa, estrella fugaz). Píxeles de DISPOSITIVO
// en cuadrados de `S`, como el resto del pixel art; cada función devuelve
// la caja que ensucia para que render.ts la borre en el fotograma siguiente.

import type { MascotEngine } from "../engine";
import type { HeadAnchor } from "../headAnchor";
import type { Box } from "../sprite";
import type { FishLine, Px, WorldItem } from "./types";
import { itemAlpha } from "./worldItems";

/** Pinta `px` (px de sprite, mirando a +x) con origen en (ox, oy). */
export function drawPx(ctx: CanvasRenderingContext2D, px: Px[], ox: number, oy: number, S: number, facing: 1 | -1): Box | null {
  if (!px.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y, w, h, color] of px) {
    const rx = Math.round(facing === 1 ? ox + x * S : ox - (x + w) * S);
    const ry = Math.round(oy + y * S);
    ctx.fillStyle = color;
    ctx.fillRect(rx, ry, w * S, h * S);
    x0 = Math.min(x0, rx);
    y0 = Math.min(y0, ry);
    x1 = Math.max(x1, rx + w * S);
    y1 = Math.max(y1, ry + h * S);
  }
  return { x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 };
}

/** Sedal vertical desde la punta de la caña y corcho rojiblanco. */
export function drawLine(ctx: CanvasRenderingContext2D, l: FishLine, fx: number, fy: number, S: number, facing: 1 | -1, dpr: number): Box {
  const tx = Math.round(facing === 1 ? fx + (l.tip[0] + 0.5) * S : fx - (l.tip[0] + 0.5) * S);
  const ty = Math.round(fy + l.tip[1] * S);
  const by = Math.round(fy + l.depth * dpr + (l.dip ? 3 * S : 0));
  const lw = Math.max(1, Math.round(dpr));
  ctx.fillStyle = "rgba(235, 235, 235, 0.85)";
  ctx.fillRect(tx, ty, lw, Math.max(1, by - ty));
  ctx.fillStyle = "#E5484D";
  ctx.fillRect(tx - S, by, 2 * S, S);
  ctx.fillStyle = "#F4F1EA";
  ctx.fillRect(tx - S, by + S, 2 * S, S);
  return { x: tx - S - 1, y: ty - 1, w: 2 * S + lw + 2, h: by + 2 * S - ty + 2 };
}

// ---------------------------------------------------------------------------
// Objetos del mundo (origen en el centro de su base, mirando a +x)
// ---------------------------------------------------------------------------

/** Avión de papel; con el morro arriba si sube. */
export function planePx(climbing: boolean): Px[] {
  const nose: Px = climbing ? [2, -3, 1, 1, "#F4F1EA"] : [3, -2, 1, 1, "#F4F1EA"];
  return [[-2, -2, 5, 1, "#F4F1EA"], [-2, -3, 3, 1, "#F4F1EA"], [-2, -1, 3, 1, "#C9C3B6"], nose];
}

const BUTTERFLY = { a: "#F7A8D8", b: "#FFE066", body: "#3D3A36" };

/** Mariposa de 3×2 con las alas abiertas o cerradas. */
export function butterflyPx(open: boolean): Px[] {
  if (open) return [[-2, -2, 2, 2, BUTTERFLY.a], [1, -2, 2, 2, BUTTERFLY.b], [0, -2, 1, 2, BUTTERFLY.body]];
  return [[-1, -3, 1, 2, BUTTERFLY.a], [1, -3, 1, 2, BUTTERFLY.b], [0, -2, 1, 2, BUTTERFLY.body]];
}

const BALL_COLORS = ["#E5484D", "#5B8DEF", "#F5C451"];

function itemPx(it: WorldItem): { px: Px[]; facing: 1 | -1 } {
  switch (it.kind) {
    case "plane":
      return { px: planePx(it.vy < -20), facing: it.x < it.x0 ? -1 : 1 };
    case "ball":
      return { px: [[-1, -2, 2, 2, BALL_COLORS[Math.floor(it.seed * 3) % 3]]], facing: 1 };
    case "butterfly":
      return { px: butterflyPx(it.stage === 1 ? it.age % 1.2 < 0.3 : Math.floor(it.age * 8) % 2 === 0), facing: it.vx < 0 ? -1 : 1 };
    case "star":
      return { px: [[-1, -1, 2, 2, "#FFF3B0"], [-4, -1, 3, 1, "#F5C451"], [-7, -1, 3, 1, "#9AA4B5"]], facing: it.vx < 0 ? -1 : 1 };
    default:
      return { px: [], facing: 1 };
  }
}

function drawBubble(ctx: CanvasRenderingContext2D, it: WorldItem, dpr: number, S: number): Box {
  const cx = Math.round(it.x * dpr);
  const cy = Math.round(it.y * dpr);
  const r = Math.max(2, Math.round(it.r * dpr));
  ctx.lineWidth = Math.max(1, Math.round(S / 3));
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const s = Math.max(1, Math.round(S / 2));
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.fillRect(cx - Math.round(r / 2), cy - Math.round(r / 2), s, s);
  const pad = ctx.lineWidth + 2;
  return { x: cx - r - pad, y: cy - r - pad, w: 2 * (r + pad), h: 2 * (r + pad) };
}

/** Pinta los objetos sueltos (px CSS → dispositivo). */
export function drawWorldItems(ctx: CanvasRenderingContext2D, items: readonly WorldItem[], dpr: number, S: number): Box[] {
  const out: Box[] = [];
  for (const it of items) {
    if (it.kind === "bubble") {
      out.push(drawBubble(ctx, it, dpr, S));
      continue;
    }
    const { px, facing } = itemPx(it);
    const fade = it.kind === "plane" && it.landed ? itemAlpha(it) : 1;
    ctx.globalAlpha = fade;
    const b = drawPx(ctx, px, Math.round(it.x * dpr), Math.round(it.y * dpr), S, facing);
    ctx.globalAlpha = 1;
    if (b) out.push(b);
  }
  return out;
}

export interface PropsAt {
  fx: number;
  /** Pies (sube CAR_SEAT en coche). */
  seatY: number;
  S: number;
  dpr: number;
  facing: 1 | -1;
  head: HeadAnchor;
}

/** Accesorios y sedal de la actividad en curso. */
export function drawActivityProps(ctx: CanvasRenderingContext2D, engine: MascotEngine, at: PropsAt): Box[] {
  const out: Box[] = [];
  for (const set of engine.acts.props(engine)) {
    const b =
      set.anchor === "head"
        ? drawPx(ctx, set.px, at.head.cx, at.head.top, at.S, at.facing)
        : drawPx(ctx, set.px, at.fx, at.seatY, at.S, at.facing);
    if (b) out.push(b);
  }
  const line = engine.acts.line(engine);
  if (line) out.push(drawLine(ctx, line, at.fx, at.seatY, at.S, at.facing, at.dpr));
  return out;
}
