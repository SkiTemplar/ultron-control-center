// Mascota — capa de trepada del motor: subir y bajar por los laterales de
// la ventana de Sessions (paredes de sessionsInside.ts).
//
// Entra por las mismas decisiones que subirse a una ventana: «subir»
// (jumpUp) puede acabar en trepar en vez de saltar si hay una pared a mano,
// y «bajar» (hopDown) en descolgarse por el lateral. Primero anda hasta la
// pared; luego se pega a ella (modo «climb») y sube o baja. Arriba pasa al
// borde superior de la ventana; abajo se posa en el suelo; si la pared se
// acaba, se tapa o desaparece, se suelta y cae. Tras cada trepada espera
// CLIMB_COOLDOWN_S antes de la siguiente: no entra en bucle.
//
// Unidades: px CSS; (x, y) = centro de los pies. Hereda de EngineTravel.

import { EngineTravel } from "./engineTravel";
import { WALK_SPEED, type Mode } from "./engineTypes";
import {
  wallBodyX,
  wallFacing,
  wallFits,
  wallToClimbDown,
  wallToClimbUp,
  wallTopX,
  type ClimbDims,
  type Footing,
  type Wall,
  type WallSide,
} from "./sessionsInside";

/** Velocidad de trepada, px de sprite por segundo. */
export const CLIMB_SPEED = 30;
/** Segundos entre el comienzo de una trepada y la siguiente. */
export const CLIMB_COOLDOWN_S = 45;
/** Parte de las veces que, pudiendo trepar o saltar, trepa. */
const CLIMB_SHARE = 0.5;
/** Impulso al soltarse, apartándose de la pared (px CSS/s). */
const LET_GO_VX = 70;
/** Lo más lejos que va andando hasta la pared (px CSS). */
const MAX_WALK = 480;

/** Trepada en curso o pedida: qué pared y hacia dónde (-1 = sube, 1 = baja). */
type ClimbRef = { id: number; side: WallSide; dir: -1 | 1 };

/** Modos en los que sigue en pie el plan de ir hasta la pared. */
const PLAN_MODES: readonly Mode[] = ["idle", "walk", "climb"];

export class EngineClimb extends EngineTravel {
  /** Pared a la que está pegado (modo «climb»). */
  protected climb: ClimbRef | null = null;
  /** Va andando hacia una pared para empezar a trepar. */
  private climbPlan: ClimbRef | null = null;
  private lastClimbAt = -CLIMB_COOLDOWN_S;

  /** Trepando o camino de la pared (tests y depuración). */
  climbing(): { dir: -1 | 1; planned: boolean } | null {
    const c = this.climb ?? this.climbPlan;
    return c ? { dir: c.dir, planned: !this.climb } : null;
  }

  protected setMode(m: Mode) {
    if (m !== "climb") this.climb = null;
    if (!PLAN_MODES.includes(m)) this.climbPlan = null;
    super.setMode(m);
  }

  private climbDims(): ClimbDims {
    return { halfW: this.halfW, height: this.height, areaWidth: this.W, maxWalk: MAX_WALK };
  }

  private footing(): Footing {
    const [left, right] = this.surfaceBounds();
    return { x: this.x, y: this.y, left, right };
  }

  private wallOf(c: ClimbRef): Wall | null {
    return this.walls.find((w) => w.id === c.id && w.side === c.side) ?? null;
  }

  private climbReady(): boolean {
    return this.settings.climb_windows && !this.goal && this.t - this.lastClimbAt >= CLIMB_COOLDOWN_S;
  }

  /** Pared por la que subir desde aquí, si toca (ajuste, viaje en curso, descanso). */
  climbableUp(): Wall | null {
    if (!this.climbReady() || !this.ground) return null;
    return wallToClimbUp(this.walls, this.footing(), this.climbDims());
  }

  /** Pared por la que bajar desde el borde de la ventana en la que está. */
  climbableDown(): Wall | null {
    const g = this.ground;
    if (!this.climbReady() || g?.kind !== "win") return null;
    return wallToClimbDown(this.walls, g.id, this.footing(), this.climbDims());
  }

  /** Decisión «subir»: trepar o saltar a una ventana, lo que se pueda. */
  protected tryClimbOrJumpUp(): boolean {
    const wall = this.climbableUp();
    if (wall && this.rand() < CLIMB_SHARE) return this.planClimb(wall, -1);
    return this.tryJumpUp() || (wall !== null && this.planClimb(wall, -1));
  }

  /** Decisión «bajar»: descolgarse por el lateral o saltar al vacío. */
  protected tryClimbOrHopDown(): boolean {
    const wall = this.climbableDown();
    if (wall && this.rand() < CLIMB_SHARE) return this.planClimb(wall, 1);
    return this.tryHopDown() || (wall !== null && this.planClimb(wall, 1));
  }

  /** Echa a andar hacia la pared `w` para trepar en la dirección `dir`. */
  planClimb(w: Wall, dir: -1 | 1): boolean {
    if (!this.isGrounded()) return false;
    this.walkTarget = null;
    this.climbPlan = { id: w.id, side: w.side, dir };
    this.setMode("walk");
    return true;
  }

  /** De camino a la pared (desde stepGround). true = el paso acaba aquí. */
  protected stepClimbApproach(dt: number): boolean {
    const plan = this.climbPlan;
    if (!plan) return false;
    const w = this.wallOf(plan);
    // Sessions puede moverse mientras va hacia ella: si la pared ya no cabe, se olvida.
    if (!w || this.goal || !PLAN_MODES.includes(this.mode) || !wallFits(w, this.halfW, this.W)) {
      this.climbPlan = null;
      return false;
    }
    const tx = plan.dir < 0 ? wallBodyX(w, this.halfW) : wallTopX(w, this.halfW);
    const d = tx - this.x;
    const step = WALK_SPEED * this.S * this.life.traits.speed * dt;
    if (Math.abs(d) > step) {
      if (this.mode !== "walk") this.setMode("walk");
      this.facing = d < 0 ? -1 : 1;
      this.x += Math.sign(d) * step;
      return true;
    }
    this.startClimb(w, plan.dir);
    return true;
  }

  /** Se pega a la pared (por fuera) y empieza a subir o bajar. */
  startClimb(w: Wall, dir: -1 | 1) {
    this.climbPlan = null;
    this.walkTarget = null;
    this.lastClimbAt = this.t;
    this.ground = null;
    this.vx = 0;
    this.x = wallBodyX(w, this.halfW);
    this.facing = wallFacing(w);
    this.setMode("climb");
    this.climb = { id: w.id, side: w.side, dir };
    this.vy = dir * CLIMB_SPEED * this.S;
    this.kick(-2, 3);
  }

  protected stepClimb(dt: number) {
    const c = this.climb;
    const w = c ? this.wallOf(c) : null;
    if (!c || !w || !wallFits(w, this.halfW, this.W)) return this.letGo();
    this.x = wallBodyX(w, this.halfW);
    this.vy = c.dir * CLIMB_SPEED * this.S;
    this.y += this.vy * dt;
    if (c.dir < 0) {
      if (this.y <= w.top) return this.topOut(w);
      // El tramo visible ya no le llega a las manos (otra ventana lo tapa).
      if (this.y - this.height / 2 > w.bottom + 1) this.letGo();
      return;
    }
    if (this.y >= this.H) return this.landFromClimb();
    if (this.y - this.height > w.bottom) this.letGo();
  }

  /** Llega arriba: pasa al borde superior de la ventana. */
  private topOut(w: Wall) {
    const x = wallTopX(w, this.halfW);
    const p = this.plats.find((q) => q.id === w.id && x >= q.left && x <= q.right);
    if (!p) return this.letGo();
    this.x = x;
    this.y = p.top;
    this.vy = 0;
    this.ground = { kind: "win", id: p.id, winLeft: p.winLeft };
    this.kick(-4, 5);
    this.setMode("land");
  }

  /** Baja hasta el suelo: se posa. */
  private landFromClimb() {
    this.y = this.H;
    this.vy = 0;
    this.ground = { kind: "floor" };
    this.kick(4, -4);
    this.setMode("land");
  }

  /** Se suelta de la pared y cae, apartándose un poco de ella. */
  private letGo() {
    const side = this.climb?.side;
    this.vx = side === "left" ? -LET_GO_VX : side === "right" ? LET_GO_VX : 0;
    this.vy = 0;
    this.fall();
  }
}
