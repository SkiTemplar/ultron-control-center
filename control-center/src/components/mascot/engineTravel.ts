// Mascota — capa de viajes del motor: Ctrl+Alt+clic = «ven aquí».
//
// Si el destino es el borde de una ventana o el suelo, va corriendo y
// saltando de ventana en ventana mientras pueda; si no (o está lejos), saca
// la hélice. También el cambio de monitor y los paseos a un punto.

import { nextHop, sameSurface, surfaceAt, surfacesOf, type Surface as Perch } from "./travel";
import { clamp } from "./activities/util";
import { EnginePhysics } from "./enginePhysics";
import { jumpablePlatforms } from "./sessionsInside";
import { FLY_SPEED, MAX_HOPS, RUN_MAX, RUN_SPEED, type Side } from "./engineTypes";

/** Destino del vuelo: (x, y) de los pies y la superficie donde posarse (null = chincheta). */
type FlyTarget = { x: number; y: number; perch: Perch | null };

export class EngineTravel extends EnginePhysics {
  /** Viaje en curso (Ctrl+Alt+clic): destino y superficie donde posarse. */
  protected goal: { x: number; y: number; surface: Perch | null } | null = null;
  private hops = 0;
  private flyTarget: FlyTarget | null = null;
  /** Llegó al destino de un viaje (la app lo consume con takeArrival). */
  private arrived = false;

  private surfaces(): Perch[] {
    const plats = jumpablePlatforms(this.plats, this.wins, this.x, this.y, this.settings.collide_windows);
    return surfacesOf(this.settings.climb_windows ? plats : [], this.W, this.H, this.hasIslands() ? this.gaps : undefined);
  }

  private currentSurface(): Perch | null {
    const g = this.ground;
    if (!g) return null;
    if (g.kind === "floor") {
      const gap = this.floorGapAt(this.x);
      return gap ? { id: "floor", left: gap[0], right: gap[1], top: this.H } : null;
    }
    const p = this.plats.find((q) => q.id === g.id && this.x >= q.left && this.x <= q.right);
    return p ? { id: p.id, left: p.left, right: p.right, top: p.top } : null;
  }

  private jumpLimits() {
    return { hw: this.halfW, maxRise: 70 * this.S, maxReach: 300 };
  }

  protected cancelTravel() {
    this.goal = null;
    this.flyTarget = null;
    this.hops = 0;
  }

  isTraveling(): boolean {
    return !!this.goal || !!this.flyTarget;
  }

  /** ¿Ha llegado a su destino desde la última vez que se preguntó? */
  takeArrival(): boolean {
    const a = this.arrived;
    this.arrived = false;
    return a;
  }

  /**
   * Ir al punto (x, y): si es el borde de una ventana o el suelo, saltando
   * de ventana en ventana mientras se pueda; si no, con la hélice, y allí se
   * queda colgado de una chincheta.
   */
  goTo(x: number, y: number) {
    if (this.mode === "drag" || this.mode === "drive") return;
    this.cancelTravel();
    const tx = clamp(x, this.halfW, Math.max(this.halfW, this.W - this.halfW));
    const surface = surfaceAt(this.surfaces(), tx, y, this.halfW);
    this.goal = { x: tx, y, surface };
    this.idleFor = 0;
    this.walkTarget = null;
    this.queued = null;
    this.showIcon("exclaim", 0.8);
    const far = Math.abs(tx - this.x) > RUN_MAX;
    if (!surface || far || !this.isGrounded() || !this.settings.jump) {
      this.flyToGoal();
      return;
    }
    // En el suelo: stepTravel se encarga (andar al borde y saltar).
    if (this.mode !== "walk") this.setMode("idle");
  }

  private flyToGoal() {
    const g = this.goal;
    if (!g) return;
    if (g.surface) {
      const s = g.surface;
      this.flyTo(clamp(g.x, s.left + this.halfW, Math.max(s.left + this.halfW, s.right - this.halfW)), s.top, s);
    } else {
      this.flyTo(g.x, g.y, null);
    }
  }

  /**
   * Vuelo con la hélice. `perch` = superficie donde posarse; sin ella, (x, y)
   * es la chincheta de la que se quedará colgado.
   */
  flyTo(x: number, y: number, perch: Perch | null) {
    this.ground = null;
    this.hangAnchor = null;
    this.walkTarget = null;
    this.pendingJump = null;
    const footY = perch ? perch.top : y + 2 * this.S + this.height;
    this.flyTarget = { x, y: footY, perch };
    if (this.mode !== "fly") {
      this.setMode("fly");
      this.vy = Math.min(this.vy, -160);
      this.kick(4, -4);
    }
  }

  /** Viaje por superficies: correr hasta el borde y saltar a la siguiente. */
  protected stepTravel(dt: number): boolean {
    const goal = this.goal;
    if (!goal || this.flyTarget) return false;
    if (!["idle", "walk", "sit", "sleep"].includes(this.mode)) return true;
    const cur = this.currentSurface();
    if (!goal.surface || !cur) {
      this.flyToGoal();
      return true;
    }
    const hw = this.halfW;
    let targetX: number;
    let hop: ReturnType<typeof nextHop> = null;
    if (sameSurface(cur, goal.surface)) {
      targetX = clamp(goal.x, cur.left + hw, Math.max(cur.left + hw, cur.right - hw));
    } else {
      hop = this.hops < MAX_HOPS ? nextHop(cur, goal.surface, this.surfaces(), this.jumpLimits()) : null;
      if (!hop) {
        this.flyToGoal();
        return true;
      }
      // A lo alto de una isla de la barra, con carrerilla para no chocar con su lateral.
      const run = cur.id === "floor" ? this.islandHop(hop.landX < this.x ? -1 : 1, hop.landX) : null;
      targetX = run && run.id === hop.to.id ? run.takeoffX : hop.takeoffX;
    }
    const d = targetX - this.x;
    const step = RUN_SPEED * this.S * dt;
    if (Math.abs(d) > step) {
      if (this.mode !== "walk") this.setMode("walk");
      this.facing = d < 0 ? -1 : 1;
      this.x += Math.sign(d) * step;
      return true;
    }
    this.x = targetX;
    if (!hop) {
      this.goal = null;
      this.hops = 0;
      this.arrived = true;
      this.setMode("idle");
      this.showIcon("heart", 1.2);
      return true;
    }
    if (this.crouchFor(hop.landX, hop.to.top)) this.hops++;
    else this.flyToGoal();
    return true;
  }

  protected stepFly(dt: number) {
    const f = this.flyTarget;
    if (!f) {
      this.fall();
      return;
    }
    const dx = f.x - this.x;
    const dy = f.y - this.y;
    const dist = Math.hypot(dx, dy);
    // Llegada suave: frena al acercarse.
    const speed = Math.min(FLY_SPEED, dist * 2.6 + 30);
    const k = 1 - Math.exp(-5 * dt);
    const want = dist > 0.5 ? { x: (dx / dist) * speed, y: (dy / dist) * speed } : { x: 0, y: 0 };
    this.vx += (want.x - this.vx) * k;
    this.vy += (want.y - this.vy) * k;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (Math.abs(this.vx) > 20) this.facing = this.vx < 0 ? -1 : 1;
    this.swing += (clamp(-this.vx / 300, -2, 2) - this.swing) * (1 - Math.exp(-8 * dt));
    // Solo sale por un borde si el vuelo va fuera; pasarse de frenada junto
    // al borde no lo muda al monitor de al lado.
    const leaving = f.x < this.halfW || f.x > this.W - this.halfW;
    if (!(leaving && this.edgeExit())) this.x = clamp(this.x, this.halfW, Math.max(this.halfW, this.W - this.halfW));
    this.y = clamp(this.y, this.height, Math.max(this.height, this.H));
    if (dist < 3 && Math.hypot(this.vx, this.vy) < 70) this.finishFlight(f);
  }

  private finishFlight(f: FlyTarget) {
    this.flyTarget = null;
    this.goal = null;
    this.hops = 0;
    this.vx = 0;
    this.vy = 0;
    this.x = f.x;
    this.arrived = true;
    if (f.perch) {
      const id = f.perch.id;
      this.y = f.perch.top;
      this.ground =
        id === "floor"
          ? { kind: "floor" }
          : { kind: "win", id, winLeft: this.plats.find((p) => p.id === id)?.winLeft ?? 0 };
      this.kick(-4, 5);
      this.setMode("land");
      return;
    }
    // En el aire: se queda colgado de una chincheta justo donde clicaste.
    this.hangAnchor = { x: f.x, y: f.y - 2 * this.S - this.height };
    this.swingV = 0;
    this.setMode("hang");
  }

  /** Ya en el monitor nuevo: entra por el lado contrario al que salió. */
  enterFrom(exitSide: Side, y: number) {
    const hw = this.halfW;
    this.x = exitSide === "right" ? hw + 1 : this.W - hw - 1;
    this.y = clamp(y, this.height, Math.max(this.height, this.H));
    this.exitRequest = null;
    if (this.isGrounded()) this.fall();
  }

  /** Paseo tranquilo por su superficie hasta x, sin icono (silencio de juego). */
  strollTo(x: number) {
    if (!this.isGrounded() || this.goal || this.mode === "drag" || this.mode === "drive") return;
    this.walkTarget = clamp(x, this.halfW, Math.max(this.halfW, this.W - this.halfW));
    this.setMode("walk");
  }
}
