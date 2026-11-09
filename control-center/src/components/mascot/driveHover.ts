// Mascota — hover falso al terminar la conducción del MCP.
//
// Cuando el agente deja de mover el ratón, Pupus cae justo debajo del
// cursor que estaba llevando. Ese cursor no es tuyo: si cuenta como hover,
// salen los botones, Pupus saluda y la ventana pasa a interactiva sin que
// hayas hecho nada. Durante un margen tras soltarlo, el hover no cuenta
// salvo que muevas el ratón tú.

export const DRIVE_HOVER_MUTE_MS = 2000;
/** Movimiento (px CSS) a partir del cual el cursor es tuyo. */
export const USER_MOVE_PX = 12;

interface Point {
  x: number;
  y: number;
}

export class DriveHoverGuard {
  private until = -Infinity;
  private anchor: Point | null = null;

  /** Empieza (o se renueva) la conducción: nada pendiente. */
  started() {
    this.until = -Infinity;
    this.anchor = null;
  }

  /** La conducción ha terminado con el cursor en `cursor` (px CSS). */
  ended(nowMs: number, cursor: Point | null) {
    this.until = nowMs + DRIVE_HOVER_MUTE_MS;
    this.anchor = cursor ? { ...cursor } : null;
  }

  /** ¿Hay que ignorar el hover en este fotograma? */
  muted(nowMs: number, cursor: Point | null): boolean {
    if (nowMs >= this.until) return false;
    const a = this.anchor;
    if (a && cursor && Math.hypot(cursor.x - a.x, cursor.y - a.y) > USER_MOVE_PX) {
      this.until = -Infinity;
      return false;
    }
    return true;
  }
}
