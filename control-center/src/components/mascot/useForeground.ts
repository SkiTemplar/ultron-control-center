// Mascota — lo que tienes delante (desk_watch.rs): gorro, disfraz de juego y
// «no molestar».
//
// El estado llega con `mascot_foreground` al arrancar y con
// `mascot:foreground` cada vez que cambia (Rust solo emite cambios). La
// hora cuenta para el gorro (noche, temporada), así que el aspecto se
// recalcula también cada pocos segundos, sin preguntar nada a Rust.
//
// Silencio (juego delante, lo decide Rust con histéresis de 3 s):
//   * ajustes efectivos sin paseos, saltos ni travesuras (gameMode.ts),
//   * clase `mascot-quiet` en <html>: sin bocadillos, botones ni menú y
//     atravesable (mascot.css),
//   * si el juego va en ventana en su monitor, aparca en el suelo libre y
//     da paseos cortos dentro de ese tramo (el coche rueda sin pisarlo).
//   * El bocadillo de respuesta no caduca mientras dura: se ve al salir.
//   * Disfrazado, a veces hace la actividad del disfraz (catalejo,
//     arrastrarse, conducir) sin salir de ese tramo (activities/outfitActs.ts).

import { useEffect, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MascotEngine } from "./engine";
import { OUTFIT_ACTIVITY } from "./activities/outfitActs";
import { effectiveSettings, freeFloorSpans, parkX, strollX } from "./gameMode";
import { chooseLook, type Foreground } from "./outfits";
import type { Decor } from "./render";
import type { GameEntry, MascotSettings } from "./settings";

export interface ForegroundState extends Foreground {
  hwnd: number;
  /** AUMID de la ventana («ULTRON.Sessions»), o "". */
  app_id: string;
  rect: [number, number, number, number];
  on_mascot_monitor: boolean;
  game: GameEntry | null;
  quiet: boolean;
  reason: "game" | "exclusive_fullscreen" | "borderless" | null;
}

const LOOK_MS = 5000;
const STROLL_MIN_MS = 6000;
const STROLL_SPREAD_MS = 4000;
/** Lo que aguanta el bocadillo de respuesta al salir del juego. */
const REPLY_AFTER_QUIET_MS = 9000;
/** En silencio y disfrazado, probabilidad de que el paseo sea la actividad del disfraz. */
const OUTFIT_ACT_CHANCE = 0.35;

interface Deps {
  ready: boolean;
  engineRef: MutableRefObject<MascotEngine | null>;
  settingsRef: MutableRefObject<MascotSettings>;
  quietRef: MutableRefObject<boolean>;
  replyDeadlineRef: MutableRefObject<number>;
  decor: Decor;
  toCss: (px: number, py: number) => { x: number; y: number };
}

export interface ForegroundRefs {
  fgRef: MutableRefObject<ForegroundState | null>;
  /** HWND del juego en silencio (no se sube a él), o null. */
  gameHwndRef: MutableRefObject<number | null>;
}

/** Reacciona a cada estado nuevo: aspecto, silencio y aparcamiento. */
class ForegroundController {
  constructor(
    private d: Deps,
    private refs: ForegroundRefs,
  ) {}

  updateLook() {
    const eng = this.d.engineRef.current;
    if (!eng) return;
    const st = this.refs.fgRef.current;
    const look = chooseLook(st, st?.game ?? null, new Date(), eng.mode === "sleep");
    eng.setHat(look.hat);
    this.d.decor.outfit = look.body;
    eng.acts.outfit = this.d.settingsRef.current.hats ? look.body : null;
  }

  /** Tramos de suelo libres, o null si no hay juego en su monitor. */
  private freeSpans(): [number, number][] | null {
    const st = this.refs.fgRef.current;
    const eng = this.d.engineRef.current;
    if (!st?.quiet || !st.on_mascot_monitor || !eng) return null;
    const { toCss } = this.d;
    const game = { left: toCss(st.rect[0], st.rect[1]).x, right: toCss(st.rect[2], st.rect[3]).x };
    return freeFloorSpans(eng.W, game, eng.halfW);
  }

  private park() {
    const eng = this.d.engineRef.current;
    const spans = this.freeSpans();
    if (!eng || !spans || eng.isTraveling()) return;
    if (spans.some(([a, b]) => eng.x >= a && eng.x <= b)) return;
    const x = parkX(eng.x, spans);
    if (x !== null) eng.goTo(x, eng.H);
  }

  /** Paseo corto dentro del tramo libre (lo llama un temporizador). */
  stroll() {
    const eng = this.d.engineRef.current;
    const spans = this.freeSpans();
    if (!eng || !spans || eng.isTraveling()) return;
    const body = eng.acts.outfit;
    const span = spans.find(([a, b]) => eng.x >= a - 1 && eng.x <= b + 1);
    if (body && span && Math.random() < OUTFIT_ACT_CHANCE && eng.doActivity(OUTFIT_ACTIVITY[body], span)) return;
    const x = strollX(eng.x, spans, Math.random);
    if (x !== null) eng.strollTo(x);
  }

  apply(st: ForegroundState | null) {
    const { quietRef, engineRef, settingsRef, replyDeadlineRef } = this.d;
    this.refs.fgRef.current = st;
    const quiet = !!st?.quiet;
    this.refs.gameHwndRef.current = quiet && st ? st.hwnd : null;
    if (quiet !== quietRef.current) {
      quietRef.current = quiet;
      document.documentElement.classList.toggle("mascot-quiet", quiet);
      engineRef.current?.setSettings(effectiveSettings(settingsRef.current, quiet));
      if (!quiet) replyDeadlineRef.current = Math.max(replyDeadlineRef.current, performance.now() + REPLY_AFTER_QUIET_MS);
    }
    this.updateLook();
    this.park();
  }
}

export function useForeground(d: Deps): ForegroundRefs {
  const fgRef = useRef<ForegroundState | null>(null);
  const gameHwndRef = useRef<number | null>(null);
  const { ready, engineRef, settingsRef, quietRef, replyDeadlineRef, decor, toCss } = d;

  useEffect(() => {
    if (!ready) return;
    const deps = { ready, engineRef, settingsRef, quietRef, replyDeadlineRef, decor, toCss };
    const ctl = new ForegroundController(deps, { fgRef, gameHwndRef });
    let alive = true;
    let strollTimer = 0;
    const unlisten: (() => void)[] = [];
    void invoke<ForegroundState | null>("mascot_foreground")
      .then((st) => alive && st && ctl.apply(st))
      .catch(() => {
        // Estado inicial: si no llega, el evento `mascot:foreground` lo trae
        // en el siguiente cambio de ventana.
      });
    void listen<ForegroundState>("mascot:foreground", (e) => ctl.apply(e.payload)).then((u) =>
      alive ? unlisten.push(u) : u(),
    );
    const lookTimer = window.setInterval(() => ctl.updateLook(), LOOK_MS);
    const stroll = () => {
      strollTimer = window.setTimeout(stroll, STROLL_MIN_MS + Math.random() * STROLL_SPREAD_MS);
      ctl.stroll();
    };
    stroll();
    return () => {
      alive = false;
      window.clearInterval(lookTimer);
      window.clearTimeout(strollTimer);
      unlisten.forEach((u) => u());
    };
  }, [ready, engineRef, settingsRef, quietRef, replyDeadlineRef, decor, toCss]);

  return { fgRef, gameHwndRef };
}
