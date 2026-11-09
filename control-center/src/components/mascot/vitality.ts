// Mascota — la «vida» de Pupus: sentimientos, memoria de sucesos, estado con
// histéresis, microanimaciones y lo que estás haciendo. Es el único campo
// nuevo del motor (`engine.life`); el motor solo le avisa de lo que pasa
// (tick, note) y le pide la cara, la postura y los permisos.
//
// Cero tokens: todo es local (motor, ventana en primer plano, tiempo sin
// tocar nada, micrófono, avisos de Sessions y de builds).

import type { ChatState, Emote, Mode } from "./engine";
import type { Mood } from "./mood";
import type { Eyes, Pose } from "./sprite";
import { diffAmbient, isFocusActivity, type Activity, type AmbientSample } from "./ambient";
import {
  EPISODE_IMPACT,
  absenceMs,
  countSince,
  memoryBias,
  parseEpisodes,
  remember,
  type Episode,
  type EpisodeKind,
  type Impact,
} from "./episodes";
import { BASE_FEELINGS, nudgeFeelings, parseFeelings, tickFeelings, type Feelings } from "./feelings";
import { breathFor, expressionFor } from "./expression";
import { IdleLife } from "./idleLife";
import { STATE_TABLE, type StateTraits } from "./moodTable";
import { pickState, scoreStates, transitionCue, type MoodState } from "./moodState";

export interface TickCtx {
  mood: Mood;
  mode: Mode;
  chat: ChatState;
  engaged: boolean;
  /** Cursor en px CSS, o null. */
  cursor: { x: number; y: number } | null;
  /** Centro del cuerpo de Pupus, px CSS. */
  pet: { x: number; y: number };
}

/** Ausencia a partir de la cual el saludo es efusivo. */
const LONG_ABSENCE_MS = 30 * 60_000;
/** Cursor que se acerca más rápido que esto (px/s) asusta a un Pupus receloso. */
const FAST_APPROACH = 600;
const FLEE_RADIUS = 170;
const PLAY_RADIUS = 260;

const clampLook = (v: number) => Math.max(-1.4, Math.min(1.4, v));

export class Vitality {
  feelings: Feelings = { ...BASE_FEELINGS };
  episodes: Episode[] = [];
  state: MoodState = "contento";
  private since = 0;
  private t = 0;
  private ambient: AmbientSample | null = null;
  private idle = new IdleLife();
  private cursor: { x: number; y: number } | null = null;
  /** Velocidad con la que el cursor se acerca (px/s, + = acercándose). */
  private approach = 0;
  private cursorPlay = false;

  constructor(
    private readonly rand: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  get traits(): StateTraits {
    return STATE_TABLE[this.state];
  }

  get activity(): Activity {
    return this.ambient?.activity ?? "otro";
  }

  private get userAway(): boolean {
    return (this.ambient?.idleMs ?? 0) >= 5 * 60_000;
  }

  /** Avanza `dt` segundos. Devuelve el gesto de transición si cambió de estado. */
  tick(dt: number, c: TickCtx): Emote | null {
    this.t += dt;
    this.since += dt;
    this.trackCursor(dt, c);
    const nowMs = this.now();
    const rest = { ...BASE_FEELINGS, ...memoryBias(this.episodes, nowMs) };
    const sleeping = c.mode === "sleep";
    this.feelings = tickFeelings(this.feelings, dt, { engaged: c.engaged, sleeping, userAway: this.userAway }, rest);
    this.idle.step(this.t, this.traits, c.mode, c.chat, this.rand);
    const scene = {
      now: new Date(nowMs),
      activity: this.activity,
      userActive: (this.ambient?.idleMs ?? 0) < 60_000,
      cursorPlay: this.cursorPlay,
    };
    const scores = scoreStates(c.mood, this.feelings, scene, this.episodes, nowMs);
    const next = pickState(this.state, scores, this.since, this.traits.dwellS);
    if (next === this.state) return null;
    const cue = transitionCue(this.state, next);
    this.state = next;
    this.since = 0;
    return cue;
  }

  private trackCursor(dt: number, c: TickCtx) {
    const cur = c.cursor;
    const prev = this.cursor;
    this.cursor = cur ? { ...cur } : null;
    if (!cur || !prev || dt <= 0) {
      this.approach = 0;
      this.cursorPlay = false;
      return;
    }
    const d0 = Math.hypot(prev.x - c.pet.x, prev.y - c.pet.y);
    const d1 = Math.hypot(cur.x - c.pet.x, cur.y - c.pet.y);
    const k = 1 - Math.exp(-12 * dt);
    this.approach += ((d0 - d1) / dt - this.approach) * k;
    const moving = Math.hypot(cur.x - prev.x, cur.y - prev.y) / dt > 60;
    this.cursorPlay = moving && d1 < PLAY_RADIUS && !c.engaged;
  }

  /** Apunta un suceso: memoria, sentimientos y lo que el motor debe aplicar. */
  note(k: EpisodeKind): Impact {
    const nowMs = this.now();
    const base = EPISODE_IMPACT[k];
    let feel = base.feel ?? {};
    let react = base.react;
    // Tercer lanzamiento en 10 min: ya no es un susto, es miedo.
    if (k === "lanzado" && countSince(this.episodes, "lanzado", nowMs, 10 * 60_000) >= 2) {
      feel = { ...feel, fear: (feel.fear ?? 0) + 0.3 };
    }
    if (k === "vuelves" && absenceMs(this.episodes, nowMs) > LONG_ABSENCE_MS) react = "joy";
    this.feelings = nudgeFeelings(this.feelings, feel);
    this.episodes = remember(this.episodes, { k, at: nowMs });
    return { mood: base.mood, feel, react };
  }

  /** Nueva muestra de lo que haces (o null: ajuste apagado). Devuelve los sucesos. */
  setAmbient(sample: AmbientSample | null): EpisodeKind[] {
    const prev = this.ambient;
    this.ambient = sample;
    return sample ? diffAmbient(prev, sample) : [];
  }

  /**
   * ¿Está de humor para travesuras o paseos largos? Nunca mientras programas
   * o estás en una llamada (salvo que te hayas ido).
   */
  allows(what: "pranks" | "wander"): boolean {
    if (isFocusActivity(this.activity) && !this.userAway) return false;
    return what === "pranks" ? this.traits.pranks : this.traits.wander;
  }

  /** Cara y postura de fondo del estado sobre `p` (copia nueva). La mirada se suma. */
  face(p: Pose, t: number): { pose: Pose; eyes: Eyes | null } {
    const ex = expressionFor(this.state, t);
    const pose: Pose = { ...p, ...ex.pose, breath: breathFor(this.state, t) };
    pose.lookX = clampLook(p.lookX + (ex.pose.lookX ?? 0));
    pose.lookY = clampLook(p.lookY + (ex.pose.lookY ?? 0));
    return { pose, eyes: ex.eyes };
  }

  /** Microanimación en curso sobre `p` (copia nueva), o null. */
  micro(p: Pose, mode: Mode): { pose: Pose; eyes: Eyes | null } | null {
    const o = this.idle.overlay(this.t, mode);
    return o ? { pose: { ...p, ...o.pose }, eyes: o.eyes } : null;
  }

  /** Segundos hasta el siguiente parpadeo. */
  blinkGap(): number {
    const [lo, hi] = this.traits.blinkGap;
    return lo + this.rand() * (hi - lo);
  }

  /**
   * Receloso o asustado y el cursor se le echa encima deprisa: sentido
   * hacia el que apartarse (-1 / 1), o 0.
   */
  flee(petX: number): -1 | 0 | 1 {
    const c = this.cursor;
    if (!c || this.feelings.fear < 0.15 || this.approach < FAST_APPROACH) return 0;
    if (Math.abs(c.x - petX) > FLEE_RADIUS) return 0;
    return c.x < petX ? 1 : -1;
  }

  serialize(): string {
    return JSON.stringify({ v: 1, feelings: this.feelings, episodes: this.episodes });
  }

  /** Recupera lo guardado. false si no vale (se queda como estaba). */
  restore(raw: string | null): boolean {
    if (!raw) return false;
    try {
      const v = JSON.parse(raw) as { v?: unknown; feelings?: unknown; episodes?: unknown };
      const f = v?.v === 1 ? parseFeelings(v.feelings) : null;
      if (!f) return false;
      this.feelings = f;
      this.episodes = parseEpisodes(v.episodes).filter((e) => this.now() - e.at < 24 * 3600_000);
      return true;
    } catch {
      return false;
    }
  }
}
