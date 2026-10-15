// Mascota — motor: física + comportamiento + ánimo + pose a pintar.
//
// Sin DOM ni Tauri: recibe el mundo (tamaño del área de trabajo, ventanas)
// y la entrada de cada fotograma, y decide dónde está la mascota, qué
// siente y qué pose tiene. Así se puede probar entero en vitest.
//
// Unidades: px CSS dentro de la ventana de la mascota; (x, y) = centro de
// los pies. El suelo (y = H) es el borde superior de la barra de tareas.
//
// Fluidez: el aplastamiento/estiramiento es un MUELLE (rebota y se asienta
// en vez de saltar de pose a pose), los botes y la respiración se pintan en
// píxeles de dispositivo, el color cambia con un fundido y casi todo
// (paseo, mirada, balanceo) es continuo.

import { BASE_POSE, BODY_W, SPRITE_H, type Arm, type Brows, type Eyes, type Glyph, type Pose } from "./sprite";
import { coveredAbove, platformUnder, visiblePlatforms, type Platform, type WinRect } from "./world";
import {
  AGENT_COLORS,
  BASE_MOOD,
  moodName,
  moodSpeed,
  nudge,
  rgbToCss,
  tickMood,
  type AgentId,
  type Mood,
  type MoodName,
  type RGB,
} from "./mood";

export type { AgentId } from "./mood";

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
  | "emote"
  | "drive";

/** Animaciones con guion (gestos, reacciones). */
export type Emote =
  | "lookAround"
  | "stretch"
  | "yawn"
  | "hop"
  | "dance"
  | "tapFoot"
  | "sigh"
  | "wiggle"
  | "peek"
  | "jealous"
  | "joy"
  | "poof"
  | "angry"
  | "love"
  | "surprised"
  | "sneeze"
  | "twirl";

export const EMOTE_DURATION: Record<Emote, number> = {
  lookAround: 2.4,
  stretch: 1.8,
  yawn: 2.0,
  hop: 1.0,
  dance: 3.0,
  tapFoot: 2.0,
  sigh: 2.2,
  wiggle: 1.4,
  peek: 1.6,
  jealous: 2.6,
  joy: 1.6,
  poof: 0.7,
  angry: 1.6,
  love: 1.8,
  surprised: 0.9,
  sneeze: 1.7,
  twirl: 1.0,
};

/** Instante del «disfraz» dentro de la reacción de celos. */
export const JEALOUS_COLOR_AT = 2.1;

export type ChatState = "none" | "listen" | "think" | "talk";
/** Lado del cuerpo que recibe el golpe. */
export type Surface = "floor" | "left" | "right" | "ceil";

export interface FrameInput {
  dt: number;
  /** Cursor en px CSS (null = desconocido). */
  cursor: { x: number; y: number } | null;
  /** Cursor encima de la mascota o de sus botones/bocadillos. */
  hovered: boolean;
  /** Cursor encima del cuerpo de la mascota (para las caricias). */
  petHover?: boolean;
  chat: ChatState;
}

export type EffectKind = "dust" | "ring" | "spark" | "heart" | "note" | "tear";

export interface Effect {
  kind: EffectKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  color?: string;
}

export interface Frame {
  pose: Pose;
  facing: 1 | -1;
  x: number;
  y: number;
  /** Color del cuerpo (CSS). */
  color: string;
  /** Chincheta de la que cuelga (modo «hang»). */
  pin: { x: number; y: number } | null;
  zzz: boolean;
  stars: boolean;
  /** Icono de emoción encima de la cabeza. */
  icon: { glyph: Glyph; age: number; life: number } | null;
}

type Ground = { kind: "floor" } | { kind: "win"; id: number; winLeft: number } | null;

const GRAVITY = 2400; // px/s² con gravedad 1
const WALK_SPEED = 14; // px de sprite por segundo
const SPLAT_SPEED = 1500; // px/s de impacto para quedarse espachurrada
const MAX_SPEED = 4200;
const AIR_STEP = 1 / 120;
const SPRING_K = 340;
const SPRING_C = 15;

const PARTICLE_GRAVITY: Record<EffectKind, number> = {
  dust: 300,
  ring: 0,
  spark: 140,
  heart: -30,
  note: -15,
  tear: 900,
};

const GROUNDED: Mode[] = ["idle", "walk", "sit", "sleep", "crouch", "land", "dizzy", "wave", "emote"];

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

  mood: Mood = { ...BASE_MOOD };
  emote: Emote | null = null;
  /** Agente de la conversación abierta (null = ninguna). */
  chatAgent: AgentId | null = null;
  color: RGB = [...AGENT_COLORS.claude];
  colorTarget: RGB = [...AGENT_COLORS.claude];

  idleFor = 0;
  private nextThink = 3;
  private walkTarget: number | null = null;
  private pendingJump: { vx: number; vy: number } | null = null;
  private pendingColor: RGB | null = null;
  private queued: Emote | null = null;
  private splatSide: Surface = "floor";
  private dizzyAfterLand = false;
  private waveAfterLand = false;
  private happyUntil = 0;
  private blinkAt = 2;
  private doubleBlink = false;
  private lookX = 0;
  private lookY = 0;
  private swing = 0;
  private swingV = 0;
  private hangAnchor: { x: number; y: number } | null = null;
  private drag: { offX: number; offY: number; samples: { x: number; y: number; t: number }[] } | null =
    null;
  private driveAct: { kind: string; t: number } | null = null;
  private lastChat: ChatState = "none";
  private icon: { glyph: Glyph; t0: number; life: number } | null = null;
  private wasHovered = false;
  private lastHoverReact = -99;
  private rub = 0;
  private lastLoveAt = -99;
  private lastCursor: { x: number; y: number } | null = null;
  private lastPetHover = false;
  private pokes: number[] = [];
  private sleptTired = false;
  private emoteMarks = new Set<string>();
  private sq = { x: 1, y: 1, vx: 0, vy: 0 };
  private frameT = 0;
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
  get moodName(): MoodName {
    return moodName(this.mood);
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
    return GROUNDED.includes(this.mode);
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
    if (m !== "emote") this.emote = null;
  }

  private fall() {
    this.ground = null;
    this.setMode("air");
  }

  /** Lanza una animación con guion. En el aire, la deja en cola. */
  play(e: Emote) {
    if (!this.isGrounded() || (this.mode === "sleep" && e !== "stretch")) {
      this.queued = e;
      return;
    }
    this.walkTarget = null;
    this.emoteMarks.clear();
    this.setMode("emote");
    this.emote = e;
    this.nextThink = this.t + EMOTE_DURATION[e] + 1.5;
  }

  private showIcon(glyph: Glyph, life = 1.6) {
    this.icon = { glyph, t0: this.t, life };
  }

  /** Impulso al muelle de aplastamiento (+x = más ancha, +y = más alta). */
  private kick(dx: number, dy: number) {
    this.sq.vx += dx;
    this.sq.vy += dy;
  }

  private burst(kind: EffectKind, n: number, color?: string, spread = 1) {
    const cx = this.x;
    const cy = this.y - this.height * 0.6;
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2;
      const sp = (60 + this.rand() * 140) * spread;
      this.effects.push({
        kind,
        x: cx + Math.cos(a) * this.halfW * 0.6,
        y: cy + Math.sin(a) * this.height * 0.3,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        age: 0,
        life: 0.5 + this.rand() * 0.5,
        color,
      });
    }
  }

  private floatUp(kind: "heart" | "note", n = 1) {
    for (let i = 0; i < n; i++) {
      this.effects.push({
        kind,
        x: this.x + (this.rand() * 2 - 1) * this.halfW,
        y: this.y - this.height - this.S * 2,
        vx: (this.rand() * 2 - 1) * 20,
        vy: -40 - this.rand() * 30,
        age: 0,
        life: 1.2 + this.rand() * 0.5,
      });
    }
  }

  private tear() {
    const side = this.rand() < 0.5 ? -1 : 1;
    this.effects.push({
      kind: "tear",
      x: this.x + side * 3 * this.S,
      y: this.y - this.height + 5 * this.S,
      vx: side * (20 + this.rand() * 30),
      vy: -60,
      age: 0,
      life: 0.7,
    });
  }

  private setColorTarget(c: RGB, sparkle: boolean) {
    const same = c.every((v, i) => Math.abs(v - this.colorTarget[i]) < 1);
    this.colorTarget = [...c];
    if (sparkle && !same) {
      this.burst("spark", 14, rgbToCss(c), 1.2);
      this.burst("spark", 6, "#FFFFFF", 0.8);
      this.kick(5, -5);
    }
  }

  // -------------------------------------------------------------------------
  // Conversación: ¿a quién has elegido?
  // -------------------------------------------------------------------------

  /** Has pulsado el botón de `agent`. A Claude le alegra; a los otros, celos. */
  chooseAgent(agent: AgentId) {
    if (this.chatAgent === agent) return;
    this.chatAgent = agent;
    this.idleFor = 0;
    if (agent === "claude") {
      this.mood = nudge(this.mood, { happy: 0.25, jealousy: -0.35, boredom: -1 });
      this.pendingColor = null;
      this.setColorTarget(AGENT_COLORS.claude, true);
      this.showIcon("heart");
      this.play("joy");
      return;
    }
    this.mood = nudge(this.mood, { jealousy: 0.5, happy: -0.12, boredom: -1 });
    if (this.isGrounded() && this.mode !== "sleep") {
      // La reacción entera (sorpresa → pena → «hmph» → disfraz) en el suelo.
      this.pendingColor = [...AGENT_COLORS[agent]];
      this.play("jealous");
    } else {
      this.setColorTarget(AGENT_COLORS[agent], true);
      this.showIcon("puff");
    }
  }

  /** Se cerró la conversación: vuelve a su color con un «poof» de alivio. */
  chatEnded() {
    const was = this.chatAgent;
    this.chatAgent = null;
    this.pendingColor = null;
    if (!was || was === "claude") return;
    this.mood = nudge(this.mood, { jealousy: -0.25, happy: 0.05 });
    this.setColorTarget(AGENT_COLORS.claude, true);
    if (this.isGrounded() && this.mode !== "sleep") this.play("poof");
  }

  /** Llegó la respuesta. Si la dio «el otro», un resoplido. */
  replyArrived(agent: AgentId) {
    if (agent === "claude") {
      this.mood = nudge(this.mood, { happy: 0.06 });
      this.showIcon("heart", 1.2);
    } else {
      this.mood = nudge(this.mood, { jealousy: 0.05 });
      this.showIcon("puff", 1.2);
    }
  }

  // -------------------------------------------------------------------------
  // Interacción con el ratón
  // -------------------------------------------------------------------------

  startDrag(px: number, py: number, now: number) {
    this.drag = { offX: this.x - px, offY: this.y - py, samples: [{ x: px, y: py, t: now }] };
    this.ground = null;
    this.hangAnchor = null;
    this.idleFor = 0;
    this.setMode("drag");
    this.kick(-3, 4);
    this.showIcon("exclaim", 0.8);
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
    if (Math.hypot(this.vx, this.vy) > 1200) this.showIcon("exclaim", 0.9);
    this.fall();
  }

  /** Clic sin arrastrar: saltito contento (o enfado si son muchos seguidos). */
  poke() {
    this.idleFor = 0;
    this.pokes = this.pokes.filter((p) => this.t - p < 3);
    this.pokes.push(this.t);
    if (this.mode === "hang") {
      // Clic estando colgada: se suelta de la chincheta.
      this.hangAnchor = null;
      this.vx = 0;
      this.vy = 0;
      this.fall();
      return;
    }
    if (this.pokes.length >= 4) {
      this.pokes = [];
      this.mood = nudge(this.mood, { anger: 0.55, happy: -0.1 });
      this.showIcon("anger");
      if (this.isGrounded()) this.play("angry");
      return;
    }
    this.mood = nudge(this.mood, { happy: 0.08, boredom: -0.3 });
    this.happyUntil = this.t + 0.9;
    if (this.isGrounded()) {
      if (this.mode === "sleep") {
        this.setMode("wave");
        return;
      }
      this.vy = -Math.sqrt(2 * this.g * 10 * this.S);
      this.vx = 0;
      this.ground = null;
      this.kick(-4, 5);
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
      this.kick(3, -3);
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

    this.mood = tickMood(this.mood, dt, {
      sleeping: this.mode === "sleep",
      engaged,
      chattingOther: !!this.chatAgent && this.chatAgent !== "claude",
    });
    const k = 1 - Math.exp(-4 * dt);
    this.color = [
      this.color[0] + (this.colorTarget[0] - this.color[0]) * k,
      this.color[1] + (this.colorTarget[1] - this.color[1]) * k,
      this.color[2] + (this.colorTarget[2] - this.color[2]) * k,
    ];

    this.updateEffects(dt);
    this.updateEyes(input);
    this.updatePetting(input, dt);

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
          this.kick(-5, 7);
          this.fall();
        }
        break;
      case "land":
        if (!this.followGround()) break;
        this.slide(dt);
        if (this.modeT > 0.16) this.afterLanding();
        break;
      case "dizzy":
        if (!this.followGround()) break;
        if (this.modeT > 1.8) {
          this.setMode("idle");
          if (this.mood.anger > 0.35) this.play("angry");
        }
        break;
      case "wave":
        if (!this.followGround()) break;
        if (this.modeT > 1.3) this.setMode("idle");
        break;
      case "emote":
        if (!this.followGround()) break;
        this.stepEmote();
        break;
      default:
        this.stepGround(dt, input);
    }

    if (this.queued && this.isGrounded() && this.mode !== "land" && this.mode !== "crouch") {
      const e = this.queued;
      this.queued = null;
      this.play(e);
    }
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

  private clampToScreen() {
    const hw = this.halfW;
    this.x = clamp(this.x, hw, Math.max(hw, this.W - hw));
    this.y = clamp(this.y, this.height, Math.max(this.height, this.H));
  }

  private updateEffects(dt: number) {
    for (const e of this.effects) {
      e.age += dt;
      if (e.kind === "heart" || e.kind === "note") e.vx = Math.sin(e.age * 5 + e.x) * 25;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.vy += PARTICLE_GRAVITY[e.kind] * dt;
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

  /** Frotar el cursor por encima de la mascota = caricias. */
  private updatePetting(input: FrameInput, dt: number) {
    const cur = input.cursor;
    this.rub *= Math.exp(-0.8 * dt);
    // Solo cuenta el movimiento que empieza Y acaba encima: entrar desde
    // lejos no es una caricia.
    if (input.petHover && this.lastPetHover && cur && this.lastCursor && this.mode !== "drag") {
      this.rub += Math.min(60, Math.hypot(cur.x - this.lastCursor.x, cur.y - this.lastCursor.y));
    }
    this.lastCursor = cur ? { ...cur } : null;
    this.lastPetHover = !!input.petHover;
    if (this.rub > 300 && this.t - this.lastLoveAt > 4) {
      this.rub = 0;
      this.lastLoveAt = this.t;
      this.mood = nudge(this.mood, { happy: 0.25, anger: -0.3, boredom: -1 });
      if (this.isGrounded() && this.mode !== "emote") this.play("love");
      else this.floatUp("heart", 2);
    }
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

  private reactToHover(input: FrameInput) {
    if (this.t - this.lastHoverReact < 5) return;
    this.lastHoverReact = this.t;
    switch (this.moodName) {
      case "enfadada":
        this.showIcon("anger", 1.2);
        if (input.cursor) this.facing = input.cursor.x < this.x ? 1 : -1;
        break;
      case "celosa":
        this.showIcon("puff", 1.2);
        if (input.cursor) this.facing = input.cursor.x < this.x ? 1 : -1;
        break;
      case "triste":
        this.showIcon("cloud", 1.4);
        break;
      case "emocionada":
      case "feliz":
        this.showIcon("heart", 1.2);
        if (this.mode === "idle" || this.mode === "sit") this.play("wiggle");
        break;
      default:
        if (this.mode === "idle" || this.mode === "sit") this.setMode("wave");
    }
  }

  private stepGround(dt: number, input: FrameInput) {
    if (!this.followGround()) return;
    this.slide(dt);
    if (this.mode === "air") return;

    const hoverNow = input.hovered && input.chat === "none";
    if (hoverNow && !this.wasHovered && this.mode !== "sleep") this.reactToHover(input);
    this.wasHovered = hoverNow;

    if (input.hovered || input.chat !== "none") {
      if (this.mode === "sleep") {
        this.setMode("wave");
        this.mood = nudge(this.mood, { energy: 0.1 });
      } else if (this.mode === "walk") this.setMode("idle");
      const grumpy = this.moodName === "enfadada" || this.moodName === "celosa";
      if (input.cursor && input.hovered && !grumpy) {
        const dx = input.cursor.x - this.x;
        if (Math.abs(dx) > 2 * this.S) this.facing = dx < 0 ? -1 : 1;
      }
      this.nextThink = this.t + 1.5;
      return;
    }

    const sleepAfter = this.settings.sleep_after_min * 60;
    if (this.mode !== "sleep") {
      const bored = sleepAfter > 0 && this.idleFor > sleepAfter;
      const tired = this.mood.energy < 0.12 && this.idleFor > 5;
      if (bored || tired) {
        this.walkTarget = null;
        this.sleptTired = tired && !bored;
        this.setMode("sleep");
        return;
      }
    } else {
      if (this.sleptTired && this.mood.energy > 0.95) {
        this.sleptTired = false;
        this.idleFor = 0;
        this.setMode("idle");
        this.play("stretch");
      }
      return;
    }

    if (this.mode === "walk" && this.walkTarget !== null) {
      const [lo, hi] = this.surfaceBounds();
      const target = clamp(this.walkTarget, lo, hi);
      const step = WALK_SPEED * this.S * moodSpeed(this.moodName) * dt;
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
    const m = this.moodName;
    const lowEnergy = m === "cansada" || m === "triste";
    const canJump = this.settings.jump && !lowEnergy;
    type Choice = "walk" | "sit" | "idle" | "jumpUp" | "hopDown" | Emote;
    const w: [Choice, number][] = [
      ["walk", 40],
      ["sit", 10],
      ["idle", 8],
      ["lookAround", 9],
      ["stretch", 4],
      ["wiggle", 3],
      ["hop", 3],
      ["sneeze", 1.2],
      ["jumpUp", canJump ? 16 : 0],
      ["hopDown", canJump && this.ground?.kind === "win" ? 8 : 0],
    ];
    const add = (c: Choice, n: number) => w.push([c, n]);
    switch (m) {
      case "emocionada":
        add("dance", 16);
        add("twirl", 10);
        add("hop", 10);
        break;
      case "feliz":
        add("dance", 8);
        add("hop", 6);
        add("twirl", 4);
        break;
      case "aburrida":
        add("yawn", 12);
        add("sigh", 8);
        add("lookAround", 12);
        add("sit", 10);
        break;
      case "cansada":
        add("yawn", 18);
        add("sit", 25);
        break;
      case "triste":
        add("sigh", 20);
        add("sit", 18);
        break;
      case "enfadada":
        add("tapFoot", 22);
        break;
      case "celosa":
        add("sigh", 10);
        add("tapFoot", 10);
        add("lookAround", 6);
        break;
      default:
        add("peek", 3);
    }
    const total = w.reduce((a, [, n]) => a + n, 0);
    let r = this.rand() * total;
    let pick: Choice = "idle";
    for (const [c, n] of w) {
      if ((r -= n) < 0) {
        pick = c;
        break;
      }
    }
    switch (pick) {
      case "jumpUp":
        if (!this.tryJumpUp()) this.startWalk();
        return;
      case "hopDown":
        if (!this.tryHopDown()) this.startWalk();
        return;
      case "walk":
        this.startWalk();
        return;
      case "sit":
        this.setMode("sit");
        return;
      case "idle":
        this.setMode("idle");
        return;
      default:
        this.play(pick);
    }
  }

  private startWalk() {
    const [lo, hi] = this.surfaceBounds();
    const span = Math.min(hi - lo, 420);
    const target = clamp(this.x + (this.rand() * 2 - 1) * span, lo, hi);
    if (Math.abs(target - this.x) > 4 * this.S) {
      this.walkTarget = target;
      this.setMode("walk");
    } else {
      this.setMode("idle");
    }
  }

  /** Efectos con tiempo dentro de cada animación (una vez por marca). */
  private stepEmote() {
    const e = this.emote;
    if (!e) {
      this.setMode("idle");
      return;
    }
    const tt = this.modeT;
    const once = (key: string, at: number, fn: () => void) => {
      if (tt >= at && !this.emoteMarks.has(key)) {
        this.emoteMarks.add(key);
        fn();
      }
    };
    switch (e) {
      case "lookAround":
        once("flip", 1.2, () => (this.facing = this.facing === 1 ? -1 : 1));
        break;
      case "hop":
        once("l1", 0.5, () => this.kick(4, -4));
        once("l2", 1.0, () => this.kick(4, -4));
        break;
      case "dance":
        for (let i = 1; i < 6; i++) once(`f${i}`, i * 0.5, () => (this.facing = this.facing === 1 ? -1 : 1));
        for (let i = 0; i < 5; i++) once(`n${i}`, i * 0.6, () => this.floatUp("note"));
        break;
      case "twirl":
        for (let i = 1; i < 8; i++) once(`f${i}`, i * 0.12, () => (this.facing = this.facing === 1 ? -1 : 1));
        once("sp", 0.9, () => this.burst("spark", 8, "#FFF3B0", 0.7));
        break;
      case "tapFoot":
        once("i", 0, () => this.showIcon("anger", 1.4));
        break;
      case "sigh":
        once("i", 0.2, () => this.showIcon("cloud", 1.8));
        break;
      case "peek":
        once("i", 0, () => this.showIcon("question", 1.4));
        break;
      case "jealous":
        once("i0", 0, () => {
          this.showIcon("exclaim", 0.5);
          this.kick(-4, 6);
        });
        once("i1", 0.5, () => this.showIcon("cloud", 1.0));
        for (let i = 0; i < 6; i++) once(`t${i}`, 0.55 + i * 0.15, () => this.tear());
        once("turn", 1.5, () => {
          this.facing = this.facing === 1 ? -1 : 1;
          this.showIcon("puff", 1.0);
        });
        once("color", JEALOUS_COLOR_AT, () => {
          if (this.pendingColor) this.setColorTarget(this.pendingColor, true);
          this.pendingColor = null;
        });
        break;
      case "joy":
        once("h0", 0, () => this.floatUp("heart", 2));
        once("h1", 0.6, () => this.floatUp("heart", 2));
        once("k0", 0.5, () => this.kick(4, -4));
        once("k1", 1.1, () => this.kick(4, -4));
        break;
      case "angry":
        once("i", 0, () => this.showIcon("anger", 1.6));
        break;
      case "love":
        for (let i = 0; i < 5; i++) once(`h${i}`, i * 0.3, () => this.floatUp("heart"));
        break;
      case "surprised":
        once("i", 0, () => {
          this.showIcon("exclaim", 0.9);
          this.kick(-4, 6);
        });
        break;
      case "sneeze":
        once("achis", 1.0, () => {
          this.kick(6, -7);
          this.burst("spark", 8, "#FFFFFF", 0.6);
          this.x = clamp(this.x - this.facing * 2 * this.S, this.halfW, this.W - this.halfW);
        });
        break;
      case "stretch":
        once("k", 1.0, () => this.kick(4, -5));
        break;
      default:
        break;
    }
    if (tt >= EMOTE_DURATION[e]) {
      if (e === "jealous" && this.pendingColor) {
        this.setColorTarget(this.pendingColor, true);
        this.pendingColor = null;
      }
      this.setMode("idle");
    }
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
    // Tras un rato colgada, patalea para soltarse.
    if (this.modeT > 4 && Math.floor(this.modeT) % 4 === 0 && this.modeT % 1 < dt) {
      this.swingV += (this.rand() < 0.5 ? -1 : 1) * 3;
      this.showIcon("sweat", 1.2);
    }
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

  private splat(side: Surface) {
    this.splatSide = side;
    this.vx = 0;
    this.vy = 0;
    if (side === "left") this.facing = -1;
    if (side === "right") this.facing = 1;
    this.mood = nudge(this.mood, { anger: 0.22, happy: -0.12 });
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

  /** Pose de un gesto con guion en el instante `tt`. */
  private emotePose(e: Emote, tt: number, p: Pose): Eyes | null {
    const alt = (hz: number) => Math.floor(tt * hz) % 2 === 0;
    const hopLift = (period: number, height: number) => Math.abs(Math.sin((Math.PI * tt) / period)) * height;
    switch (e) {
      case "lookAround":
        p.lookX = Math.sin(tt * 2.6) * 1.4;
        p.lookY = -0.4;
        return null;
      case "stretch":
        p.armL = p.armR = "up";
        if (tt < 1.0) {
          p.sx = 0.88;
          p.sy = 1.2;
          return "closed";
        }
        return "happy";
      case "yawn":
        p.armR = tt > 0.3 && tt < 1.4 ? "wave2" : "out";
        p.sy = tt > 0.3 && tt < 1.4 ? 1.12 : 1;
        p.dx = tt > 1.5 ? Math.sin(tt * 18) * 0.6 : 0;
        return tt > 0.2 && tt < 1.5 ? "closed" : "sleepy";
      case "hop": {
        p.lift = hopLift(0.5, 3);
        p.legs = p.lift > 0.6 ? "dangle" : "stand";
        p.armL = p.armR = p.lift > 0.6 ? "up" : "out";
        return "happy";
      }
      case "dance": {
        p.lift = hopLift(0.25, 1.2);
        p.legs = alt(4) ? "walk1" : "walk2";
        const a = alt(4);
        p.armL = a ? "wave1" : "flail1";
        p.armR = a ? "flail1" : "wave1";
        p.blush = true;
        return "happy";
      }
      case "twirl":
        p.lift = Math.sin((Math.PI * Math.min(tt, 0.9)) / 0.9) * 2.5;
        p.armL = p.armR = alt(8) ? "out" : "up";
        p.legs = "dangle";
        return "happy";
      case "tapFoot":
        p.legs = alt(6) ? "walk1" : "stand";
        p.armL = p.armR = "cross";
        p.brows = "angry";
        p.lookX = -1;
        return null;
      case "sigh":
        p.sy = tt > 0.4 && tt < 1.6 ? 0.86 : 1;
        p.sx = tt > 0.4 && tt < 1.6 ? 1.06 : 1;
        p.armL = p.armR = "down";
        p.brows = "sad";
        p.lookY = 1;
        p.breath = Math.sin(tt * 2.8) * 0.8;
        return tt > 0.5 && tt < 1.5 ? "sleepy" : null;
      case "wiggle":
        p.dx = Math.sin(tt * 14) * 1.2;
        p.armL = alt(7) ? "flail1" : "out";
        p.armR = alt(7) ? "out" : "flail1";
        return "happy";
      case "peek":
        p.dx = 1;
        p.brows = "up";
        p.lookX = 1.4;
        return tt < 0.6 ? "wide" : null;
      case "jealous":
        if (tt < 0.5) {
          p.brows = "up";
          p.armL = p.armR = "up";
          p.lift = Math.sin((Math.PI * tt) / 0.5) * 1.5;
          return "wide";
        }
        if (tt < 1.5) {
          p.brows = "sad";
          p.armL = p.armR = "down";
          p.sy = 0.9;
          p.sx = 1.05;
          p.lookY = 1;
          p.lookX = -1;
          p.breath = Math.sin(tt * 9) * 0.5; // sollozos
          return null;
        }
        p.armL = p.armR = "cross";
        p.brows = tt < JEALOUS_COLOR_AT ? "angry" : "sad";
        p.lookX = -1;
        return tt < JEALOUS_COLOR_AT + 0.25 && tt > JEALOUS_COLOR_AT - 0.1 ? "closed" : null;
      case "joy":
        p.lift = hopLift(0.55, 3.2);
        p.armL = p.armR = p.lift > 0.5 ? "up" : "wave1";
        p.legs = p.lift > 0.5 ? "dangle" : "stand";
        p.blush = true;
        return "happy";
      case "poof":
        p.armL = p.armR = "up";
        return tt < 0.35 ? "closed" : "happy";
      case "angry":
        p.lift = Math.abs(Math.sin(tt * 12)) * 0.7;
        p.legs = alt(10) ? "walk1" : "walk2";
        p.armL = p.armR = alt(5) ? "flail1" : "cross";
        p.brows = "angry";
        p.dx = Math.sin(tt * 30) * 0.5;
        return "squint";
      case "love":
        p.dx = Math.sin(tt * 6) * 1;
        p.blush = true;
        p.armL = p.armR = "cross";
        return "heart";
      case "surprised":
        p.lift = tt < 0.35 ? Math.sin((Math.PI * tt) / 0.35) * 3 : 0;
        p.armL = p.armR = tt < 0.35 ? "up" : "out";
        p.brows = "up";
        return "wide";
      case "sneeze":
        if (tt < 1.0) {
          p.sy = 1 + 0.15 * tt;
          p.brows = "up";
          return tt > 0.6 ? "squint" : "sleepy";
        }
        p.armL = p.armR = "flail1";
        return tt < 1.3 ? "closed" : "happy";
    }
  }

  /** Expresión de fondo según el ánimo (cuando nada más manda). */
  private moodFace(p: Pose): Eyes | null {
    const m = this.moodName;
    let brows: Brows = "none";
    let eyes: Eyes | null = null;
    if (m === "triste" || m === "celosa") brows = "sad";
    if (m === "enfadada") brows = "angry";
    if (m === "cansada") eyes = "sleepy";
    if (m === "emocionada" || (m === "feliz" && Math.sin(this.t * 0.7) > 0.6)) p.blush = true;
    if (m === "triste") p.lookY = Math.max(p.lookY, 0.6);
    p.brows = brows;
    return eyes;
  }

  frame(chat: ChatState): Frame {
    const t = this.t;
    const p: Pose = { ...BASE_POSE, lookX: this.lookX, lookY: this.lookY };
    let pin: Frame["pin"] = null;
    let zzz = false;
    let stars = false;
    let snap = false;

    // Parpadeo en 3 fases (medio, cerrado, medio), a veces doble.
    const blinkPhase = (() => {
      if (t > this.blinkAt + 0.5) {
        this.doubleBlink = this.rand() < 0.2;
        this.blinkAt = t + 2.2 + this.rand() * 3.5;
      }
      let d = t - this.blinkAt;
      if (this.doubleBlink && d > 0.25) d -= 0.25;
      if (d < 0 || d > 0.16) return null;
      return d < 0.05 || d > 0.11 ? "blink" : "closed";
    })();
    let eyes: Eyes = blinkPhase ?? "open";
    const mf = this.moodFace(p);
    if (mf && !blinkPhase) eyes = mf;
    if (t < this.happyUntil) eyes = "happy";
    const alt = (hz: number) => Math.floor(t * hz) % 2 === 0;
    // Respiración: sube y baja el cuerpo de forma continua.
    p.breath = (Math.sin(t * 2.4) + 1) * 0.28;

    switch (this.mode) {
      case "walk": {
        const ph = t * 8 * moodSpeed(this.moodName);
        const step = Math.floor(ph) % 4;
        p.legs = step === 0 ? "walk1" : step === 2 ? "walk2" : "stand";
        p.lift = Math.abs(Math.sin((ph * Math.PI) / 2)) * 0.45;
        p.breath = 0;
        if (this.moodName === "enfadada") p.armL = p.armR = "cross";
        break;
      }
      case "sit":
        p.legs = "tuck";
        p.armL = p.armR = "down";
        break;
      case "sleep":
        p.legs = "tuck";
        p.armL = p.armR = "down";
        eyes = "closed";
        p.breath = (Math.sin(t * 1.3) + 1) * 0.45;
        p.sy = 0.92;
        zzz = true;
        break;
      case "crouch":
        p.sx = 1.18;
        p.sy = 0.72;
        p.legs = "tuck";
        p.armL = p.armR = "down";
        break;
      case "air": {
        // Estiramiento continuo según la velocidad vertical.
        const st = clamp(-this.vy / 2600, -0.22, 0.28);
        p.sy = 1 + st;
        p.sx = 1 - st * 0.6;
        p.breath = 0;
        if (this.vy < -150) {
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
      }
      case "land":
        p.legs = "tuck";
        break;
      case "drag": {
        p.armL = p.armR = alt(3) ? "flail1" : "out";
        p.legs = "dangle";
        p.legSwing = this.swing;
        p.breath = 0;
        const v = this.dragVelocity();
        eyes = Math.hypot(v.vx, v.vy) > 900 ? "wide" : t < this.happyUntil ? "happy" : eyes;
        if (this.moodName === "enfadada") p.brows = "angry";
        break;
      }
      case "hang":
        p.armL = p.armR = "up";
        p.legs = "dangle";
        p.legSwing = -this.swing * 0.8;
        p.brows = this.modeT > 4 ? "sad" : "up";
        if (this.hangAnchor) pin = { ...this.hangAnchor };
        break;
      case "splat":
        snap = true;
        p.legs = "none";
        p.armL = p.armR = "flat";
        p.breath = 0;
        if (this.splatSide === "floor") {
          eyes = "dizzy";
          p.sx = 1.5;
          p.sy = 0.35;
        } else if (this.splatSide === "ceil") {
          eyes = "dizzy";
          p.sx = 1.3;
          p.sy = 0.5;
          p.dy = -(SPRITE_H - 4);
        } else {
          // Contra una pared el cuerpo mide 6 px y las X se pisarían: > <.
          eyes = "squint";
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
        p.brows = "sad";
        stars = true;
        break;
      case "wave": {
        eyes = "happy";
        const w = Math.sin(this.modeT * 14) > 0 ? "wave1" : "wave2";
        p.armR = w as Arm;
        p.blush = this.moodName === "feliz" || this.moodName === "emocionada";
        break;
      }
      case "emote":
        if (this.emote) {
          const e = this.emotePose(this.emote, this.modeT, p);
          if (e) eyes = e;
          else if (eyes === "sleepy" && this.emote !== "sigh") eyes = blinkPhase ?? "open";
        }
        break;
      case "drive": {
        p.armR = "up";
        p.legs = alt(10) ? "run1" : "run2";
        p.legSwing = this.swing;
        p.breath = 0;
        const a = this.driveAct;
        const since = a ? t - a.t : 99;
        if (a && since < 0.25 && (a.kind === "click" || a.kind === "grab" || a.kind === "drop")) {
          p.armR = "down";
          eyes = "squint";
        } else if (a && since < 0.9 && (a.kind === "type" || a.kind === "key")) {
          p.armL = alt(12) ? "type1" : "type2";
          p.armR = alt(12) ? "type2" : "type1";
          eyes = "squint";
        }
        break;
      }
    }

    // Conversación (en el suelo, salvo gestos con guion que ya mandan).
    const groundedChat = this.isGrounded() && !["dizzy", "wave", "emote", "sleep"].includes(this.mode);
    if (groundedChat && chat !== "none") {
      const other = !!this.chatAgent && this.chatAgent !== "claude";
      if (other) {
        // Hablando con «el otro»: brazos cruzados y mirada de reojo.
        p.armL = p.armR = "cross";
        p.brows = "sad";
        p.lookX = Math.sin(t * 0.8) > 0.3 ? 1 : -1;
        p.lookY = 0;
        if (chat === "think") p.breath = (Math.sin(t * 1.5) + 1) * 0.4;
      } else if (chat === "listen") {
        p.armL = p.armR = "down";
        p.brows = "up";
      } else if (chat === "think") {
        p.armR = "up";
        p.armL = "down";
        p.lookX = -1;
        p.lookY = -1;
        p.lift = Math.abs(Math.sin(t * 3)) * 0.4;
      } else if (chat === "talk") {
        const f = alt(3);
        p.armL = f ? "out" : "down";
        p.armR = f ? "down" : "out";
        p.blush = true;
      }
    }

    if (this.mode === "sleep") eyes = "closed";
    p.eyes = eyes;

    // Muelle de aplastamiento: la pose da el objetivo; el cuerpo lo alcanza
    // rebotando. Al espachurrarse se fija de golpe.
    const dtF = Math.min(Math.max(t - this.frameT, 0), 1 / 15);
    this.frameT = t;
    if (snap) {
      this.sq = { x: p.sx, y: p.sy, vx: 0, vy: 0 };
    } else {
      const steps = Math.max(1, Math.ceil(dtF / (1 / 120)));
      const h = dtF / steps;
      for (let i = 0; i < steps; i++) {
        this.sq.vx += (SPRING_K * (p.sx - this.sq.x) - SPRING_C * this.sq.vx) * h;
        this.sq.vy += (SPRING_K * (p.sy - this.sq.y) - SPRING_C * this.sq.vy) * h;
        this.sq.x += this.sq.vx * h;
        this.sq.y += this.sq.vy * h;
      }
      this.sq.x = clamp(this.sq.x, 0.5, 1.7);
      this.sq.y = clamp(this.sq.y, 0.4, 1.6);
      p.sx = this.sq.x;
      p.sy = this.sq.y;
    }

    let icon: Frame["icon"] = null;
    if (this.icon) {
      const age = t - this.icon.t0;
      if (age < this.icon.life) icon = { glyph: this.icon.glyph, age, life: this.icon.life };
      else this.icon = null;
    }

    return {
      pose: p,
      facing: this.facing,
      x: this.x,
      y: this.y,
      color: rgbToCss(this.color),
      pin,
      zzz,
      stars,
      icon,
    };
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
