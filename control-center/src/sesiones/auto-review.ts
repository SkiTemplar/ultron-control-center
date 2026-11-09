// Segunda opinión automática: con el interruptor de la sesión encendido, un
// turno de Claude que termina tras editar `AUTO_REVIEW_MIN_FILES` ficheros o
// más se manda a Codex para revisarlo en segundo plano. En el chat solo
// aparece si Codex encuentra algo (o si falla); la tarea queda en Motores.
// El interruptor se guarda por conversación (`reviewKey`) en localStorage y
// se sincroniza entre ventanas con el evento `storage`. Con varias ventanas,
// el backend lanza una sola revisión por turno (clave `turnId`).

import { useSyncExternalStore } from "react";
import type { SesionesApi } from "./api";
import {
  AUTO_REVIEW_MIN_FILES,
  editedFiles,
  hasRunningReview,
  isCleanReview,
  mergeFiles,
  parseStoredKeys,
  rememberBounded,
  reviewKey,
  reviewPrompt,
  sanitizeKeys,
} from "./auto-review-core";
import { addNote } from "./bootstrap";
import { engineBlockReason, runEngine } from "./engines";
import { createStore, store } from "./store";
import type { ChatMessage, EngineTask, SessionId, TurnPayload } from "./types";

/** Espera tras el fin del turno: el transcript puede llegar un poco después. */
export const SETTLE_MS = 1500;
export const STORAGE_KEY = "ultron.sesiones.autoReview";

function load(): string[] {
  try {
    return parseStoredKeys(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

const enabledStore = createStore<string[], (s: string[]) => string[]>((s, fn) => fn(s), load());

// Otra ventana cambió el interruptor: se recarga (`key === null` = storage vaciado).
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY && e.key !== null) return;
  const next = e.key === null ? load() : parseStoredKeys(e.newValue);
  enabledStore.dispatch(() => next);
});

export function isAutoReviewOn(key: string): boolean {
  return enabledStore.getState().includes(key);
}

export function setAutoReview(key: string, on: boolean): void {
  enabledStore.dispatch((s) => (on ? sanitizeKeys([...s, key]) : s.filter((k) => k !== key)));
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(enabledStore.getState()));
  } catch (e) {
    store.dispatch({ type: "error", message: `No se pudo guardar la segunda opinión automática: ${String(e)}` });
  }
}

export function useAutoReview(key: string | null): boolean {
  return useSyncExternalStore(enabledStore.subscribe, () => (key ? enabledStore.getState().includes(key) : false));
}

const reviewedTurns = new Set<string>();

function messagesOf(id: SessionId): ChatMessage[] {
  const s = store.getState().bySession[id];
  if (!s) return [];
  return [...s.messages, ...Object.values(s.agentMessages).flat()];
}

/**
 * Ficheros del turno. La ventana recorta los mensajes de los turnos largos y
 * suelta los hilos de subagente cerrados, así que manda la cuenta del backend
 * sobre el transcript; lo que solo tenga la ventana (aún sin escribir en
 * disco) se suma. Si el backend falla, se avisa y se cuenta solo la ventana.
 */
async function turnFiles(api: SesionesApi, p: TurnPayload): Promise<string[]> {
  const local = editedFiles(messagesOf(p.id), p.startedAt);
  try {
    return mergeFiles(await api.turnEdits(p.id, p.startedAt), local);
  } catch (e) {
    addNote(p.id, "warn", `Segunda opinión automática: no se pudo leer el transcript (${String(e)}); se cuentan solo los mensajes de la ventana.`);
    return local;
  }
}

/** Fin de turno: si toca, lanza la revisión de Codex. Devuelve la tarea o `null`. */
export async function maybeAutoReview(api: SesionesApi, p: TurnPayload, wait = SETTLE_MS): Promise<EngineTask | null> {
  const info = store.getState().sessions.find((s) => s.id === p.id);
  if (!info || p.reason !== "answer" || !isAutoReviewOn(reviewKey(info))) return null;
  if (reviewedTurns.has(p.turnId)) return null;
  rememberBounded(reviewedTurns, p.turnId);
  if (wait > 0) await new Promise((r) => window.setTimeout(r, wait));
  // Se pudo apagar en otra ventana durante la espera.
  if (!isAutoReviewOn(reviewKey(info))) return null;
  const files = await turnFiles(api, p);
  if (files.length < AUTO_REVIEW_MIN_FILES) return null;
  const blocked = engineBlockReason(store.getState().engineStatus, "codex");
  if (blocked) {
    addNote(p.id, "warn", `Segunda opinión automática omitida: ${blocked}.`);
    return null;
  }
  if (hasRunningReview(store.getState().engines, p.id)) {
    addNote(p.id, "warn", "Segunda opinión automática omitida: ya hay una revisión de Codex en curso en esta sesión.");
    return null;
  }
  return runEngine(api, { sessionId: p.id, engine: "codex", kind: "review", prompt: reviewPrompt(files), includeContext: true, turnId: p.turnId });
}

const notified = new Set<string>();

/** Tarea de motor actualizada: avisa una vez si una revisión automática encontró algo o falló. */
export function onReviewUpdate(t: EngineTask): void {
  if (t.kind !== "review" || !t.sessionId || notified.has(t.id)) return;
  if (t.status !== "done" && t.status !== "error") return;
  rememberBounded(notified, t.id);
  if (t.status === "error") {
    addNote(t.sessionId, "warn", "La segunda opinión automática de Codex falló: el detalle está en Motores.");
    return;
  }
  if (!isCleanReview(t.summary)) addNote(t.sessionId, "warn", "Codex encontró algo en la segunda opinión automática: está en el chat y en Motores.");
}
