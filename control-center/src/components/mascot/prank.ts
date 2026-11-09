// Mascota — travesura con el cursor: Pupus se agarra a él y tira un poco
// hacia sí durante medio segundo. Se corta en cuanto el usuario mueve el
// ratón (el cursor ya no está donde lo dejamos).

import { invoke } from "@tauri-apps/api/core";
import type { RawCursor } from "./navigator";
import type { Env } from "./screens";

const DURATION_MS = 600;
/** Tirón máximo, en px CSS. */
const MAX_PULL = 70;
/** Si el cursor se aleja más que esto de donde lo pusimos, lo ha movido el usuario. */
const USER_MOVED_PX = 8;

export class CursorPrank {
  private run: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    t0: number;
    last: { x: number; y: number };
  } | null = null;

  /** Empieza a tirar del cursor `c` hacia el punto `toward` (px CSS). */
  start(c: RawCursor, toward: { x: number; y: number }, env: Env, now: number) {
    const tx = env.origin_x + toward.x * env.scale_factor;
    const ty = env.origin_y + toward.y * env.scale_factor;
    const dx = tx - c.x;
    const dy = ty - c.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return;
    const pull = Math.min(d * 0.6, MAX_PULL * env.scale_factor);
    this.run = {
      from: { x: c.x, y: c.y },
      to: { x: c.x + (dx / d) * pull, y: c.y + (dy / d) * pull },
      t0: now,
      last: { x: c.x, y: c.y },
    };
  }

  tick(c: RawCursor | null, now: number) {
    const r = this.run;
    if (!r || !c) return;
    if (Math.hypot(c.x - r.last.x, c.y - r.last.y) > USER_MOVED_PX || c.lbutton) {
      this.run = null; // el usuario manda
      return;
    }
    const k = Math.min(1, (now - r.t0) / DURATION_MS);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    const x = Math.round(r.from.x + (r.to.x - r.from.x) * e);
    const y = Math.round(r.from.y + (r.to.y - r.from.y) * e);
    r.last = { x, y };
    invoke("mascot_nudge_cursor", { x, y }).catch(() => {
      this.run = null;
    });
    if (k >= 1) this.run = null;
  }
}
