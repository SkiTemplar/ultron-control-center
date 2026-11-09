// Marcadores del hilo: mensajes fijados del hilo principal, guardados por
// conversación en localStorage (sobreviven a reinicios de la app). La clave es
// el id de la conversación de Claude y, si aún no existe, el de la sesión. Aquí
// viven las funciones puras, el almacén y el canal «ir al marcador» del chat.

import { useSyncExternalStore } from "react";
import { createStore } from "./store";
import { messageText } from "./timeline";
import type { ChatMessage } from "./types";

export type BookmarkRole = "user" | "assistant";

export interface Bookmark {
  /** uuid del mensaje del transcript. */
  uuid: string;
  /** Extracto del texto (≤ PREVIEW_CHARS caracteres). */
  preview: string;
  role: BookmarkRole;
  /** Momento en que se fijó (ISO 8601). */
  createdAt: string;
}

/** Lo mínimo de `SessionInfo` para elegir la clave de la conversación. */
export interface BookmarkSessionRef {
  id: string;
  claudeSessionId: string | null;
}

export const PREVIEW_CHARS = 80;
/** Tope por conversación: un almacenamiento manipulado no infla la lista sin límite. */
export const MAX_BOOKMARKS = 200;
const STORAGE_PREFIX = "ultron.sesiones.marcadores.";
const EMPTY: readonly Bookmark[] = Object.freeze([]);

/** Clave estable de la conversación: `claudeSessionId` si existe; si no, el id de la sesión. */
export function conversationKey(ref: BookmarkSessionRef): string {
  return ref.claudeSessionId || ref.id;
}

export function storageKey(conversation: string): string {
  return `${STORAGE_PREFIX}${conversation}`;
}

/** El texto en una sola línea (espacios colapsados), recortado con «…». */
export function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

function isBookmark(v: unknown): v is Bookmark {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.uuid === "string" && r.uuid.length > 0 && typeof r.preview === "string"
    && (r.role === "user" || r.role === "assistant") && typeof r.createdAt === "string";
}

/** Normaliza lo leído: entradas inválidas fuera, sin uuid repetido y con tope. */
export function sanitizeBookmarks(raw: unknown): readonly Bookmark[] {
  if (!Array.isArray(raw)) return EMPTY;
  const seen = new Set<string>();
  const out: Bookmark[] = [];
  for (const v of raw) {
    if (!isBookmark(v) || seen.has(v.uuid)) continue;
    seen.add(v.uuid);
    out.push({ uuid: v.uuid, preview: previewOf(v.preview), role: v.role, createdAt: v.createdAt });
    if (out.length >= MAX_BOOKMARKS) break;
  }
  return out.length === 0 ? EMPTY : out;
}

/** JSON corrupto o ausente → lista vacía; nunca lanza. */
export function parseBookmarks(json: string | null): readonly Bookmark[] {
  if (!json) return EMPTY;
  try {
    return sanitizeBookmarks(JSON.parse(json));
  } catch {
    return EMPTY;
  }
}

export function hasBookmark(list: readonly Bookmark[], uuid: string): boolean {
  return list.some((b) => b.uuid === uuid);
}

/** Añade al final; si ya estaba o se llegó al tope, devuelve la misma lista. */
export function addBookmark(list: readonly Bookmark[], entry: Bookmark): readonly Bookmark[] {
  if (hasBookmark(list, entry.uuid) || list.length >= MAX_BOOKMARKS) return list;
  return [...list, entry];
}

/** Quita por uuid; si no estaba, devuelve la misma lista. */
export function removeBookmark(list: readonly Bookmark[], uuid: string): readonly Bookmark[] {
  if (!hasBookmark(list, uuid)) return list;
  const next = list.filter((b) => b.uuid !== uuid);
  return next.length === 0 ? EMPTY : next;
}

export function toggleBookmark(list: readonly Bookmark[], entry: Bookmark): readonly Bookmark[] {
  return hasBookmark(list, entry.uuid) ? removeBookmark(list, entry.uuid) : addBookmark(list, entry);
}

/** Entrada para un mensaje; los del sistema no se fijan (null). */
export function makeBookmark(m: Pick<ChatMessage, "uuid" | "role" | "blocks">, now: Date = new Date()): Bookmark | null {
  if (m.role !== "user" && m.role !== "assistant") return null;
  return { uuid: m.uuid, preview: previewOf(messageText(m as ChatMessage)), role: m.role, createdAt: now.toISOString() };
}

// --- Almacén ----------------------------------------------------------------

export type JumpStatus = "pending" | "done" | "missing";

/** Petición de ir a un mensaje del chat de una sesión; `tick` distingue dos iguales seguidas. */
export interface JumpRequest {
  sessionId: string;
  uuid: string;
  tick: number;
  status: JumpStatus;
}

interface BookmarksState {
  /** Listas ya leídas o modificadas, por conversación. */
  lists: Readonly<Record<string, readonly Bookmark[]>>;
  jump: JumpRequest | null;
}

type BookmarksAction = (s: BookmarksState) => BookmarksState;

export const bookmarksStore = createStore<BookmarksState, BookmarksAction>((s, fn) => fn(s), { lists: {}, jump: null });

/** Lectura perezosa: la primera vez se lee del almacenamiento y se memoriza (referencia estable). */
const readCache = new Map<string, readonly Bookmark[]>();

function readStorage(conversation: string): readonly Bookmark[] {
  try {
    return parseBookmarks(window.localStorage.getItem(storageKey(conversation)));
  } catch {
    return EMPTY;
  }
}

export function bookmarksOf(conversation: string): readonly Bookmark[] {
  const inState = bookmarksStore.getState().lists[conversation];
  if (inState) return inState;
  const cached = readCache.get(conversation);
  if (cached) return cached;
  const loaded = readStorage(conversation);
  readCache.set(conversation, loaded);
  return loaded;
}

/** Escribe en localStorage; `false` si no se pudo (sin almacenamiento o cuota agotada). */
function persist(conversation: string, list: readonly Bookmark[]): boolean {
  try {
    if (list.length === 0) window.localStorage.removeItem(storageKey(conversation));
    else window.localStorage.setItem(storageKey(conversation), JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * Aplica `fn` a la lista de la conversación y la guarda. Devuelve `false` si no
 * se pudo persistir: el cambio queda en memoria y el llamante debe avisar.
 */
export function updateBookmarks(conversation: string, fn: (l: readonly Bookmark[]) => readonly Bookmark[]): boolean {
  const prev = bookmarksOf(conversation);
  const next = fn(prev);
  if (next === prev) return true;
  bookmarksStore.dispatch((s) => ({ ...s, lists: { ...s.lists, [conversation]: next } }));
  return persist(conversation, next);
}

export function useBookmarks(conversation: string | null): readonly Bookmark[] {
  return useSyncExternalStore(bookmarksStore.subscribe, () => (conversation ? bookmarksOf(conversation) : EMPTY));
}

export function useIsBookmarked(conversation: string | null, uuid: string): boolean {
  return useSyncExternalStore(bookmarksStore.subscribe, () => Boolean(conversation && hasBookmark(bookmarksOf(conversation), uuid)));
}

/** Pide ir al mensaje `uuid` del chat de la sesión; devuelve el `tick` de la petición. */
export function requestJump(sessionId: string, uuid: string): number {
  const tick = (bookmarksStore.getState().jump?.tick ?? 0) + 1;
  bookmarksStore.dispatch((s) => ({ ...s, jump: { sessionId, uuid, tick, status: "pending" } }));
  return tick;
}

/** La lista del chat resuelve la petición `tick`; una más nueva no se pisa. */
export function settleJump(tick: number, status: Exclude<JumpStatus, "pending">): void {
  bookmarksStore.dispatch((s) => (s.jump?.tick === tick && s.jump.status === "pending" ? { ...s, jump: { ...s.jump, status } } : s));
}

export function useJump(sessionId: string | null): JumpRequest | null {
  return useSyncExternalStore(bookmarksStore.subscribe, () => {
    const j = bookmarksStore.getState().jump;
    return j && j.sessionId === sessionId ? j : null;
  });
}
