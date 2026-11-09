// Mascota — capa base del motor: estado compartido, medidas, mundo y efectos.
//
// El motor se reparte en capas que heredan unas de otras, cada una con un
// subsistema: base (este fichero) → física (enginePhysics.ts) → viajes
// (engineTravel.ts) → trepada (engineClimb.ts) → entrada (engineInput.ts) → MascotEngine (engine.ts,
// paso, comportamiento y pose). Sin DOM ni Tauri.

import { BODY_W, SPRITE_H, type Glyph } from "./sprite";
import { floorGaps, platformUnder, visiblePlatforms, type Platform, type WinRect } from "./world";
import { visibleWalls, withComposers, type SessionsInside, type Wall } from "./sessionsInside";
import type { Hat } from "./outfits";
import type { MascotSettings } from "./settings";
import { HatDrop } from "./hatDrop";
import { Vitality } from "./vitality";
import { EMOTE_DURATION, type Emote } from "./emotes";
import { ActivityRunner } from "./activities/runner";
import { clamp } from "./activities/util";
import { yawnsOnWake } from "./nightRest";
import { Squash } from "./framePose";
import { burstEffects, floatEffects, stepEffects, tearEffect } from "./particles";
import { AGENT_COLORS, BASE_MOOD, moodName, rgbToCss, type AgentId, type Mood, type MoodName, type RGB } from "./mood";
import { GRAVITY, GROUNDED, type Effect, type EffectKind, type Exits, type Ground, type Mode, type Side } from "./engineTypes";

export class EngineCore {
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
  /** Ventanas de Sessions y su cuadro de texto (sessionsInside.ts). */
  inside: SessionsInside[] = [];
  /** Laterales de Sessions por los que trepar. */
  walls: Wall[] = [];
  /** Tramos del suelo entre las islas de la barra transparente (sin islas, uno entero). */
  gaps: [number, number][] = [];
  effects: Effect[] = [];

  mood: Mood = { ...BASE_MOOD };
  emote: Emote | null = null;
  /** Agente de la conversación abierta (null = ninguna). */
  chatAgent: AgentId | null = null;
  color: RGB = [...AGENT_COLORS.claude];
  colorTarget: RGB = [...AGENT_COLORS.claude];

  idleFor = 0;
  happyUntil = 0;
  /** Bordes que dan a otro monitor (los pone la app según las pantallas). */
  exits: Exits = { left: [], right: [] };
  /** Ha cruzado un borde hacia otro monitor: la app muda la ventana. */
  exitRequest: { side: Side; y: number } | null = null;
  carrying: string | null = null;
  hat: Hat | null = null;
  /** Sentimientos, memoria, estado y microgestos (vitality.ts). */
  life: Vitality;
  /** Actividades (leer, pescar, malabares…) y los objetos que dejan por el mundo. */
  readonly acts: ActivityRunner;
  /** Reloj de pared (la noche, la temporada); los tests lo sustituyen. */
  now: () => Date = () => new Date();

  protected nextThink = 3;
  protected walkTarget: number | null = null;
  protected queued: Emote | null = null;
  protected icon: { glyph: Glyph; t0: number; life: number } | null = null;
  protected emoteMarks = new Set<string>();
  /** Muelle de aplastamiento/estiramiento (framePose.ts). */
  protected readonly squash = new Squash();
  protected readonly hatDrop = new HatDrop();
  protected rand: () => number;

  constructor(W: number, H: number, settings: MascotSettings, rand: () => number = Math.random) {
    this.W = W;
    this.H = H;
    this.settings = settings;
    this.rand = rand;
    this.life = new Vitality(rand);
    this.acts = new ActivityRunner(rand);
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

  /** Ventanas en orden Z y, de las de Sessions, su cuadro de texto (se conserva si no llega). */
  setWindows(wins: WinRect[], inside: SessionsInside[] = this.inside) {
    this.wins = wins;
    this.inside = inside;
    this.rebuildWorld();
  }

  setSettings(s: MascotSettings) {
    this.settings = s;
    this.rebuildWorld();
    if (!s.climb_windows && this.ground?.kind === "win") this.fall();
  }

  /** Plataformas (bordes y cuadro de texto de Sessions) y paredes; nada sin «subirse a ventanas». */
  private rebuildWorld() {
    const on = this.settings.climb_windows;
    this.plats = on ? visiblePlatforms(withComposers(this.wins, this.inside), this.W) : [];
    this.walls = on ? visibleWalls(this.wins, this.inside, this.W) : [];
    this.gaps = floorGaps(this.wins, this.W);
  }

  /** ¿Hay islas de la barra partiendo el suelo? */
  protected hasIslands(): boolean {
    return this.wins.some((w) => w.isTaskbarIsland);
  }

  /** Tramo del suelo bajo x, o null si x cae en una isla de la barra. */
  protected floorGapAt(x: number): [number, number] | null {
    if (!this.hasIslands()) return [0, this.W];
    return this.gaps.find(([l, r]) => x >= l && x <= r) ?? null;
  }

  /** Dónde caben los pies en el tramo de suelo [l, r] sin asomar por los bordes. */
  protected gapBounds([l, r]: [number, number]): [number, number] {
    const hw = this.halfW;
    const lo = Math.max(hw, l + hw);
    const hi = Math.min(this.W - hw, r - hw);
    return hi >= lo ? [lo, hi] : [(l + r) / 2, (l + r) / 2];
  }

  /**
   * En el suelo, nunca delante de una isla de la barra: si los pies caen en
   * una (soltarlo ahí, una isla que aparece), se sube encima; sin plataforma
   * (no trepa ventanas), al tramo libre más cercano. Un cuerpo que asoma
   * sobre una isla vuelve dentro de su tramo.
   */
  private keepOffIslands() {
    if (!this.hasIslands()) return;
    const gap = this.floorGapAt(this.x);
    if (gap) {
      const [lo, hi] = this.gapBounds(gap);
      this.x = clamp(this.x, lo, hi);
      return;
    }
    const island = this.wins.find((w) => w.isTaskbarIsland && this.x >= w.left && this.x <= w.right);
    const p = island && this.plats.find((q) => q.id === island.id && this.x >= q.left && this.x <= q.right);
    if (p) {
      this.ground = { kind: "win", id: p.id, winLeft: p.winLeft };
      this.y = p.top;
      return;
    }
    const near = this.gaps
      .map((g) => this.gapBounds(g))
      .map(([lo, hi]) => clamp(this.x, lo, hi))
      .sort((a, b) => Math.abs(a - this.x) - Math.abs(b - this.x))[0];
    if (near !== undefined) this.x = near;
  }

  /** Plataforma sobre la que está (para tests y depuración). */
  standingOn(): Platform | null {
    if (this.ground?.kind !== "win") return null;
    return platformUnder(this.plats, this.x, this.y, 1);
  }

  protected setMode(m: Mode) {
    if (this.mode === "act" && m !== "act") this.acts.abort(this.t);
    this.mode = m;
    this.modeT = 0;
    if (m !== "emote") this.emote = null;
  }

  protected fall() {
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

  /** Despertar: de noche bosteza; de día saluda. */
  protected wake() {
    if (!yawnsOnWake(this.now())) return this.setMode("wave");
    this.setMode("idle");
    this.play("yawn");
  }

  // -------------------------------------------------------------------------
  // Efectos: iconos, muelle, partículas y color
  // -------------------------------------------------------------------------

  showIcon(glyph: Glyph, life = 1.6) {
    this.icon = { glyph, t0: this.t, life };
  }

  /** Impulso al muelle de aplastamiento (+x = más ancha, +y = más alta). */
  kick(dx: number, dy: number) {
    this.squash.kick(dx, dy);
  }

  burst(kind: EffectKind, n: number, color?: string, spread = 1) {
    this.effects.push(...burstEffects(this, kind, n, color, spread, this.rand));
  }

  floatUp(kind: "heart" | "note", n = 1) {
    this.effects.push(...floatEffects(this, kind, n, this.rand));
  }

  protected tear() {
    this.effects.push(tearEffect(this, this.rand));
  }

  protected updateEffects(dt: number) {
    this.effects = stepEffects(this.effects, dt);
  }

  protected setColorTarget(c: RGB, sparkle: boolean) {
    const same = c.every((v, i) => Math.abs(v - this.colorTarget[i]) < 1);
    this.colorTarget = [...c];
    if (sparkle && !same) {
      this.burst("spark", 14, rgbToCss(c), 1.2);
      this.burst("spark", 6, "#FFFFFF", 0.8);
      this.kick(5, -5);
    }
  }

  // -------------------------------------------------------------------------
  // Suelo y bordes
  // -------------------------------------------------------------------------

  protected clampToScreen() {
    const hw = this.halfW;
    this.x = clamp(this.x, hw, Math.max(hw, this.W - hw));
    this.y = clamp(this.y, this.height, Math.max(this.height, this.H));
  }

  /**
   * Mantiene los pies sobre su suelo. Si la ventana se movió, la mascota va
   * montada; si desapareció o ya no hay borde bajo los pies, se cae.
   * Devuelve false si empezó a caer.
   */
  protected followGround(): boolean {
    const g = this.ground;
    if (!g || g.kind === "floor") {
      this.y = this.H;
      this.keepOffIslands();
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

  surfaceBounds(): [number, number] {
    const hw = this.halfW;
    const g = this.ground;
    if (g?.kind === "win") {
      const p = this.plats.find((q) => q.id === g.id && this.x >= q.left && this.x <= q.right);
      if (p) return [Math.max(hw, p.left + 2), Math.min(this.W - hw, p.right - 2)];
    }
    const gap = this.floorGapAt(this.x);
    return gap ? this.gapBounds(gap) : [hw, this.W - hw];
  }

  protected slide(dt: number) {
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

  /**
   * Si ha cruzado un borde que da a otro monitor, lo deja esperando en el
   * borde y lo pide a la app (que muda la ventana y llama a enterFrom).
   */
  protected edgeExit(): boolean {
    const hw = this.halfW;
    const side: Side | null = this.x + hw > this.W ? "right" : this.x - hw < 0 ? "left" : null;
    if (!side) return false;
    const midY = this.y - this.height / 2;
    if (!this.exits[side].some(([a, b]) => midY >= a && midY <= b)) return false;
    this.x = side === "right" ? this.W - hw : hw;
    if (!this.exitRequest) this.exitRequest = { side, y: this.y };
    return true;
  }
}
