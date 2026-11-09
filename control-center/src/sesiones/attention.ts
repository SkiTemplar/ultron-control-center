// Avisos de atención: cuando un turno termina o Claude pide respuesta (pregunta,
// permiso o plan) y ninguna ventana de Sessions tiene el foco, la barra de
// tareas parpadea y sale una notificación de Windows. El parpadeo se cancela al
// enfocar la ventana.
//
// Solo reacciona a los eventos en vivo (`sesiones://turn` y `sesiones://ask`),
// nunca al store: la rehidratación del historial y las preguntas recuperadas al
// arrancar (`pendingAsks`) no pasan por aquí. Hasta que `armAttention` se llama
// al final del arranque no avisa de nada, descarta lo fechado antes de armarse
// (eventos repetidos al restaurar sesiones) y avisa una sola vez por turno o
// pregunta. Sin timers: el único listener es el `focus` de la ventana, uno solo.
//
// El toast va por `tauri-plugin-notification` invocando su comando directamente:
// la Web Notification API de WebView2 depende de su diálogo de permiso, y el
// `sendNotification` del paquete npm pasa por `window.Notification` y se traga
// los errores.

import { invoke } from "@tauri-apps/api/core";
import { UserAttentionType, getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { prefsStore } from "./prefs";
import { store } from "./store";
import type { AskEvent, SessionId, TurnPayload } from "./types";

/** Margen para descartar eventos fechados antes de armar los avisos. */
export const STALE_MS = 10_000;
/** Tope de claves recordadas para no avisar dos veces (las más antiguas salen). */
const MAX_SEEN = 256;
const SESSIONS_LABEL = /^sesiones(-|$)/;

const TURN_TEXT: Partial<Record<TurnPayload["reason"], string>> = {
  answer: "Turno terminado",
  refusal: "Turno terminado",
  error: "El turno terminó con error",
};

const ASK_TEXT: Record<AskEvent["kind"], string> = {
  question: "Pregunta pendiente",
  permission: "Permiso pendiente",
  plan: "Plan pendiente de aprobar",
};

/** Estados de la cola con los que el turno siguiente arranca solo. */
const PENDING_QUEUE = new Set(["queued", "sending", "cliQueued"]);

let armedAt: number | null = null;
let flashing = false;
let focusWired = false;
const seen = new Set<string>();
const failed = new Set<string>();

function remember(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value as string);
  return true;
}

function reportOnce(what: string, e: unknown): void {
  if (failed.has(what)) return;
  failed.add(what);
  const detail = e instanceof Error ? e.message : String(e);
  store.dispatch({ type: "error", message: `No se pudo ${what}: ${detail}` });
}

function onFocus(): void {
  if (!flashing) return;
  flashing = false;
  getCurrentWindow().requestUserAttention(null).catch((e: unknown) => reportOnce("cancelar el parpadeo de la barra de tareas", e));
}

/**
 * Activa los avisos al terminar el arranque. En el modo simulado (navegador sin
 * Tauri) no se arma: no hay barra de tareas ni notificaciones que pedir.
 */
export function armAttention(isMock: boolean, now = Date.now()): void {
  if (isMock || armedAt !== null) return;
  armedAt = now;
  if (focusWired) return;
  focusWired = true;
  window.addEventListener("focus", onFocus);
}

/** ¿Hay que avisar o alguna ventana de Sessions tiene el foco? Además, ¿avisa esta ventana? */
async function shouldThisWindowNotify(): Promise<boolean> {
  if (document.hasFocus()) return false;
  const current = getCurrentWindow();
  const windows = (await getAllWindows()).filter((w) => SESSIONS_LABEL.test(w.label));
  const focused = await Promise.all(windows.map((w) => w.isFocused()));
  if (focused.some(Boolean)) return false;
  if (windows.length === 0) return !(await current.isFocused());
  // Con varias ventanas de Sessions avisa una sola: la principal o, sin ella, la primera.
  const leader = windows.find((w) => w.label === "sesiones") ?? [...windows].sort((a, b) => a.label.localeCompare(b.label))[0];
  return leader.label === current.label;
}

function titleOf(id: SessionId): { title: string; project: string | null } {
  const info = store.getState().sessions.find((s) => s.id === id);
  const title = info?.title?.trim() || info?.projectName?.trim() || "ULTRON Sessions";
  const project = info?.projectName?.trim() || null;
  return { title, project: project && project !== title ? project : null };
}

function isFresh(iso: string | undefined): boolean {
  if (armedAt === null) return false;
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(at) || at >= armedAt - STALE_MS;
}

async function notify(id: SessionId, line: string, critical: boolean): Promise<void> {
  const prefs = prefsStore.getState();
  if (!prefs.attentionFlash && !prefs.attentionToast) return;
  const go = await shouldThisWindowNotify().catch((e: unknown) => {
    reportOnce("comprobar el foco de las ventanas de Sessions", e);
    return false;
  });
  if (!go) return;
  if (prefs.attentionFlash) {
    flashing = true;
    const type = critical ? UserAttentionType.Critical : UserAttentionType.Informational;
    await getCurrentWindow().requestUserAttention(type).catch((e: unknown) => reportOnce("hacer parpadear la barra de tareas", e));
  }
  if (prefs.attentionToast) {
    const { title, project } = titleOf(id);
    const options = { title, body: project ? `${line} · ${project}` : line };
    await invoke("plugin:notification|notify", { options }).catch((e: unknown) => reportOnce("mostrar el aviso de Windows", e));
  }
}

/** Fin de turno en vivo: avisa si la sesión queda a la espera del usuario. */
export async function onTurnAttention(p: TurnPayload): Promise<void> {
  const line = TURN_TEXT[p.reason];
  if (!line || !isFresh(p.endedAt) || !remember(`turn:${p.id}:${p.turnId}`)) return;
  const queue = store.getState().bySession[p.id]?.queue ?? [];
  if (queue.some((q) => PENDING_QUEUE.has(q.state))) return;
  await notify(p.id, line, false);
}

/** Pregunta, permiso o plan en vivo. */
export async function onAskAttention(ask: AskEvent): Promise<void> {
  if (!isFresh(ask.createdAt) || !remember(`ask:${ask.askId}`)) return;
  await notify(ask.id, ASK_TEXT[ask.kind] ?? "Claude espera tu respuesta", true);
}

export function resetAttentionForTests(): void {
  armedAt = null;
  flashing = false;
  seen.clear();
  failed.clear();
}
