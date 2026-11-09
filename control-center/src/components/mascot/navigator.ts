// Mascota — navegación entre monitores y «ven aquí» (Ctrl+Alt+clic).
//
// Una vez por fotograma (`tick`) mira el cursor GLOBAL (px físicos):
//   * Ctrl+Alt+clic → Pupus va a ese punto (andando/saltando o volando). Si
//     el punto está en otro monitor, vuela hacia ese borde, cruza y sigue.
//     Además se pregunta a Rust si bajo el punto hay un fichero del
//     Explorador: si lo hay, al llegar lo coge.
//   * El motor pide cruzar un borde (`exitRequest`) → muda la ventana al
//     monitor de al lado y lo hace entrar por el lado contrario.
//   * Arrastrándolo, o mientras el MCP de escritorio lo conduce, el cursor
//     sale del monitor → la ventana se muda allí (si no, Pupus volaría
//     fuera de su lienzo y desaparecería).
//   * `walkTo` (useTaskbar.ts): el mismo viaje sin preguntar al Explorador,
//     con un aviso al llegar.

import { invoke } from "@tauri-apps/api/core";
import type { MascotEngine, Side } from "./engine";
import {
  acrossEdge,
  exitsFor,
  insideEnv,
  reachablePoint,
  shouldHopWithCursor,
  sideToward,
  toCssPoint,
  type Env,
  type ScreenInfo,
} from "./screens";

export interface RawCursor {
  x: number;
  y: number;
  ctrl: boolean;
  alt: boolean;
  lbutton: boolean;
}

interface Deps {
  engine: () => MascotEngine | null;
  env: () => Env | null;
  /** La ventana se ha mudado: nuevo Env para el motor y el canvas. */
  applyEnv: (env: Env) => void;
  /** Ha llegado hasta un fichero: cogerlo y abrir el chat. */
  onFileArrived: (path: string) => void;
  /** Silencio de juego: dentro de un juego, Ctrl+Alt+clic es accidental. */
  quiet?: () => boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Tope mínimo de saltos de monitor por viaje antes de darlo por imposible. Con N
 * monitores en fila bastan N − 1; más es un rebote (red por si el destino
 * sigue sin poder alcanzarse).
 */
const MIN_TRIP_HOPS = 3;

export class Navigator {
  screens: ScreenInfo[] = [];
  private hopping = false;
  private prevDown = false;
  /** Destino físico pendiente en otro monitor. */
  private pending: { x: number; y: number } | null = null;
  /** Viaje actual: id para descartar respuestas viejas del Explorador. */
  private trip = 0;
  private tripFile: string | null = null;
  private tripArrived = false;
  /** Último viaje que llegó a su destino final (no al borde de un monitor). */
  private landedTrip = 0;
  /** Monitores cruzados en el viaje actual. */
  private tripHops = 0;
  /** Al llegar a un destino de `walkTo`. */
  private onArrive: (() => void) | null = null;

  constructor(private deps: Deps) {}

  async refreshScreens() {
    try {
      this.screens = await invoke<ScreenInfo[]>("mascot_screens");
    } catch {
      this.screens = [];
    }
    this.updateExits();
  }

  private updateExits() {
    const env = this.deps.env();
    const eng = this.deps.engine();
    if (env && eng) eng.exits = exitsFor(env, this.screens);
  }

  /**
   * `blocked`: el clic cae sobre la propia mascota o sus bocadillos (no es
   * un «ven aquí»).
   */
  tick(c: RawCursor | null, blocked: boolean) {
    const eng = this.deps.engine();
    const env = this.deps.env();
    if (!eng || !env) return;

    const down = !!c?.lbutton;
    const summon = c && down && !this.prevDown && c.ctrl && c.alt && !blocked;
    if (summon && !this.deps.quiet?.()) this.summonTo(c.x, c.y);
    this.prevDown = down;

    if (eng.exitRequest && !this.hopping) void this.hopAcross(eng.exitRequest.side, eng.exitRequest.y);

    if (c && !this.hopping && shouldHopWithCursor(eng.mode, env, c, this.screens)) void this.hopTo(c.x, c.y);

    if (eng.takeArrival()) {
      this.tripArrived = true;
      if (!this.pending) this.landedTrip = this.trip;
      this.deliverFile();
      this.arrive();
    }
  }

  /** Va al punto físico (px, py), cruzando de monitor si hace falta. Devuelve el id del viaje. */
  walkTo(px: number, py: number, onArrive?: () => void): number {
    const id = this.startTrip(px, py);
    this.onArrive = onArrive ?? null;
    this.steer();
    return id;
  }

  /** Viaje en curso (o el último): otro viaje posterior lo cambia. */
  currentTrip(): number {
    return this.trip;
  }

  /** Último viaje que llegó a su destino final. */
  arrivedTrip(): number {
    return this.landedTrip;
  }

  private startTrip(px: number, py: number): number {
    this.tripFile = null;
    this.tripArrived = false;
    this.onArrive = null;
    this.pending = { x: px, y: py };
    this.tripHops = 0;
    return ++this.trip;
  }

  /** Solo cuenta la llegada al destino final, no al borde de un monitor. */
  private arrive() {
    const done = this.onArrive;
    if (!done || this.pending) return;
    this.onArrive = null;
    done();
  }

  private summonTo(px: number, py: number) {
    const id = this.startTrip(px, py);
    invoke<string | null>("mascot_file_at", { x: px, y: py })
      .then((path) => {
        if (id !== this.trip || !path) return;
        this.tripFile = path;
        this.deliverFile();
      })
      .catch(() => {
        /* sin Explorador bajo el punto: solo viaja */
      });
    this.steer();
  }

  private deliverFile() {
    if (!this.tripArrived || !this.tripFile) return;
    const path = this.tripFile;
    this.tripFile = null;
    this.deps.onFileArrived(path);
  }

  /** Lleva a Pupus hacia el destino pendiente (o hacia su monitor). */
  private steer() {
    const eng = this.deps.engine();
    const env = this.deps.env();
    if (!eng || !env || !this.pending) return;
    // Destino fuera de toda área de trabajo: al punto alcanzable más cercano.
    const t = reachablePoint(this.screens, this.pending.x, this.pending.y) ?? this.pending;
    this.pending = t;
    if (insideEnv(env, t.x, t.y)) {
      this.pending = null;
      const p = toCssPoint(env, t.x, t.y);
      eng.goTo(p.x, p.y);
      return;
    }
    // Otro monitor: volar hacia el borde que lleva a él, a una altura con paso.
    const side = sideToward(env, t.x);
    const spans = eng.exits[side];
    if (!spans.length) {
      this.pending = null; // no hay camino (monitor no adyacente)
      this.onArrive = null;
      return;
    }
    const wantY = toCssPoint(env, t.x, t.y).y;
    const [a, b] = spans.reduce((best, s) =>
      Math.abs(clamp(wantY, s[0], s[1]) - wantY) < Math.abs(clamp(wantY, best[0], best[1]) - wantY) ? s : best,
    );
    const y = clamp(wantY, a + eng.height, b - 4);
    eng.flyTo(side === "right" ? eng.W + eng.halfW * 4 : -eng.halfW * 4, y, null);
  }

  private async hopAcross(side: Side, cssY: number) {
    const env = this.deps.env();
    const eng = this.deps.engine();
    if (!env || !eng) return;
    const mid = cssY - eng.height / 2;
    const p = acrossEdge(env, side, mid);
    const physFeetY = env.origin_y + cssY * env.scale_factor;
    const moved = await this.hopTo(p.x, p.y);
    const now = this.deps.env();
    if (!moved || !now) {
      eng.exitRequest = null;
      eng.exits = { ...eng.exits, [side]: [] }; // ese paso no existe: pared
      return;
    }
    eng.enterFrom(side, (physFeetY - now.origin_y) / now.scale_factor);
    if (this.pending && ++this.tripHops >= Math.max(MIN_TRIP_HOPS, this.screens.length)) {
      this.giveUp(now, eng);
      return;
    }
    this.steer();
  }

  /** Rebota entre monitores sin llegar: se queda en este, lo más cerca posible. */
  private giveUp(env: Env, eng: MascotEngine) {
    const t = this.pending;
    this.pending = null;
    this.onArrive = null;
    if (!t) return;
    const p = toCssPoint(env, t.x, t.y);
    eng.goTo(p.x, clamp(p.y, eng.height, env.height / env.scale_factor));
  }

  private async hopTo(px: number, py: number): Promise<boolean> {
    this.hopping = true;
    try {
      const env = await invoke<Env>("mascot_move_to_screen", { x: Math.round(px), y: Math.round(py) });
      this.deps.applyEnv(env);
      await this.refreshScreens();
      return true;
    } catch {
      return false;
    } finally {
      this.hopping = false;
    }
  }
}
