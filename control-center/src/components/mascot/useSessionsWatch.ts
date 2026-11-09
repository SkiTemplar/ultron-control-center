// Mascota — sondeo de Sessions y clic para ir allí (lógica en sessionsWatch.ts).
//
// Pregunta `sesiones_list` cada pocos segundos (comando de solo lectura de
// Sessions; los eventos `sesiones://…` no llegan a la ventana de la
// mascota). Con un aviso nuevo, Pupus hace su gesto; mientras siga
// pendiente, repite el icono de vez en cuando. Un clic en Pupus con un
// aviso pendiente enfoca esa sesión (`sesiones_focus_session`; si falla,
// abre Sessions en su proyecto con `sesiones_open_window`).
//
// Con un aviso nuevo y la ventana de Sessions fuera de primer plano, Pupus
// va a señalar su botón en la barra de tareas (AUMID «ULTRON.Sessions»),
// salvo en las esperas de permiso y confianza: esas las pide en su propio
// chat (useApprovals.ts) y no se mueve de donde está.
// En silencio de juego no avisa: el aviso queda pendiente y se da al salir.

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MascotEngine } from "./engine";
import type { ForegroundState } from "./useForeground";
import type { PointAt } from "./useTaskbar";
import {
  alertHint,
  cueFor,
  diffSessions,
  nextPending,
  type ActionableAlert,
  type Pending,
  type WatchedSession,
} from "./sessionsWatch";
import { sessionEpisode } from "./episodes";

export const SESSIONS_POLL_MS = 2500;
/** Cada cuánto se recuerda un aviso pendiente (solo el icono). */
const REMIND_MS = 12_000;
/** AUMID de la ventana de Sessions (su botón propio en la barra). */
export const SESSIONS_APP_ID = "ULTRON.Sessions";

interface WatchState {
  prev: WatchedSession[] | null;
  pending: Pending | null;
  lastCueMs: number;
  /** Un aviso nuevo llegó en silencio: se da como nuevo al salir. */
  missed: boolean;
}

export interface SessionsWatchOpts {
  quietRef: MutableRefObject<boolean>;
  fgRef: MutableRefObject<ForegroundState | null>;
  pointAt: PointAt;
}

/** Espera de permiso o confianza: la pide el chat de Pupus, no se va a Sessions. */
export function asksInChat(a: ActionableAlert | null | undefined): boolean {
  return a?.kind === "waiting" && (a.waitKind === "permission" || a.waitKind === "trust");
}

function cue(eng: MascotEngine | null, p: Pending, reminder: boolean) {
  if (!eng) return;
  const c = cueFor(p.alert, reminder);
  eng.showIcon(c.glyph, 2.2);
  if (c.emote && eng.isGrounded()) eng.play(c.emote);
}

/** Una vuelta de sondeo: compara, actualiza el aviso pendiente y avisa. */
function step(
  st: WatchState,
  list: WatchedSession[],
  eng: MascotEngine | null,
  hit: HTMLElement | null,
  quiet: boolean,
  onFresh: () => void,
) {
  const now = Date.now();
  const alerts = diffSessions(st.prev, list, now);
  // También le cambian el ánimo (orgullo, susto, curiosidad), sin gesto extra.
  for (const a of alerts) {
    const k = sessionEpisode(a.kind);
    if (k) eng?.feel(k, false);
  }
  const before = st.pending;
  st.prev = list;
  st.pending = nextPending(before, alerts, list, now);
  if (hit) hit.title = st.pending ? alertHint(st.pending.alert) : "";
  if (!st.pending) {
    st.missed = false;
    return;
  }
  const fresh = st.pending !== before || st.missed;
  if (quiet) {
    st.missed = fresh;
    return;
  }
  if (fresh || now - st.lastCueMs >= REMIND_MS) {
    cue(eng, st.pending, !fresh);
    if (fresh) onFresh();
    st.missed = false;
    st.lastCueMs = now;
  }
}

/**
 * Clic con un aviso: enfoca esa sesión; si Sessions no la conoce ya, abre
 * Sessions en su proyecto.
 */
export async function goToSession(p: Pending): Promise<void> {
  const s = p.alert.session;
  try {
    await invoke("sesiones_focus_session", { sessionId: s.id, window: null });
  } catch {
    await invoke("sesiones_open_window", { projectId: s.projectId });
  }
}

/**
 * Vigila Sessions. `takeClick` devuelve true si el clic era para un aviso;
 * `hasPending` dice si hay uno (manda sobre los de builds, useDeskAlerts).
 */
export function useSessionsWatch(
  ready: boolean,
  engineRef: MutableRefObject<MascotEngine | null>,
  hitRef: MutableRefObject<HTMLDivElement | null>,
  { quietRef, fgRef, pointAt }: SessionsWatchOpts,
): { takeClick: () => boolean; hasPending: () => boolean } {
  const stRef = useRef<WatchState>({ prev: null, pending: null, lastCueMs: 0, missed: false });

  useEffect(() => {
    if (!ready) return;
    let busy = false;
    const poll = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const list = await invoke<WatchedSession[]>("sesiones_list");
        const onFresh = () => {
          if (asksInChat(stRef.current.pending?.alert)) return;
          if (fgRef.current?.app_id !== SESSIONS_APP_ID) void pointAt({ appId: SESSIONS_APP_ID });
        };
        step(stRef.current, list, engineRef.current, hitRef.current, quietRef.current, onFresh);
      } catch {
        /* Sessions no responde este ciclo: se reintenta en el siguiente */
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, SESSIONS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [ready, engineRef, hitRef, quietRef, fgRef, pointAt]);

  const takeClick = useCallback(() => {
    const st = stRef.current;
    const p = st.pending;
    if (!p) return false;
    st.pending = null;
    if (hitRef.current) hitRef.current.title = "";
    goToSession(p).catch(() => {
      // No se pudo abrir: que se note (y el aviso vuelve a quedar pendiente).
      st.pending = p;
      engineRef.current?.showIcon("sweat", 1.6);
    });
    return true;
  }, [engineRef, hitRef]);

  const hasPending = useCallback(() => stRef.current.pending !== null, []);

  return { takeClick, hasPending };
}
