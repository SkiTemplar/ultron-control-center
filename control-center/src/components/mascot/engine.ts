// Mascota — motor: física + comportamiento + pose a pintar.
//
// Sin DOM ni Tauri: recibe el mundo (tamaño del área de trabajo, ventanas)
// y la entrada de cada fotograma, y decide dónde está la mascota y qué pose
// tiene. Así se puede probar entero en vitest.
//
// Unidades: px CSS dentro de la ventana de la mascota; (x, y) = centro de
// los pies. El suelo (y = H) es el borde superior de la barra de tareas.

import { BASE_POSE, BODY_W, SPRITE_H, type Arm, type Eyes, type Pose } from "./sprite";
import { coveredAbove, platformUnder, visiblePlatforms, type Platform, type WinRect } from "./world";

export interface MascotSettings {
  enabled: boolean;
  scale: number;
  wander: boolean;
  climb_windows: boolean;
  collide_windows: boolean;
  jump: boolean;
  splat: boolean;
  gravity: number;
  bounciness: number;
  eyes_follow_cursor: boolean;
  sleep_after_min: number;
  drive_with_mcp: boolean;
  claude_model: string;
  codex_model: string;
}

export const DEFAULT_SETTINGS: MascotSettings = {
  enabled: true,
  scale: 4,
  wander: true,
  climb_windows: true,
  collide_windows: false,
  jump: true,
  splat: true,
  gravity: 1,
  bounciness: 0.45,
  eyes_follow_cursor: true,
  sleep_after_min: 3,
  drive_with_mcp: true,
  claude_model: "",
  codex_model: "",
};

export type Mode =
  | "idle"
  | "walk"
  | "sit"
  | "sleep"
  | "crouch"
  | "air"
  | "land"
  | "drag"
  | "hang"
  | "splat"
  | "dizzy"
  | "wave"
  | "drive";

export type ChatState = "none" | "listen" | "think" | "talk";
/** Lado del cuerpo que recibe el golpe. */
export type Surface = "floor" | "left" | "right" | "ceil";

export interface FrameInput {
  dt: number;
  /** Cursor en px CSS (null = desconocido). */
  cursor: { x: number; y: number } | null;
  /** Cursor encima de la mascota o de sus botones. */
  hovered: boolean;
  chat: ChatState;
}

export interface Effect {
  kind: "dust" | "ring";
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
}

export interface Frame {
  pose: Pose;
  facing: 1 | -1;
  x: number;
  y: number;
  /** Chincheta de la que cuelga (modo «hang»). */
  pin: { x: number; y: number } | null;
  zzz: boolean;
  stars: boolean;
}

type Ground = { kind: "floor" } | { kind: "win"; id: number; winLeft: number } | null;

const GRAVITY = 2400; // px/s² con gravedad 1
const WALK_SPEED = 14; // px de sprite por segundo
const SPLAT_SPEED = 1500; // px/s de impacto para quedarse espachurrada
const MAX_SPEED = 4200;
const AIR_STEP = 1 / 120;

export class MascotEngine {
  settings: MascotSettings;
  W: number;
  H: number;
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  facing: 1 | -1 = -1;
  mode: Mode = "wave";
  modeT = 0;
  t = 0;
  ground: Ground = { kind: "floor" };
  wins: WinRect[] = [];
  plats: Platform[] = [];
  effects: Effect[] = [];

  idleFor = 0;
  private nextThink = 3;
  private walkTarget: number | null = null;
  private pendingJump: { vx: number; vy: number } | null = null;
  private splatSide: Surface = "floor";
  private dizzyAfterLand = false;
  private waveAfterLand = false;
  private happyUntil = 0;
  private blinkAt = 2;
  private lookX = 0;
  private lookY = 0;
  private swing = 0;
  private swingV = 0;
  private hangAnchor: { x: number; y: number } | null = null;
  private drag: { offX: number; offY: number; samples: { x: number; y: number; t: number }[] } | null =
    null;
  private driveAct: { kind: string; t: number } | null = null;
  private lastChat: ChatState = "none";
  private rand: () => number;

  constructor(W: number, H: number, settings: MascotSettings, rand: () => number = Math.random) {
    this.W = W;
    this.H = H;
    this.settings = settings;
    this.rand = rand;
    this.x = Math.round(W * 0.82);
    this.y = H;
  }

  // -------------------------------------------------------------------------
  // Medidas
  // -------------------------------------------------------------------------

  get S(): number {
    return this.settings.scale;
  }
  get halfW(): number {
    return (BODY_W / 2) * this.S;
  }
  get height(): number {
    return SPRITE_H * this.S;
  }
  get g(): number {
    return GRAVITY * this.settings.gravity;
  }

  /** Caja de la mascota (px CSS) con un margen para el hover. */
  bounds(pad = 0): { x: number; y: number; w: number; h: number } {
    const hw = this.halfW + 2 * this.S;
    return {
      x: this.x - hw - pad,
      y: this.y - this.height - 2 * this.S - pad,
      w: 2 * (hw + pad),
      h: this.height + 2 * this.S + 2 * pad,
    };
  }

  isGrounded(): boolean {
    return ["idle", "walk", "sit", "sleep", "crouch", "land", "dizzy", "wave"].includes(this.mode);
  }

  // -------------------------------------------------------------------------
  // Mundo
  // -------------------------------------------------------------------------

  setArea(W: number, H: number) {
    if (W === this.W && H === this.H) return;
    this.W = W;
    this.H = H;
    this.x = Math.min(Math.max(this.x, this.halfW), W - this.halfW);
    if (this.ground?.kind === "floor") this.y = H;
    if (this.y > H) this.y = H;
  }

  setWindows(wins: WinRect[]) {
    this.wins = wins;
    this.plats = this.settings.climb_windows ? visiblePlatforms(wins, this.W) : [];
  }

  setSettings(s: MascotSettings) {
    this.settings = s;
    this.plats = s.climb_windows ? visiblePlatforms(this.wins, this.W) : [];
    if (!s.climb_windows && this.ground?.kind === "win") this.fall();
  }

  private setMode(m: Mode) {
    this.mode = m;
    this.modeT = 0;
  }

  private fall() {
    this.ground = null;
    this.setMode("air");
  }

  // -------------------------------------------------------------------------
  // Interacción
  // -------------------------------------------------------------------------

  startDrag(px: number, py: number, now: number) {
    this.drag = { offX: this.x - px, offY: this.y - py, samples: [{ x: px, y: py, t: now }] };
    this.ground = null;
    this.hangAnchor = null;
    this.idleFor = 0;
    this.setMode("drag");
  }

  dragTo(px: number, py: number, now: number) {
    if (!this.drag) return;
    const s = this.drag.samples;
    s.push({ x: px, y: py, t: now });
    while (s.length > 2 && now - s[0].t > 0.1) s.shift();
    this.x = px + this.drag.offX;
    this.y = py + this.drag.offY;
    this.clampToScreen();
  }

  private dragVelocity(): { vx: number; vy: number } {
    const s = this.drag?.samples ?? [];
    if (s.length < 2) return { vx: 0, vy: 0 };
    const a = s[0];
    const b = s[s.length - 1];
    const dt = Math.max(1 / 240, b.t - a.t);
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }

  /** Soltar. Con Ctrl, se queda colgada de una chincheta donde la soltaste. */
  endDrag(ctrl: boolean) {
    if (!this.drag) return;
    const v = this.dragVelocity();
    const anchor = { x: this.x - this.drag.offX, y: this.y - this.drag.offY };
    this.drag = null;
    if (ctrl) {
      this.hangAnchor = anchor;
      this.swingV = Math.max(-6, Math.min(6, v.vx / 300));
      this.setMode("hang");
      return;
    }
    this.vx = clamp(v.vx, -MAX_SPEED, MAX_SPEED);
    this.vy = clamp(v.vy, -MAX_SPEED, MAX_SPEED);
    this.fall();
  }

  /** Clic sin arrastrar: saltito contento. */
  poke() {
    this.idleFor = 0;
    this.happyUntil = this.t + 0.9;
    if (this.mode === "hang") {
      // Clic estando colgada: se suelta de la chincheta.
      this.hangAnchor = null;
      this.vx = 0;
      this.vy = 0;
      this.fall();
      return;
    }
    if (this.isGrounded()) {
      this.vy = -Math.sqrt(2 * this.g * 10 * this.S);
      this.vx = 0;
      this.ground = null;
      this.setMode("air");
    }
  }

  summon() {
    this.x = this.W / 2;
    this.y = this.height + 8;
    this.vx = 0;
    this.vy = 0;
    this.hangAnchor = null;
    this.drag = null;
    this.dizzyAfterLand = false;
    this.waveAfterLand = true;
    this.fall();
  }

  driveStart() {
    this.drag = null;
    this.hangAnchor = null;
    this.ground = null;
    this.driveAct = null;
    this.setMode("drive");
  }

  driveAction(kind: string, at: { x: number; y: number } | null) {
    if (this.mode !== "drive") this.driveStart();
    this.driveAct = { kind, t: this.t };
    if (at && kind === "click") {
      this.effects.push({ kind: "ring", x: at.x, y: at.y, vx: 0, vy: 0, age: 0, life: 0.4 });
    }
  }

  driveEnd() {
    if (this.mode !== "drive") return;
    this.vx = 0;
    this.vy = 0;
    this.fall();
  }

  // -------------------------------------------------------------------------
  // Paso
  // -------------------------------------------------------------------------

  update(input: FrameInput) {
    const dt = Math.min(Math.max(input.dt, 0), 1 / 20);
    this.t += dt;
    this.modeT += dt;

    const engaged = input.hovered || input.chat !== "none" || this.mode === "drag";
    this.idleFor = engaged ? 0 : this.idleFor + dt;
    if (input.chat !== "none" && this.lastChat === "none") this.idleFor = 0;
    this.lastChat = input.chat;

    this.updateEffects(dt);
    this.updateEyes(input);

    switch (this.mode) {
      case "drag":
        this.swingFromDrag(dt);
        break;
      case "hang":
        this.stepHang(dt);
        break;
      case "drive":
        this.stepDrive(dt, input);
        break;
      case "air":
        for (let left = dt; left > 1e-6 && this.mode === "air"; left -= AIR_STEP) {
          this.stepAir(Math.min(AIR_STEP, left));
        }
        break;
      case "splat":
        this.stepSplat(dt);
        break;
      case "crouch":
        if (!this.followGround()) break;
        if (this.modeT > 0.2 && this.pendingJump) {
          this.vx = this.pendingJump.vx;
          this.vy = this.pendingJump.vy;
          this.facing = this.vx < 0 ? -1 : 1;
          this.pendingJump = null;
          this.fall();
        }
        break;
      case "land":
        if (!this.followGround()) break;
        this.slide(dt);
        if (this.modeT > 0.16) {
          if (this.dizzyAfterLand) {
            this.dizzyAfterLand = false;
            this.setMode("dizzy");
          } else if (this.waveAfterLand) {
            this.waveAfterLand = false;
            this.setMode("wave");
          } else {
            this.setMode("idle");
          }
        }
        break;
      case "dizzy":
        if (!this.followGround()) break;
        if (this.modeT > 1.8) this.setMode("idle");
        break;
      case "wave":
        if (!this.followGround()) break;
        if (this.modeT > 1.3) this.setMode("idle");
        break;
      default:
        this.stepGround(dt, input);
    }
  }

  private clampToScreen() {
    const hw = this.halfW;
    this.x = clamp(this.x, hw, Math.max(hw, this.W - hw));
    this.y = clamp(this.y, this.height, Math.max(this.height, this.H));
  }

  private updateEffects(dt: number) {
    for (const e of this.effects) {
      e.age += dt;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.vy += 300 * dt;
    }
    this.effects = this.effects.filter((e) => e.age < e.life);
  }

  private updateEyes(input: FrameInput) {
    let tx = 0;
    let ty = 0;
    if (input.chat !== "none") {
      ty = -1;
    } else if (this.settings.eyes_follow_cursor && input.cursor) {
      const hx = this.x;
      const hy = this.y - this.height * 0.7;
      const dx = input.cursor.x - hx;
      const dy = input.cursor.y - hy;
      const d = Math.hypot(dx, dy);
      if (d > 4 * this.S) {
        // La mirada se dibuja en el espacio del sprite (reflejado si mira a
        // la izquierda), así que la x se expresa respecto a `facing`.
        tx = (dx / d) * 1.4 * this.facing;
        ty = (dy / d) * 1.4;
      }
    } else if (this.mode === "walk") {
      tx = 1;
    }
    const k = 1 - Math.exp(-10 * input.dt);
    this.lookX += (tx - this.lookX) * k;
    this.lookY += (ty - this.lookY) * k;
  }

  /**
   * Mantiene los pies sobre su suelo. Si la ventana se movió, la mascota va
   * montada; si desapareció o ya no hay borde bajo los pies, se cae.
   * Devuelve false si empezó a caer.
   */
  private followGround(): boolean {
    const g = this.ground;
    if (!g || g.kind === "floor") {
      this.y = this.H;
      return true;
    }
    const same = this.plats.filter((p) => p.id === g.id);
    const dx = same.length ? same[0].winLeft - g.winLeft : 0;
    const x = this.x + dx;
    const p = same.find((q) => x >= q.left && x <= q.right);
    if (!p) {
      this.x = x;
      this.fall();
      return false;
    }
    this.x = x;
    this.y = p.top;
    g.winLeft = p.winLeft;
    return true;
  }

  private surfaceBounds(): [number, number] {
    const hw = this.halfW;
    const g = this.ground;
    if (g?.kind === "win") {
      const p = this.plats.find((q) => q.id === g.id && this.x >= q.left && this.x <= q.right);
      if (p) return [Math.max(hw, p.left + 2), Math.min(this.W - hw, p.right - 2)];
    }
    return [hw, this.W - hw];
  }

  private slide(dt: number) {
    if (!this.vx) return;
    const dec = 2600 * dt;
    this.vx = Math.abs(this.vx) <= dec ? 0 : this.vx - Math.sign(this.vx) * dec;
    this.x += this.vx * dt;
    const [lo, hi] = this.surfaceBounds();
    if (this.ground?.kind === "floor") {
      if (this.x < lo || this.x > hi) this.vx = 0;
      this.x = clamp(this.x, lo, hi);
    } else if (this.x < lo - this.halfW || this.x > hi + this.halfW) {
      this.fall();
    }
  }

  private stepGround(dt: number, input: FrameInput) {
    if (!this.followGround()) return;
    this.slide(dt);
    if (this.mode === "air") return;

    if (input.hovered || input.chat !== "none") {
      if (this.mode === "sleep") this.setMode("wave");
      else if (this.mode === "walk") this.setMode("idle");
      if (input.cursor && input.hovered) {
        const dx = input.cursor.x - this.x;
        if (Math.abs(dx) > 2 * this.S) this.facing = dx < 0 ? -1 : 1;
      }
      this.nextThink = this.t + 1.5;
      return;
    }

    const sleepAfter = this.settings.sleep_after_min * 60;
    if (sleepAfter > 0 && this.idleFor > sleepAfter && this.mode !== "sleep") {
      this.walkTarget = null;
      this.setMode("sleep");
      return;
    }
    if (this.mode === "sleep") return;

    if (this.mode === "walk" && this.walkTarget !== null) {
      const [lo, hi] = this.surfaceBounds();
      const target = clamp(this.walkTarget, lo, hi);
      const step = WALK_SPEED * this.S * dt;
      const d = target - this.x;
      this.facing = d < 0 ? -1 : 1;
      if (Math.abs(d) <= step) {
        this.x = target;
        this.walkTarget = null;
        this.setMode("idle");
      } else {
        this.x += Math.sign(d) * step;
      }
      return;
    }

    if (this.settings.wander && this.t >= this.nextThink) this.decide();
  }

  private decide() {
    this.nextThink = this.t + 2 + this.rand() * 4;
    const r = this.rand();
    if (this.settings.jump && r < 0.22 && this.tryJumpUp()) return;
    if (this.settings.jump && r < 0.3 && this.ground?.kind === "win" && this.tryHopDown()) return;
    if (r < 0.75) {
      const [lo, hi] = this.surfaceBounds();
      const span = Math.min(hi - lo, 420);
      const target = clamp(this.x + (this.rand() * 2 - 1) * span, lo, hi);
      if (Math.abs(target - this.x) > 4 * this.S) {
        this.walkTarget = target;
        this.setMode("walk");
        return;
      }
    }
    if (r < 0.88) {
      this.setMode("sit");
      return;
    }
    this.setMode("idle");
  }

  /** Velocidad inicial para caer en (tx, ty), o null si es demasiado lejos. */
  planJump(tx: number, ty: number): { vx: number; vy: number } | null {
    const g = this.g;
    let vy0: number;
    let T: number;
    if (ty < this.y - 2) {
      const apex = ty - 8 * this.S;
      vy0 = -Math.sqrt(2 * g * (this.y - apex));
      T = -vy0 / g + Math.sqrt((2 * (ty - apex)) / g);
    } else {
      vy0 = -Math.sqrt(2 * g * 8 * this.S);
      T = (-vy0 + Math.sqrt(vy0 * vy0 + 2 * g * (ty - this.y))) / g;
    }
    const vx = (tx - this.x) / T;
    if (!Number.isFinite(vx) || Math.abs(vx) > 1100) return null;
    return { vx, vy: vy0 };
  }

  private tryJumpUp(): boolean {
    const hw = this.halfW;
    const maxH = 75 * this.S;
    const options = this.plats.filter(
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

  private tryHopDown(): boolean {
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

  private crouchFor(tx: number, ty: number): boolean {
    const j = this.planJump(tx, ty);
    if (!j) return false;
    this.pendingJump = j;
    this.facing = tx < this.x ? -1 : 1;
    this.setMode("crouch");
    return true;
  }

  private swingFromDrag(dt: number) {
    const v = this.dragVelocity();
    const target = clamp(-v.vx / 500, -2.5, 2.5);
    this.swing += (target - this.swing) * (1 - Math.exp(-12 * dt));
    if (Math.abs(v.vx) > 40) this.facing = v.vx < 0 ? -1 : 1;
  }

  private stepHang(dt: number) {
    const a = this.hangAnchor;
    if (!a) {
      this.fall();
      return;
    }
    this.swingV += (-this.swing * 14 - this.swingV * 1.2) * dt;
    this.swing += this.swingV * dt;
    this.x = a.x + this.swing * this.S;
    this.y = a.y + 2 * this.S + this.height;
  }

  private stepDrive(dt: number, input: FrameInput) {
    if (!input.cursor) return;
    const tx = input.cursor.x + 5 * this.S;
    const ty = input.cursor.y + this.height + 3 * this.S;
    const k = 1 - Math.exp(-30 * dt);
    const dx = (tx - this.x) * k;
    this.x += dx;
    this.y += (ty - this.y) * k;
    if (Math.abs(dx) > 0.5) this.facing = dx < 0 ? -1 : 1;
    this.swing += (clamp(-dx / 3, -2, 2) - this.swing) * (1 - Math.exp(-10 * dt));
  }

  private stepSplat(dt: number) {
    const side = this.splatSide;
    if (side === "floor") {
      if (!this.followGround()) return;
      if (this.modeT > 0.9) this.setMode("dizzy");
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

  private splat(side: Surface) {
    this.splatSide = side;
    this.vx = 0;
    this.vy = 0;
    if (side === "left") this.facing = -1;
    if (side === "right") this.facing = 1;
    this.setMode("splat");
    this.dust(side);
  }

  private dust(side: Surface) {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / (n - 1) - 0.5) * Math.PI * 0.9;
      const sp = 60 + this.rand() * 90;
      let x = this.x;
      let y = this.y;
      let vx = Math.sin(a) * sp;
      let vy = -Math.abs(Math.cos(a)) * sp * 0.6;
      if (side === "left" || side === "right") {
        x = side === "left" ? this.x - this.halfW : this.x + this.halfW;
        y = this.y - this.height / 2;
        vx = (side === "left" ? 1 : -1) * Math.abs(Math.cos(a)) * sp * 0.6;
        vy = Math.sin(a) * sp;
      } else if (side === "ceil") {
        y = this.y - this.height;
        vy = Math.abs(vy);
      }
      this.effects.push({ kind: "dust", x, y, vx, vy, age: 0, life: 0.35 + this.rand() * 0.2 });
    }
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
      if (impact > 500) this.dust(side);
    } else if (side === "ceil") {
      this.vy = Math.abs(this.vy) * b;
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

  private stepAir(dt: number) {
    const px = this.x;
    const py = this.y;
    const hw = this.halfW;
    const h = this.height;
    this.vy = Math.min(this.vy + this.g * dt, MAX_SPEED);
    this.vx *= 1 - 0.12 * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Ventanas sólidas (opcional): laterales y parte de abajo.
    if (this.settings.collide_windows) {
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
        } else if (
          vOverlap &&
          px - hw >= w.right &&
          L < w.right &&
          !coveredAbove(this.wins, i, w.right - 1, midY)
        ) {
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
      if (this.mode !== "air") return;
    }

    // Bordes de la pantalla.
    if (this.x - hw < 0) {
      this.x = hw;
      this.hit("left", -this.vx);
    } else if (this.x + hw > this.W) {
      this.x = this.W - hw;
      this.hit("right", this.vx);
    }
    if (this.mode !== "air") return;
    if (this.y - h < 0) {
      this.y = h;
      this.hit("ceil", -this.vy);
      if (this.mode !== "air") return;
    }

    // Aterrizar: bordes superiores de ventanas (de un solo sentido) o suelo.
    if (this.vy > 0) {
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
  }

  // -------------------------------------------------------------------------
  // Pose
  // -------------------------------------------------------------------------

  frame(chat: ChatState): Frame {
    const t = this.t;
    const p: Pose = { ...BASE_POSE, lookX: this.lookX, lookY: this.lookY };
    let pin: Frame["pin"] = null;
    let zzz = false;
    let stars = false;

    const blinking = (() => {
      if (t > this.blinkAt + 0.13) this.blinkAt = t + 2.5 + this.rand() * 3.5;
      return t >= this.blinkAt && t < this.blinkAt + 0.13;
    })();
    let eyes: Eyes = blinking ? "blink" : "open";
    if (t < this.happyUntil) eyes = "happy";
    const alt = (hz: number) => Math.floor(t * hz) % 2 === 0;

    switch (this.mode) {
      case "walk":
        p.legs = alt(6) ? "walk1" : "walk2";
        p.dy = alt(6) ? 0 : -0.6;
        break;
      case "sit":
        p.legs = "tuck";
        p.armL = p.armR = "down";
        break;
      case "sleep":
        p.legs = "tuck";
        p.armL = p.armR = "down";
        eyes = "closed";
        p.sy = alt(0.6) ? 1 : 0.9;
        zzz = true;
        break;
      case "crouch":
        p.sx = 1.15;
        p.sy = 0.75;
        p.legs = "tuck";
        p.armL = p.armR = "down";
        break;
      case "air":
        if (this.vy < -150) {
          p.sx = 0.9;
          p.sy = 1.1;
          p.armL = p.armR = "up";
          p.legs = "dangle";
        } else {
          const f = alt(8);
          p.armL = f ? "flail1" : "flail2";
          p.armR = f ? "flail2" : "flail1";
          p.legs = "spread";
          if (this.vy > 600) eyes = "wide";
        }
        break;
      case "land":
        p.sx = 1.2;
        p.sy = 0.7;
        p.legs = "tuck";
        break;
      case "drag": {
        p.armL = p.armR = alt(3) ? "flail1" : "out";
        p.legs = "dangle";
        p.legSwing = this.swing;
        const v = this.dragVelocity();
        eyes = Math.hypot(v.vx, v.vy) > 900 ? "wide" : t < this.happyUntil ? "happy" : eyes;
        break;
      }
      case "hang":
        p.armL = p.armR = "up";
        p.legs = "dangle";
        p.legSwing = -this.swing * 0.8;
        if (this.hangAnchor) pin = { ...this.hangAnchor };
        break;
      case "splat":
        // Contra una pared el cuerpo mide 6 px y las X se pisarían: > <.
        eyes = this.splatSide === "left" || this.splatSide === "right" ? "squint" : "dizzy";
        p.legs = "none";
        p.armL = p.armR = "flat";
        if (this.splatSide === "floor") {
          p.sx = 1.5;
          p.sy = 0.35;
        } else if (this.splatSide === "ceil") {
          p.sx = 1.3;
          p.sy = 0.5;
          p.dy = -(SPRITE_H - 4);
        } else {
          p.sx = 0.45;
          p.sy = 1.25;
          // Pegada a la pared: el cuerpo estrecho se desplaza hasta el borde.
          // En el espacio del sprite, «izquierda» depende de hacia dónde mira.
          const shift = (BODY_W - Math.round(BODY_W * 0.45)) / 2;
          const worldSide = this.splatSide === "left" ? -1 : 1;
          p.dx = shift * worldSide * this.facing;
        }
        break;
      case "dizzy":
        eyes = "dizzy";
        p.dx = Math.sin(t * 9) * 0.8;
        stars = true;
        break;
      case "wave": {
        eyes = "happy";
        const w = alt(5) ? "wave1" : "wave2";
        p.armR = w as Arm;
        break;
      }
      case "drive": {
        p.armR = "up";
        p.legs = alt(10) ? "run1" : "run2";
        p.legSwing = this.swing;
        const a = this.driveAct;
        const since = a ? t - a.t : 99;
        if (a && since < 0.25 && (a.kind === "click" || a.kind === "grab" || a.kind === "drop")) {
          p.armR = "down";
          p.sy = 0.9;
          eyes = "squint";
        } else if (a && since < 0.9 && (a.kind === "type" || a.kind === "key")) {
          p.armL = alt(12) ? "type1" : "type2";
          p.armR = alt(12) ? "type2" : "type1";
          eyes = "squint";
        }
        break;
      }
    }

    // Conversación (solo en el suelo o colgada: en el aire manda la física).
    if (this.isGrounded() && this.mode !== "dizzy" && this.mode !== "wave") {
      if (chat === "listen") {
        p.armL = p.armR = "down";
      } else if (chat === "think") {
        p.armR = "up";
        p.armL = "down";
        p.lookX = -1;
        p.lookY = -1;
        p.dy = alt(2) ? 0 : -0.6;
      } else if (chat === "talk") {
        const f = alt(3);
        p.armL = f ? "out" : "down";
        p.armR = f ? "down" : "out";
      }
    }

    if (this.mode === "sleep") eyes = "closed";
    p.eyes = eyes;
    return { pose: p, facing: this.facing, x: this.x, y: this.y, pin, zzz, stars };
  }

  /** Plataforma sobre la que está (para tests y depuración). */
  standingOn(): Platform | null {
    if (this.ground?.kind !== "win") return null;
    return platformUnder(this.plats, this.x, this.y, 1);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
