// Cola de mensajes por sesión como cliente fino del backend (§5.2, F9, COLA-03):
// la cola vive en `cola.rs`, una por sesión, y llega por `sesiones://queue`.
// Ninguna ventana vacía la cola: el drenaje lo hace el backend, de uno en uno
// al terminar cada turno. Aquí solo se piden las operaciones y se aplica la
// instantánea que devuelven. La clave antigua de localStorage se sube una vez.

import { useMemo } from "react";
import type { SesionesApi } from "./api";
import { itemKind } from "./components/composer/submit";
import { visibleQueue } from "./echo";
import { store, useSession } from "./store";
import type { QueueItem, QueueItemInput, QueueItemPatch, SessionId } from "./types";

export const LEGACY_STORAGE_KEY = "ultron.sesiones.queue";

/** Elementos visibles en el panel de la cola (en cola o fallidos), en el orden del backend. */
export function useQueue(sessionId: SessionId): QueueItem[] {
  const items = useSession(sessionId).queue;
  return useMemo(() => visibleQueue(items), [items]);
}

function apply(id: SessionId, items: QueueItem[]): QueueItem[] {
  store.dispatch({ type: "queue", id, items });
  return items;
}

export async function enqueueItem(api: SesionesApi, id: SessionId, item: QueueItemInput): Promise<QueueItem[]> {
  return apply(id, await api.queueEnqueue({ id, item }));
}

export async function updateItem(api: SesionesApi, id: SessionId, clientId: string, patch: QueueItemPatch): Promise<QueueItem[]> {
  return apply(id, await api.queueUpdate({ id, clientId, patch }));
}

export async function removeItem(api: SesionesApi, id: SessionId, clientId: string): Promise<QueueItem[]> {
  return apply(id, await api.queueRemove({ id, clientId }));
}

export async function moveItem(api: SesionesApi, id: SessionId, clientId: string, toIndex: number): Promise<QueueItem[]> {
  return apply(id, await api.queueMove({ id, clientId, toIndex }));
}

/** Con `clientId`, ese elemento; sin él, todos («Enviar todos ya»). */
export async function sendNow(api: SesionesApi, id: SessionId, clientId?: string): Promise<QueueItem[]> {
  return apply(id, await api.queueSendNow({ id, clientId }));
}

export async function retryItem(api: SesionesApi, id: SessionId, clientId: string): Promise<QueueItem[]> {
  return apply(id, await api.queueRetry({ id, clientId }));
}

export async function loadQueue(api: SesionesApi, id: SessionId): Promise<QueueItem[]> {
  return apply(id, await api.queueList(id));
}

/** Posición absoluta en la cola completa del backend de un movimiento relativo entre los visibles. */
export function targetIndex(all: readonly QueueItem[], clientId: string, dir: -1 | 1): number | null {
  const visible = visibleQueue(all);
  const i = visible.findIndex((q) => q.clientId === clientId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= visible.length) return null;
  return all.findIndex((q) => q.clientId === visible[j].clientId);
}

/** Texto que recibe Claude para delegar el mensaje en un subagente. */
export function delegateText(text: string): string {
  return [
    "Delega esta tarea en un subagente en segundo plano (herramienta Agent con run_in_background y el",
    "especialista que mejor encaje) y sigue con lo tuyo; avísame con el resultado cuando termine:",
    "",
    text,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Migración única desde localStorage (§5.2)
// ---------------------------------------------------------------------------

interface LegacyItem {
  id?: unknown;
  clientId?: unknown;
  text?: unknown;
  delegate?: unknown;
  attachments?: unknown;
}

/** `clientId` estable para un elemento antiguo: el suyo o uno derivado de texto, sesión y posición. */
export function legacyClientId(sessionId: SessionId, item: LegacyItem, index: number): string {
  if (typeof item.clientId === "string" && item.clientId) return item.clientId;
  const seed = `${sessionId}|${index}|${typeof item.id === "string" ? item.id : ""}|${typeof item.text === "string" ? item.text : ""}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return `legacy-${(h >>> 0).toString(16)}`;
}

function legacyPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => (a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string" ? [(a as { path: string }).path] : []));
}

/** Elementos a subir: solo de sesiones vivas, solo rutas de adjuntos (sin vistas previas). */
export function legacyInputs(raw: string | null, alive: readonly SessionId[]): { id: SessionId; item: QueueItemInput }[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const out: { id: SessionId; item: QueueItemInput }[] = [];
  for (const [id, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!alive.includes(id) || !Array.isArray(list)) continue;
    list.forEach((q: LegacyItem, i) => {
      const text = typeof q.text === "string" ? q.text : "";
      const attachments = legacyPaths(q.attachments);
      if (!text && attachments.length === 0) return;
      out.push({ id, item: { clientId: legacyClientId(id, q, i), text, attachments, delegate: q.delegate === true, kind: itemKind(text, null, attachments.length > 0) } });
    });
  }
  return out;
}

/** Sube la cola antigua al backend y borra la clave; un fallo se informa y la clave se conserva. */
export async function migrateLegacyQueue(api: SesionesApi, alive: readonly SessionId[], storage: Storage = localStorage): Promise<number> {
  let inputs: { id: SessionId; item: QueueItemInput }[];
  try {
    inputs = legacyInputs(storage.getItem(LEGACY_STORAGE_KEY), alive);
  } catch (e) {
    storage.removeItem(LEGACY_STORAGE_KEY);
    throw new Error(`La cola antigua guardada en este equipo no se pudo leer y se ha descartado: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const { id, item } of inputs) await enqueueItem(api, id, item);
  storage.removeItem(LEGACY_STORAGE_KEY);
  return inputs.length;
}
