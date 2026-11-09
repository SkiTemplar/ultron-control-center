// Mascota — capa de física del motor: caída libre, choques, espachurrones,
// colgarse de una chincheta, arrastre y saltos planificados.
//
// Unidades: px CSS; (x, y) = centro de los pies. Hereda de EngineCore.

import { coveredAbove, type Platform } from "./world";
import { jumpablePlatforms } from "./sessionsInside";
import { clamp } from "./activities/util";
import { nudge } from "./mood";
import { dustEffects } from "./particles";
import { wallRunUp } from "./travel";
import { EngineCore } from "./engineCore";
import { AIR_STEP, MAX_SPEED, SPLAT_SPEED, type Ground, type Point, type Surface } from "./engineTypes";

/** Agarre del arrastre: desfase respecto al cursor y muestras recientes para la velocidad. */
type DragGrip = { offX: number; offY: number; samples: { x: number; y: number; t: number }[] };

/** Lo que un salto planificado sube por encima de su destino (px CSS por unidad de escala). */
const JUMP_APEX = 8;

/** Salto a lo alto de una isla de la barra: despegue con carrerilla, caída y borde. */
export type IslandHop = { id: number; takeoffX: number; landX: number; top: number };

export class EnginePhysics extends EngineCore {
  protected pendingJump: { vx: number; vy: number } | null = null;
  protected splatSide: Surface = "floor";
  protected dizzyAfterLand = false;
  protected waveAfterLand = false;
  protected swing = 0;
  protected swingV = 0;
  protected hangAnchor: Point | null = null;
  protected drag: DragGrip | null = null;

  // -------------------------------------------------------------------------
  // En el aire
  // -------------------------------------------------------------------------

  /** Integra la caída en subpasos fijos mientras siga en el aire. */
  protected stepAirFor(dt: number) {
    for (let left = dt; left > 1e-6 && this.mode === "air"; left -= AIR_STEP) {
      this.stepAir(Math.min(AIR_STEP, left));
    }
  }

  private stepAir(dt: number) {
    const px = this.x;
    const py = this.y;
    this.vy = Math.min(this.vy + this.g * dt, MAX_SPEED);
    this.vx *= 1 - 0.12 * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Ventanas sólidas (opcional): laterales y parte de abajo.
    if (this.settings.collide_windows) {
      this.collideWindows(px, py);
      if (this.mode !== "air") return;
    }
    if (!this.collideScreen()) return;

    // Aterrizar: bordes superiores de ventanas (de un solo sentido) o suelo.
    if (this.vy > 0) this.landBelow(py);
  }

  /** Choques con los laterales y la parte de abajo de las ventanas; (px, py) = posición anterior. */
  private collideWindows(px: number, py: number) {
    const hw = this.halfW;
    const h = this.height;
    this.wins.forEach((w, i) => {
      if (this.mode !== "air" || w.top <= 4) return;
      const L = this.x - hw;
      const R = this.x + hw;
      const T = this.y - h;
      const B = this.y;
      const vOverlap = B > w.top + 2 && T < w.bottom;
      const midY = clamp(this.y - h / 2, w.top, w.bottom - 1);
      if (vOverlap && px + hw <= w.left && R > w.left && !coveredAbove(this.wins, i, w.left, midY)) {
        this.x = w.left - hw;
        this.hit("right", this.vx);
      } else if (vOverlap && px - hw >= w.right && L < w.right && !coveredAbove(this.wins, i, w.right - 1, midY)) {
        this.x = w.right + hw;
        this.hit("left", -this.vx);
      } else if (
        py - h >= w.bottom &&
        T < w.bottom &&
        R > w.left &&
        L < w.right &&
        !coveredAbove(this.wins, i, clamp(this.x, w.left, w.right - 1), w.bottom - 1)
      ) {
        this.y = w.bottom + h;
        this.hit("ceil", -this.vy);
      }
    });
  }

  /** Bordes de la pantalla (salvo los que dan a otro monitor). Devuelve false si dejó de estar en el aire. */
  private collideScreen(): boolean {
    const hw = this.halfW;
    const h = this.height;
    this.edgeExit();
    if (this.x - hw < 0) {
      this.x = hw;
      this.hit("left", -this.vx);
    } else if (this.x + hw > this.W) {
      this.x = this.W - hw;
      this.hit("right", this.vx);
    }
    if (this.mode !== "air") return false;
    if (this.y - h < 0) {
      this.y = h;
      this.hit("ceil", -this.vy);
      if (this.mode !== "air") return false;
    }
    return true;
  }

  /** Se posa en el borde de ventana más alto que ha cruzado bajando, o en el suelo. */
  private landBelow(py: number) {
    let best: Platform | null = null;
    for (const p of this.plats) {
      if (py <= p.top + 0.5 && this.y >= p.top && this.x >= p.left && this.x <= p.right) {
        if (!best || p.top < best.top) best = p;
      }
    }
    if (best) {
      this.landOn({ kind: "win", id: best.id, winLeft: best.winLeft }, best.top);
      return;
    }
    if (this.y >= this.H) this.landOn({ kind: "floor" }, this.H);
  }

  /** Choque contra una superficie: espachurrarse, rebotar o (suelo) posarse. */
  private hit(side: Surface, impact: number) {
    const b = this.settings.bounciness;
    if (this.settings.splat && impact > SPLAT_SPEED * (side === "floor" ? 1.1 : 1)) {
      this.splat(side);
      return;
    }
    if (side === "left" || side === "right") {
      this.vx = -this.vx * b;
      this.kick(-Math.min(8, impact / 150), Math.min(5, impact / 250));
      if (impact > 500) this.dust(side);
    } else if (side === "ceil") {
      this.vy = Math.abs(this.vy) * b;
      this.kick(Math.min(6, impact / 200), -Math.min(8, impact / 150));
    }
  }

  private landOn(ground: Exclude<Ground, null>, top: number) {
    const impact = this.vy;
    this.y = top;
    const b = this.settings.bounciness;
    if (this.settings.splat && impact > SPLAT_SPEED * 1.1) {
      this.ground = ground;
      this.splat("floor");
      return;
    }
    // Aplastamiento proporcional al golpe: el muelle lo devuelve con rebote.
    this.kick(Math.min(9, impact / 140), -Math.min(9, impact / 140));
    const rebound = impact * b;
    if (rebound > 160) {
      this.vy = -rebound;
      this.vx *= 0.8;
      if (impact > 500) this.dust("floor");
      return;
    }
    this.vy = 0;
    this.ground = ground;
    if (impact > 300) this.dust("floor");
    this.setMode("land");
  }

  // -------------------------------------------------------------------------
  // Golpes: espachurrarse, marearse, aterrizar
  // -------------------------------------------------------------------------

  private splat(side: Surface) {
    this.splatSide = side;
    this.vx = 0;
    this.vy = 0;
    if (side === "left") this.facing = -1;
    if (side === "right") this.facing = 1;
    this.mood = nudge(this.mood, { anger: 0.22, happy: -0.12 });
    this.life.note("espachurrado");
    const away = side === "left" ? 1 : side === "right" ? -1 : this.facing;
    if (side !== "floor" && this.hat && this.settings.hats) this.hatDrop.knock(this.hat, this.x, this.y - this.height, away, this.facing);
    this.setMode("splat");
    this.dust(side);
  }

  private dust(side: Surface) {
    this.effects.push(...dustEffects(this, side, this.rand));
  }

  protected stepSplat(dt: number) {
    const side = this.splatSide;
    if (side === "floor") {
      if (!this.followGround()) return;
      if (this.modeT > 0.9) {
        this.setMode("dizzy");
        this.showIcon("sweat", 1.8);
      }
      return;
    }
    // Pegada a una pared o al techo: se despega y cae.
    if (side === "left" || side === "right") this.y = Math.min(this.H, this.y + 25 * dt);
    if (this.modeT > 0.85) {
      this.vx = side === "left" ? 90 : side === "right" ? -90 : 0;
      this.vy = 0;
      this.dizzyAfterLand = true;
      this.fall();
    }
  }

  protected stepDizzy() {
    if (!this.followGround()) return;
    if (this.modeT > 1.8) {
      this.setMode("idle");
      if (this.mood.anger > 0.35) this.play("angry");
    }
  }

  protected stepLand(dt: number) {
    if (!this.followGround()) return;
    this.slide(dt);
    if (this.modeT > 0.16) this.afterLanding();
  }

  private afterLanding() {
    if (this.dizzyAfterLand) {
      this.dizzyAfterLand = false;
      this.setMode("dizzy");
      this.showIcon("sweat", 1.8);
    } else if (this.waveAfterLand) {
      this.waveAfterLand = false;
      this.setMode("wave");
    } else {
      this.setMode("idle");
    }
  }

  // -------------------------------------------------------------------------
  // Arrastre, chincheta y modo ratón
  // -------------------------------------------------------------------------

  protected dragVelocity(): { vx: number; vy: number } {
    const s = this.drag?.samples ?? [];
    if (s.length < 2) return { vx: 0, vy: 0 };
    const a = s[0];
    const b = s[s.length - 1];
    const dt = Math.max(1 / 240, b.t - a.t);
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }

  protected swingFromDrag(dt: number) {
    const v = this.dragVelocity();
    const target = clamp(-v.vx / 500, -2.5, 2.5);
    this.swing += (target - this.swing) * (1 - Math.exp(-12 * dt));
    if (Math.abs(v.vx) > 40) this.facing = v.vx < 0 ? -1 : 1;
  }

  protected stepHang(dt: number) {
    const a = this.hangAnchor;
    if (!a) {
      this.fall();
      return;
    }
    this.swingV += (-this.swing * 14 - this.swingV * 1.2) * dt;
    this.swing += this.swingV * dt;
    // Tras un rato colgado, patalea para soltarse (si así está ajustado).
    if (this.settings.hang_struggle && this.modeT > 4 && Math.floor(this.modeT) % 4 === 0 && this.modeT % 1 < dt) {
      this.swingV += (this.rand() < 0.5 ? -1 : 1) * 3;
      this.showIcon("sweat", 1.2);
    }
    this.x = a.x + this.swing * this.S;
    this.y = a.y + 2 * this.S + this.height;
  }

  protected stepDrive(dt: number, cursor: Point | null) {
    if (!cursor) return;
    const tx = cursor.x + 5 * this.S;
    const ty = cursor.y + this.height + 3 * this.S;
    const k = 1 - Math.exp(-30 * dt);
    const dx = (tx - this.x) * k;
    this.x += dx;
    this.y += (ty - this.y) * k;
    if (Math.abs(dx) > 0.5) this.facing = dx < 0 ? -1 : 1;
    this.swing += (clamp(-dx / 3, -2, 2) - this.swing) * (1 - Math.exp(-10 * dt));
  }

  // -------------------------------------------------------------------------
  // Saltos
  // -------------------------------------------------------------------------

  /** Velocidad inicial para caer en (tx, ty), o null si es demasiado lejos. */
  planJump(tx: number, ty: number): { vx: number; vy: number } | null {
    const g = this.g;
    let vy0: number;
    let T: number;
    if (ty < this.y - 2) {
      const apex = ty - JUMP_APEX * this.S;
      vy0 = -Math.sqrt(2 * g * (this.y - apex));
      T = -vy0 / g + Math.sqrt((2 * (ty - apex)) / g);
    } else {
      vy0 = -Math.sqrt(2 * g * JUMP_APEX * this.S);
      T = (-vy0 + Math.sqrt(vy0 * vy0 + 2 * g * (ty - this.y))) / g;
    }
    const vx = (tx - this.x) / T;
    if (!Number.isFinite(vx) || Math.abs(vx) > 1100) return null;
    return { vx, vy: vy0 };
  }

  /** Se agacha para saltar a (tx, ty); false si el salto no es posible. */
  protected crouchFor(tx: number, ty: number): boolean {
    const j = this.planJump(tx, ty);
    if (!j) return false;
    this.pendingJump = j;
    this.facing = tx < this.x ? -1 : 1;
    this.setMode("crouch");
    return true;
  }

  /** Agachada: tras 0,2 s salta con la velocidad planificada. */
  protected stepCrouch() {
    if (!this.followGround()) return;
    if (this.modeT > 0.2 && this.pendingJump) {
      this.vx = this.pendingJump.vx;
      this.vy = this.pendingJump.vy;
      this.facing = this.vx < 0 ? -1 : 1;
      this.pendingJump = null;
      this.kick(-5, 7);
      this.fall();
    }
  }

  /**
   * En el suelo, camino de `target` hacia `dir`: si una isla de la barra corta
   * el paso, el salto a lo alto de ella. Despega con la carrerilla justa para
   * no chocar con su lateral (travel.ts, wallRunUp); null si no hay isla en
   * medio, no salta o no trepa ventanas.
   */
  protected islandHop(dir: 1 | -1, target: number): IslandHop | null {
    if (this.ground?.kind !== "floor" || !this.settings.jump || !this.hasIslands()) return null;
    const gap = this.floorGapAt(this.x);
    if (!gap) return null;
    const [lo, hi] = this.gapBounds(gap);
    const edge = dir > 0 ? gap[1] : gap[0];
    if (dir > 0 ? target <= hi || edge >= this.W : target >= lo || edge <= 0) return null;
    const island = this.wins.find((w) => w.isTaskbarIsland && w.left <= edge + 0.5 && w.right >= edge - 0.5);
    const p = island && this.plats
      .filter((q) => q.id === island.id)
      .sort((a, b) => Math.abs((dir > 0 ? a.left : a.right) - edge) - Math.abs((dir > 0 ? b.left : b.right) - edge))[0];
    if (!p) return null;
    const hw = this.halfW;
    const inset = Math.min(2 * hw, (p.right - p.left) / 2);
    const runUp = wallRunUp(this.y - p.top, JUMP_APEX * this.S, hw + inset) + 4;
    return {
      id: p.id,
      takeoffX: clamp(dir > 0 ? hi - runUp : lo + runUp, lo, hi),
      landX: dir > 0 ? p.left + inset : p.right - inset,
      top: p.top,
    };
  }

  protected tryJumpUp(): boolean {
    const hw = this.halfW;
    const maxH = 75 * this.S;
    const reachable = jumpablePlatforms(this.plats, this.wins, this.x, this.y, this.settings.collide_windows);
    const options = reachable.filter(
      (p) =>
        p.top < this.y - 3 * this.S &&
        p.top > this.y - maxH &&
        p.right - p.left > 2 * hw + 8 &&
        Math.abs(clamp(this.x, p.left + hw, p.right - hw) - this.x) < 480,
    );
    if (!options.length) return false;
    const p = options[Math.floor(this.rand() * options.length)];
    const lo = p.left + hw + 4;
    const hi = p.right - hw - 4;
    const tx = clamp(this.x + (this.rand() * 2 - 1) * 120, lo, Math.max(lo, hi));
    return this.crouchFor(tx, p.top);
  }

  protected tryHopDown(): boolean {
    const g = this.ground;
    if (g?.kind !== "win") return false;
    const p = this.plats.find((q) => q.id === g.id && this.x >= q.left && this.x <= q.right);
    if (!p) return false;
    const hw = this.halfW;
    const goRight = this.rand() < 0.5;
    let tx = goRight ? p.right + hw * 2 + this.rand() * 160 : p.left - hw * 2 - this.rand() * 160;
    tx = clamp(tx, hw, this.W - hw);
    if (tx >= p.left - hw && tx <= p.right + hw) return false;
    return this.crouchFor(tx, this.H);
  }
}
