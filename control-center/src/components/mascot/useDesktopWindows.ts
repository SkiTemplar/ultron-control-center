// Mascota — ventanas del escritorio → plataformas y paredes del motor.
//
// Se refrescan 4 veces por segundo (`mascot_windows`, px físicos) y se
// pasan a px CSS de la ventana de la mascota. Con ellas llegan las ventanas
// de Sessions y su cuadro de texto (`mascot_sessions_surfaces`): el borde
// del cuadro es otra plataforma y los laterales, paredes (sessionsInside.ts). La ventana de un juego en
// silencio (`excludeRef`, useForeground.ts) no cuenta: no se sube a ella y,
// si estaba encima, cae al suelo.
//
// Con `taskbar_islands`, las islas de la barra transparente (taskbar.ts)
// entran como las ventanas más altas: plataforma arriba y paredes a los
// lados, también a ras de suelo (world.ts, floorGaps). La instantánea de la barra se relee cada ISLANDS_MS.

import { useEffect, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MascotEngine, MascotSettings } from "./engine";
import type { WinRect } from "./world";
import type { SessionsInside } from "./sessionsInside";
import { islandRects, type TaskbarSnapshot } from "./taskbar";

interface NativeWin {
  id: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  title: string;
}

/** Espejo de `SessionsSurface` (mascot/sessions_surfaces.rs), px físicos. */
interface NativeSessions {
  hwnd: number;
  composer: { left: number; top: number; right: number; bottom: number } | null;
}

const POLL_MS = 250;
const ISLANDS_MS = 2000;

type ToCss = (px: number, py: number) => { x: number; y: number };

/** Islas como ventanas (id negativo: no es un HWND; `isTaskbarIsland` las distingue de los cuadros de texto de Sessions), en px CSS. Pura. */
export function islandWins(snap: TaskbarSnapshot | null, toCss: ToCss): WinRect[] {
  return islandRects(snap).map((r, i) => ({
    id: -1 - i,
    ...rectToCss({ left: r[0], top: r[1], right: r[2], bottom: r[3] }, toCss),
    isTaskbarIsland: true,
  }));
}

/** Rectángulo en px físicos → px CSS de la ventana de la mascota. */
function rectToCss(r: { left: number; top: number; right: number; bottom: number }, toCss: ToCss) {
  const a = toCss(r.left, r.top);
  const b = toCss(r.right, r.bottom);
  return { left: a.x, top: a.y, right: b.x, bottom: b.y };
}

/** Ventanas de Sessions en px CSS; si el backend no responde, ninguna. */
export async function fetchSessionsInside(toCss: ToCss): Promise<SessionsInside[]> {
  try {
    const list = await invoke<NativeSessions[]>("mascot_sessions_surfaces");
    return list.map((s) => ({ id: s.hwnd, composer: s.composer ? rectToCss(s.composer, toCss) : null }));
  } catch {
    return [];
  }
}

export function useDesktopWindows(
  ready: boolean,
  engineRef: MutableRefObject<MascotEngine | null>,
  settingsRef: MutableRefObject<MascotSettings>,
  toCss: ToCss,
  excludeRef: MutableRefObject<number | null>,
) {
  useEffect(() => {
    if (!ready) return;
    let busy = false;
    let bar: { snap: TaskbarSnapshot | null; at: number } = { snap: null, at: -Infinity };
    const islands = async (on: boolean): Promise<WinRect[]> => {
      if (!on) return [];
      if (performance.now() - bar.at >= ISLANDS_MS) {
        const snap = await invoke<TaskbarSnapshot>("mascot_taskbar", { force: false }).catch(() => bar.snap);
        bar = { snap, at: performance.now() };
      }
      return islandWins(bar.snap, toCss);
    };
    const timer = window.setInterval(async () => {
      const s = settingsRef.current;
      const eng = engineRef.current;
      if (!eng || busy || !(s.climb_windows || s.collide_windows)) return;
      busy = true;
      try {
        const skip = excludeRef.current;
        const [list, inside, top] = await Promise.all([
          invoke<NativeWin[]>("mascot_windows"),
          fetchSessionsInside(toCss),
          islands(s.taskbar_islands),
        ]);
        const wins: WinRect[] = list.filter((w) => w.id !== skip).map((w) => ({ id: w.id, ...rectToCss(w, toCss) }));
        const rects = [...top, ...wins];
        const onArea = rects.filter((r) => r.right > 0 && r.left < eng.W && r.bottom > 0 && r.top < eng.H);
        eng.setWindows(onArea, inside);
      } catch {
        /* sin ventanas este ciclo */
      } finally {
        busy = false;
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [ready, engineRef, settingsRef, toCss, excludeRef]);
}
