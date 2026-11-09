// Mascota — pintado de un fotograma en el canvas (mascota, sombra,
// chincheta, iconos de emoción, partículas). Trabaja en píxeles de
// DISPOSITIVO para que el pixel art salga nítido también con escalados de
// Windows no enteros (125 %, 150 %).

import { COLORS, drawGlyph, drawPet, drawStar, drawZ, type Box } from "./sprite";
import type { ChatState, Frame, MascotEngine } from "./engine";
import { drawCarry, drawHat, drawHeli, drawPointer, hatHeight } from "./accessories";
import { CAR_SEAT, drawCar, drawEyepatch, drawVest } from "./gameOutfits";
import type { Body } from "./outfits";
import { drawCalendar, type CalendarWhen } from "./calendarProp";
import { headAnchor, iconY } from "./headAnchor";
import { drawActivityProps, drawWorldItems } from "./activities/props";

/** Lo que se pinta encima del motor sin ser estado suyo (useForeground, useTaskbar, useDeskAlerts). */
export interface Decor {
  /** Disfraz de juego (cuelga del ajuste «Gorros y disfraces»). */
  outfit: Body | null;
  /** Flecha hacia un botón de la barra de tareas: x en px CSS, hasta `until` (performance.now). */
  pointer: { x: number; until: number } | null;
  /** Calendario en la mano: entrega hoy o mañana (no con un fichero en brazos). */
  calendar?: { when: CalendarWhen } | null;
}

export const emptyDecor = (): Decor => ({ outfit: null, pointer: null, calendar: null });

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

interface At {
  fx: number;
  fy: number;
  /** Pies de Pupus (sube CAR_SEAT en coche). */
  seatY: number;
  S: number;
  dpr: number;
  t: number;
}

/** Disfraz de juego (sobre el cuerpo) y flecha de la barra de tareas. */
function paintDecor(ctx: CanvasRenderingContext2D, f: Frame, at: At, body: Body | null, decor: Decor): Box[] {
  const { fx, fy, seatY, S } = at;
  const out: Box[] = [];
  if (body === "car" && !f.pin) {
    const phase = Math.floor(fx / (2 * S)) & 1;
    const boosting = f.pose.legs === "run1" || f.pose.legs === "run2";
    out.push(drawCar(ctx, fx, fy, S, f.facing, phase, boosting));
  }
  if (body === "vest") out.push(drawVest(ctx, f.pose, fx, seatY, S, f.facing));
  const patch = body === "eyepatch" ? drawEyepatch(ctx, f.pose, fx, seatY, S, f.facing) : null;
  if (patch) out.push(patch);
  if (decor.pointer && performance.now() < decor.pointer.until) {
    out.push(drawPointer(ctx, Math.round(decor.pointer.x * at.dpr), ctx.canvas.height, S, at.t));
  }
  return out;
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
  decor: Decor = emptyDecor(),
): Dirty {
  if (prev) {
    ctx.clearRect(prev.x0 - 2, prev.y0 - 2, prev.x1 - prev.x0 + 4, prev.y1 - prev.y0 + 4);
  }
  const d: Dirty = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const raw = engine.frame(chat);
  const f = raw;
  const S = Math.max(1, Math.round(engine.S * dpr));
  const fx = Math.round(f.x * dpr);
  const fy = Math.round(f.y * dpr);
  const r = Math.round;
  const liftPx = f.pose.lift * S;
  const body = engine.settings.hats && f.heli === null ? decor.outfit : null;
  const car = body === "car" && !f.pin;
  // En coche va sentado: todo lo de Pupus sube CAR_SEAT píxeles de sprite.
  const seatY = car ? fy - CAR_SEAT * S : fy;

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

  // Todo lo que va en la cabeza sigue a la coronilla real (headAnchor.ts).
  const a = headAnchor(f.pose, fx, seatY, S, f.facing);

  // Chincheta + hilo.
  if (f.pin) {
    const px = r(f.pin.x * dpr);
    const py = r(f.pin.y * dpr);
    const topY = a.top;
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

  // Objetos de las actividades (avión, pompas, mariposa…) detrás de Pupus;
  // lo que lleva en las manos, delante.
  for (const b of drawWorldItems(ctx, engine.acts.items, dpr, S)) grow(d, b);
  grow(d, drawPet(ctx, f.pose, fx, seatY, S, f.facing, f.color));
  for (const b of paintDecor(ctx, f, { fx, fy, seatY, S, dpr, t: engine.t }, body, decor)) grow(d, b);
  for (const b of drawActivityProps(ctx, engine, { fx, seatY, S, dpr, facing: f.facing, head: a })) grow(d, b);
  if (f.heli !== null) grow(d, drawHeli(ctx, a, S, f.heli));
  if (f.carry) grow(d, drawCarry(ctx, a, S));
  // El calendario se diseñó con la coronilla a 10 px de sprite de los pies.
  else if (decor.calendar) grow(d, drawCalendar(ctx, a.cx, a.top + 10 * S, S, f.facing, decor.calendar.when));
  if (f.hat) grow(d, drawHat(ctx, f.hat, a, S));
  const drop = f.hatDrop;
  if (drop) grow(d, drawHat(ctx, drop.hat, { cx: r(drop.x * dpr), top: r(drop.y * dpr), w: 0, facing: drop.facing }, S));

  // Estrellas, zetas e iconos, por encima del gorro si lo lleva.
  const headY = iconY(a, S) - (f.hat ? (hatHeight(f.hat) - 1) * S : 0);
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

/** Cada cuántos fotogramas se borra el lienzo entero como red de seguridad. */
export const FULL_CLEAR_EVERY = 60;

/**
 * Pinta fotograma a fotograma borrando solo la zona sucia del anterior.
 * Para que nunca queden restos en una ventana que cubre el monitor:
 *   * si un fotograma lanza una excepción, lo que llegó a pintar no consta
 *     en la zona sucia, así que el siguiente borra el lienzo entero;
 *   * cada `fullEvery` fotogramas se borra todo (lo que se escape a la
 *     contabilidad de zonas dura, como mucho, un segundo).
 */
export class CanvasPainter {
  private dirty: Dirty | null = null;
  private wipe = true;
  private frames = 0;

  constructor(
    private readonly fullEvery = FULL_CLEAR_EVERY,
    /** Compartido con useForeground y useTaskbar (disfraz y flecha). */
    readonly decor: Decor = emptyDecor(),
  ) {}

  /** El lienzo cambió de tamaño (y con ello se vació). */
  reset() {
    this.dirty = null;
    this.wipe = false;
  }

  paint(ctx: CanvasRenderingContext2D, engine: MascotEngine, chat: ChatState, dpr: number) {
    this.frames++;
    if (this.wipe || this.frames % this.fullEvery === 0) {
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      this.dirty = null;
    }
    this.wipe = true;
    this.dirty = renderFrame(ctx, engine, chat, dpr, this.dirty, this.decor);
    this.wipe = false;
  }
}
