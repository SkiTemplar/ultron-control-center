// Mascota — motor de actividades: elige cuál (sorteo con pesos, cooldowns y
// hueco global), ejecuta el guion en curso, mueve los objetos que dejan por
// el mundo y traduce sus sucesos (pompa reventada, avión posado) en
// reacciones de Pupus. El motor (engine.ts) solo lo engancha.

import { nudge } from "../mood";
import type { MoodState } from "../moodState";
import { pickWeighted } from "../moodTable";
import { isNight, type Body } from "../outfits";
import type { Pose } from "../sprite";
import { platformUnder, type WinRect } from "../world";
import { addCatch, catchSummary, localCatchStore, type Catches, type CatchStore } from "./catches";
import { CATALOG, DANCE_PER_MIN, GLOBAL_GAP_S, MAX_ITEMS, OFFER_WEIGHT, REQUEST_GAP_S, ACTIVITY_IDS } from "./catalog";
import type {
  Actor,
  ActivityCtx,
  ActivityDef,
  ActivityId,
  ActivityRun,
  CatchKind,
  FishLine,
  ItemEvent,
  Kit,
  NewItem,
  PropSet,
  StepResult,
  WorldItem,
} from "./types";
import { clamp } from "./util";
import { stepItems } from "./worldItems";

export type { ActivityId } from "./types";

/** Lo que el motor de actividades lee del motor de Pupus (MascotEngine lo cumple). */
export interface Host extends Actor {
  settings: { activities: boolean; music_dance: boolean };
  life: { state: MoodState; allows(what: "pranks" | "wander"): boolean };
  wins: WinRect[];
  now(): Date;
}

export interface RunnerInput {
  dt: number;
  cursor: { x: number; y: number } | null;
  hovered: boolean;
  chat: string;
}

/** Margen sobre la duración máxima antes de cortar una actividad que no acaba. */
const HARD_CAP_S = 20;

/** Borde real (no tapado por otra ventana) más cercano de la ventana en la que está, con su caída libre. */
function edgeOf(h: Host, lo: number, hi: number): ActivityCtx["edge"] {
  if (h.ground?.kind !== "win") return null;
  const p = platformUnder(h.plats, h.x, h.y, 1);
  const w = p && h.wins.find((q) => q.id === p.id);
  if (!p || !w) return null;
  const sides: { x: number; dir: 1 | -1; real: boolean }[] = [
    { x: hi, dir: 1, real: p.right >= w.right - 1 },
    { x: lo, dir: -1, real: p.left <= w.left + 1 },
  ];
  let best: ActivityCtx["edge"] = null;
  for (const s of sides) {
    if (!s.real) continue;
    const xo = s.x + s.dir * 12 * h.S;
    const below = h.plats.filter((q) => q.top > p.top + 2 && xo >= q.left && xo <= q.right).map((q) => q.top);
    const drop = Math.min(h.H, ...below) - p.top;
    if (!best || Math.abs(s.x - h.x) < Math.abs(best.x - h.x)) best = { x: s.x, dir: s.dir, drop };
  }
  return best;
}

/** Contexto de elección a partir del estado del motor. */
export function ctxOf(h: Host, outfit: Body | null, music: boolean): ActivityCtx {
  const d = h.now();
  const [lo, hi] = h.surfaceBounds();
  return {
    state: h.life.state,
    night: isNight(d),
    hour: d.getHours(),
    month: d.getMonth() + 1,
    calmOnly: !h.life.allows("wander"),
    onWindow: h.ground?.kind === "win",
    ahead: h.facing === 1 ? hi - h.x : h.x - lo,
    behind: h.facing === 1 ? h.x - lo : hi - h.x,
    edge: edgeOf(h, lo, hi),
    outfit,
    music,
  };
}

export class ActivityRunner {
  run: ActivityRun | null = null;
  items: WorldItem[] = [];
  /** Disfraz de juego puesto (lo fija useForeground). */
  outfit: Body | null = null;
  /** Suena música (lo fija useMediaSense). */
  music = false;
  readonly kit: Kit;
  private def: ActivityDef | null = null;
  private limit: [number, number] | null = null;
  private lastEnd = -Infinity;
  private readonly until = new Map<ActivityId, number>();
  private nextId = 1;
  private pops = 0;
  private catches: Catches;

  constructor(
    private readonly rand: () => number,
    private readonly store: CatchStore = localCatchStore(),
  ) {
    this.catches = store.load();
    this.kit = {
      rand,
      spawn: (it) => this.spawn(it),
      item: (id) => this.items.find((i) => i.id === id),
      patch: (id, p) => (this.items = this.items.map((i) => (i.id === id ? { ...i, ...p } : i))),
      moveX: (a, dx) => this.moveX(a, dx),
      recordCatch: (k) => this.record(k),
    };
  }

  get current(): ActivityId | null {
    return this.run?.id ?? null;
  }

  ctx(h: Host): ActivityCtx {
    return ctxOf(h, this.outfit, this.music);
  }

  private cooling(id: ActivityId, t: number): boolean {
    return (this.until.get(id) ?? -Infinity) > t;
  }

  /** Candidatas ahora mismo con su peso (sin las que están en cooldown). */
  candidates(h: Host): [ActivityId, number][] {
    const ctx = this.ctx(h);
    return ACTIVITY_IDS.filter((id) => !this.cooling(id, h.t))
      .map((id): [ActivityId, number] => [id, CATALOG[id].weight(ctx)])
      .filter(([, w]) => w > 0);
  }

  /** Peso de la opción «actividad» al decidir qué hacer (0 = ninguna). */
  offerWeight(h: Host): number {
    if (!h.settings.activities || h.t - this.lastEnd < GLOBAL_GAP_S) return 0;
    return this.candidates(h).length ? OFFER_WEIGHT : 0;
  }

  /** Sortea una actividad y la empieza. */
  pick(h: Host): boolean {
    const list = this.candidates(h);
    return list.length > 0 && this.start(pickWeighted(list, this.rand()), h);
  }

  /** Empieza `id` (sustituye a la que hubiera). `woke`: lo acaban de despertar. */
  start(id: ActivityId, h: Host, opts: { woke?: boolean; limit?: [number, number] | null } = {}): boolean {
    const def = CATALOG[id];
    if (!h.settings.activities || (opts.woke && !def.fromSleep)) return false;
    if (this.run) this.finish(h.t);
    const ctx = this.ctx(h);
    const [lo, hi] = def.dur;
    this.def = def;
    this.limit = opts.limit ?? null;
    const run: ActivityRun = { id, t0: h.t, dur: lo + (hi - lo) * this.rand(), marks: new Set(), data: {}, hovered: false, woke: !!opts.woke, night: ctx.night };
    this.run = run;
    def.begin?.(run, h, this.kit, ctx);
    return true;
  }

  /** Avanza la actividad en curso. Cualquier resultado distinto de "go" la termina. */
  step(h: Host, input: RunnerInput): StepResult {
    const run = this.run;
    const def = this.def;
    if (!run || !def) return "idle";
    const tt = h.t - run.t0;
    run.hovered = input.hovered;
    const inp = { tt, dt: input.dt, cursor: input.cursor, hovered: input.hovered, music: this.music };
    let r: StepResult = input.chat !== "none" ? "idle" : def.step(run, h, this.kit, inp);
    if (r === "go" && tt > def.dur[1] + HARD_CAP_S) r = "idle";
    if (r !== "go") this.finish(h.t);
    return r;
  }

  /** La corta (arrastre, caída, vuelo…): recoge sus accesorios, conserva los objetos del mundo. */
  abort(t: number) {
    if (this.run) this.finish(t);
  }

  private finish(t: number) {
    if (this.def) this.until.set(this.def.id, t + this.def.cooldownS);
    this.lastEnd = t;
    this.run = null;
    this.def = null;
    this.limit = null;
  }

  pose(p: Pose, h: Host) {
    return this.run && this.def ? this.def.pose(this.run, h.t - this.run.t0, p) : null;
  }

  props(h: Host): PropSet[] {
    return this.run && this.def?.props ? this.def.props(this.run, h.t - this.run.t0) : [];
  }

  line(h: Host): FishLine | null {
    return this.run && this.def?.line ? this.def.line(this.run, h.t - this.run.t0) : null;
  }

  /** Clic sobre Pupus durante la actividad: true si lo consume. */
  poke(h: Host): boolean {
    return !!(this.run && this.def?.poke?.(this.run, h, this.kit));
  }

  /** Objetos del mundo y sus sucesos. */
  tick(dt: number, input: RunnerInput, h: Host) {
    if (!this.items.length) return;
    const env = { cursor: input.cursor, plats: h.plats, W: h.W, H: h.H };
    const { items, events } = stepItems(this.items, dt, env);
    this.items = items;
    for (const e of events) this.react(e, h);
  }

  /** Actividad pedida por el entorno (música), o null. */
  takeRequest(dt: number, h: Host): ActivityId | null {
    if (!this.music || !h.settings.activities || !h.settings.music_dance || this.run) return null;
    if (h.t - this.lastEnd < REQUEST_GAP_S || this.cooling("bailar", h.t)) return null;
    return this.rand() < (DANCE_PER_MIN * dt) / 60 ? "bailar" : null;
  }

  /** «Capturas: …» para el menú, o null. */
  catchSummary(): string | null {
    return catchSummary(this.catches);
  }

  private react(e: ItemEvent, h: Host) {
    if (e.kind === "bubblePop") {
      h.effects.push({ kind: "ring", x: e.x, y: e.y, vx: 0, vy: 0, age: 0, life: 0.3 });
      h.happyUntil = h.t + 0.8;
      if (++this.pops % 3 === 0) {
        h.floatUp("heart", 2);
        h.mood = nudge(h.mood, { happy: 0.1 });
      }
    } else {
      if (e.dist > 600) h.showIcon("heart", 1.4);
      else if (e.dist < 150) h.showIcon("cloud", 1.4);
    }
  }

  private spawn(it: NewItem): number {
    const id = this.nextId++;
    // Con el tope lleno se descarta el más antiguo.
    const items = this.items.length >= MAX_ITEMS ? this.items.slice(1) : this.items;
    this.items = [...items, { ...it, id, age: 0, landed: it.landed ?? false, x0: it.x }];
    return id;
  }

  private moveX(a: Actor, dx: number): boolean {
    const [lo0, hi0] = a.surfaceBounds();
    const lo = this.limit ? Math.max(lo0, this.limit[0]) : lo0;
    const hi = this.limit ? Math.min(hi0, this.limit[1]) : hi0;
    if (lo > hi) return false;
    const want = a.x + dx;
    a.x = clamp(want, lo, hi);
    return Math.abs(a.x - want) < 1e-6;
  }

  private record(kind: CatchKind): boolean {
    const first = this.catches[kind] === 0;
    this.catches = addCatch(this.catches, kind);
    this.store.save(this.catches);
    return first;
  }
}
