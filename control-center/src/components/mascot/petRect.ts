// Mascota — dónde está Pupus, para el hilo de soltar ficheros de Rust
// (mascot/drop_assist.rs). Ese hilo abre la ventana a un arrastre OLE sin
// depender de este bucle; aquí solo se le publica el rectángulo en px
// físicos, cuando cambia y como mucho cada THROTTLE_MS. `null` = no se le
// puede soltar nada (silencio de juego, conducido por el MCP).

import { invoke } from "@tauri-apps/api/core";

/** left, top, right, bottom en px físicos de pantalla. */
export type PhysRect = [number, number, number, number];

interface CssBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EnvLike {
  origin_x: number;
  origin_y: number;
  scale_factor: number;
}

export const THROTTLE_MS = 100;

/** Caja CSS (relativa a la ventana de la mascota) → rectángulo físico de pantalla. */
export function toPhysRect(b: CssBox, env: EnvLike): PhysRect {
  const k = env.scale_factor;
  return [
    Math.floor(env.origin_x + b.x * k),
    Math.floor(env.origin_y + b.y * k),
    Math.ceil(env.origin_x + (b.x + b.w) * k),
    Math.ceil(env.origin_y + (b.y + b.h) * k),
  ];
}

type Send = (rect: PhysRect | null) => Promise<unknown>;

const sendToRust: Send = (rect) => invoke("mascot_pet_rect", { rect });

export class PetRectPublisher {
  private last: string | null = null;
  private at = -Infinity;

  constructor(private readonly send: Send = sendToRust) {}

  /** Publica si ha cambiado; un rectángulo nuevo espera THROTTLE_MS, `null` sale al momento. */
  publish(rect: PhysRect | null, nowMs: number) {
    const key = rect ? rect.join(",") : "none";
    if (key === this.last) return;
    if (rect && nowMs - this.at < THROTTLE_MS) return;
    this.last = key;
    this.at = nowMs;
    this.send(rect).catch(() => {
      // Que el siguiente fotograma lo reintente.
      this.last = null;
    });
  }
}
