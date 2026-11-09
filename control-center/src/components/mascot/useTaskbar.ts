// Mascota — ir hasta un botón de la barra de tareas y señalarlo
// (lógica pura en taskbar.ts; lectura por UIA en src-tauri/src/mascot/).
//
// La instantánea llega con `mascot_taskbar` al arrancar y con
// `mascot:taskbar` cada vez que cambia. `mascot:attention` (una app hace
// parpadear su botón, shellhook.rs) lleva a Pupus a señalarlo, como mucho
// una vez cada ATTENTION_COOLDOWN_MS por app. En silencio de juego no hace
// nada y lo dice ('silencio'); con el ajuste `taskbar_hints` apagado,
// tampoco ('desactivado').

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MascotEngine } from "./engine";
import type { Navigator } from "./navigator";
import type { Decor } from "./render";
import type { MascotSettings } from "./settings";
import { toCssPoint, type Env } from "./screens";
import { findButton, floorTarget, islandOf, type ButtonQuery, type PointResult, type TaskbarSnapshot } from "./taskbar";

const POINT_MS = 4000;
const ATTENTION_COOLDOWN_MS = 20_000;

interface Deps {
  ready: boolean;
  engineRef: MutableRefObject<MascotEngine | null>;
  envRef: MutableRefObject<Env | null>;
  navRef: MutableRefObject<Navigator | null>;
  decor: Decor;
  quietRef: MutableRefObject<boolean>;
  settingsRef: MutableRefObject<MascotSettings>;
}

export type PointAt = (q: ButtonQuery) => Promise<PointResult>;

async function loadSnapshot(force: boolean): Promise<TaskbarSnapshot | null> {
  try {
    return await invoke<TaskbarSnapshot>("mascot_taskbar", { force });
  } catch {
    return null;
  }
}

export function useTaskbar({ ready, engineRef, envRef, navRef, decor, quietRef, settingsRef }: Deps): PointAt {
  const snapRef = useRef<TaskbarSnapshot | null>(null);

  const pointAt = useCallback<PointAt>(
    async (q) => {
      if (quietRef.current) return "silencio";
      if (!settingsRef.current.taskbar_hints) return "desactivado";
      const env = envRef.current;
      const nav = navRef.current;
      if (!snapRef.current) snapRef.current = await loadSnapshot(true);
      const here = env ? { x: env.origin_x + 1, y: env.origin_y + 1 } : null;
      const hit = findButton(snapRef.current, q, here);
      if (!hit || !nav) return "sin-boton";
      const island = settingsRef.current.taskbar_islands ? islandOf(snapRef.current, hit.button) : null;
      const target = floorTarget(hit.button, hit.bar, island);
      if (!target.ok) {
        engineRef.current?.showIcon("question", 1.6);
        return target.reason;
      }
      nav.walkTo(target.x, target.y, () => {
        const now = envRef.current;
        const eng = engineRef.current;
        if (!now || !eng || quietRef.current) return;
        eng.showIcon("exclaim", 1.2);
        if (target.arrowX === null) return;
        decor.pointer = { x: toCssPoint(now, target.arrowX, now.origin_y).x, until: performance.now() + POINT_MS };
      });
      return "ok";
    },
    [engineRef, envRef, navRef, decor, quietRef, settingsRef],
  );

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const unlisten: (() => void)[] = [];
    const lastAttention = new Map<string, number>();
    void loadSnapshot(false).then((s) => {
      if (alive && s) snapRef.current = s;
    });
    void listen<TaskbarSnapshot>("mascot:taskbar", (e) => {
      snapRef.current = e.payload;
    }).then((u) => (alive ? unlisten.push(u) : u()));
    void listen<{ app_id: string; label: string }>("mascot:attention", (e) => {
      const now = Date.now();
      const key = e.payload.app_id || e.payload.label;
      if (now - (lastAttention.get(key) ?? 0) < ATTENTION_COOLDOWN_MS) return;
      lastAttention.set(key, now);
      void pointAt({ appId: e.payload.app_id || undefined, label: e.payload.label });
    }).then((u) => (alive ? unlisten.push(u) : u()));
    return () => {
      alive = false;
      unlisten.forEach((u) => u());
    };
  }, [ready, pointAt]);

  return pointAt;
}
