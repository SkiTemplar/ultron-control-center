// Mascota — el gorro se le cae al espachurrarse contra el techo o una pared
// (hatPolicy = "knocked", headAnchor.ts). Vuela por su cuenta hasta el suelo
// y allí se queda; cuando Pupus vuelve a estar de pie, se lo pone otra vez
// (el motor lo celebra con un «poof» de chispas).
//
// Unidades: px CSS, como el motor. (x, y) = centro del borde inferior del
// gorro (lo que apoya en la coronilla).

import type { Hat } from "./outfits";

const GRAVITY = 1800;
/** Velocidad horizontal al salir despedido, px/s. */
const KICK_VX = 140;
const KICK_VY = -220;
/** Pasado este tiempo en el suelo, se recoge aunque Pupus siga liado. */
const MAX_AGE_S = 12;

export interface DroppedHat {
  hat: Hat;
  x: number;
  y: number;
  facing: 1 | -1;
}

interface Flight extends DroppedHat {
  vx: number;
  vy: number;
  age: number;
  landed: boolean;
}

export class HatDrop {
  private f: Flight | null = null;

  /** Se cae el gorro desde la coronilla (x, y); `away` = sentido de salida. */
  knock(hat: Hat, x: number, y: number, away: 1 | -1, facing: 1 | -1) {
    this.f = { hat, x, y, facing, vx: away * KICK_VX, vy: KICK_VY, age: 0, landed: false };
  }

  /**
   * Avanza la caída hasta el suelo `floorY`. Con `upright` (Pupus de pie
   * otra vez) o pasado MAX_AGE_S, lo recoge: devuelve true esa vez.
   */
  step(dt: number, floorY: number, upright: boolean): boolean {
    const f = this.f;
    if (!f) return false;
    f.age += dt;
    if ((upright && f.landed) || f.age > MAX_AGE_S) {
      this.f = null;
      return true;
    }
    if (f.landed) return false;
    f.vy += GRAVITY * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (f.y >= floorY) {
      f.y = floorY;
      f.landed = true;
    }
    return false;
  }

  /** Dónde pintarlo (copia), o null si no hay gorro caído. */
  at(): DroppedHat | null {
    const f = this.f;
    return f ? { hat: f.hat, x: f.x, y: f.y, facing: f.facing } : null;
  }
}
