// Espacio de trabajo: pestañas de sesiones y rejilla de hasta 2×2 paneles.
// Funciones puras sobre `Workspace` + un almacén pequeño persistido en
// localStorage (ventana principal) o sessionStorage (ventanas adicionales
// `sesiones-<n>`, cada una con su propia disposición).

import { useSyncExternalStore } from "react";
import { createStore } from "./store";
import type { SessionId } from "./types";

export const MAX_PANES = 4;
const STORAGE_KEY = "ultron.sesiones.workspace";

/** Etiqueta de la ventana adicional (`?win=sesiones-<n>`); null en la principal. */
export function extraWindowLabel(search: string = typeof window === "undefined" ? "" : window.location.search): string | null {
  const win = new URLSearchParams(search).get("win");
  return win && /^sesiones-[\w-]+$/.test(win) ? win : null;
}

function storage(): Storage {
  return extraWindowLabel() ? window.sessionStorage : window.localStorage;
}

export type Edge = "left" | "right" | "top" | "bottom";

export interface Pane {
  key: string;
  sessionId: SessionId | null;
  agentId: string | null;
}

export interface Workspace {
  tabs: SessionId[];
  panes: Pane[];
  focused: number;
  /** Orientación de la primera división: `h` lado a lado, `v` uno sobre otro. */
  split: "h" | "v";
}

let paneSeq = 0;
function newKey(): string {
  paneSeq += 1;
  return `p${Date.now().toString(36)}${paneSeq}`;
}

export function makePane(sessionId: SessionId | null, agentId: string | null = null): Pane {
  return { key: newKey(), sessionId, agentId };
}

export const emptyWorkspace: Workspace = { tabs: [], panes: [makePane(null)], focused: 0, split: "h" };

function withTab(tabs: SessionId[], id: SessionId | null): SessionId[] {
  return id && !tabs.includes(id) ? [...tabs, id] : tabs;
}

function clampFocus(ws: Workspace): Workspace {
  const focused = Math.min(Math.max(ws.focused, 0), ws.panes.length - 1);
  return focused === ws.focused ? ws : { ...ws, focused };
}

/**
 * Muestra una sesión (o un subagente suyo) en el panel con foco. Si otro panel ya
 * la muestra, le pasa el foco en vez de duplicarla: dos composers sobre la misma
 * sesión, cada uno con su borrador, no es lo que pide un clic en su pestaña.
 */
export function showInFocused(ws: Workspace, sessionId: SessionId, agentId: string | null = null): Workspace {
  const shown = ws.panes.findIndex((p) => p.sessionId === sessionId && p.agentId === agentId);
  if (shown >= 0) return { ...ws, focused: shown, tabs: withTab(ws.tabs, sessionId) };
  const panes = ws.panes.map((p, i) => (i === ws.focused ? { ...p, sessionId, agentId } : p));
  return { ...ws, panes, tabs: withTab(ws.tabs, sessionId) };
}

/** Añade un panel en el borde indicado; con la rejilla llena, reemplaza el panel con foco. */
export function splitWith(ws: Workspace, sessionId: SessionId | null, edge: Edge = "right", agentId: string | null = null): Workspace {
  if (ws.panes.length >= MAX_PANES) return sessionId ? showInFocused(ws, sessionId, agentId) : ws;
  const pane = makePane(sessionId, agentId);
  const atStart = edge === "left" || edge === "top";
  const panes = atStart ? [pane, ...ws.panes] : [...ws.panes, pane];
  const split = ws.panes.length === 1 ? (edge === "left" || edge === "right" ? "h" : "v") : ws.split;
  return { ...ws, panes, split, focused: atStart ? 0 : panes.length - 1, tabs: withTab(ws.tabs, sessionId) };
}

export function closePane(ws: Workspace, index: number): Workspace {
  if (ws.panes.length <= 1) {
    return { ...ws, panes: [{ ...ws.panes[0], sessionId: null, agentId: null }] };
  }
  const panes = ws.panes.filter((_, i) => i !== index);
  const focused = ws.focused > index ? ws.focused - 1 : ws.focused;
  return clampFocus({ ...ws, panes, focused });
}

export function focusPane(ws: Workspace, index: number): Workspace {
  if (index < 0 || index >= ws.panes.length || index === ws.focused) return ws;
  return { ...ws, focused: index };
}

export function closeTab(ws: Workspace, id: SessionId): Workspace {
  const tabs = ws.tabs.filter((t) => t !== id);
  const panes = ws.panes.map((p) => (p.sessionId === id ? { ...p, sessionId: null, agentId: null } : p));
  return { ...ws, tabs, panes };
}

/**
 * Cerrar una pestaña desde la barra: el panel que la mostraba pasa a la pestaña
 * vecina (la siguiente o, si era la última, la anterior) en vez de quedarse vacío.
 * No duplica una sesión que ya está en otro panel; sin vecina libre queda vacío.
 */
export function closeTabToNeighbor(ws: Workspace, id: SessionId): Workspace {
  const at = ws.tabs.indexOf(id);
  const closed = closeTab(ws, id);
  if (at < 0) return closed;
  const shown = new Set(closed.panes.map((p) => p.sessionId));
  const order = [...closed.tabs.slice(at), ...closed.tabs.slice(0, at).reverse()];
  const free = order.filter((t) => !shown.has(t));
  let next = 0;
  const panes = closed.panes.map((p, i) => {
    if (ws.panes[i]?.sessionId !== id) return p;
    const sessionId = free[next] ?? null;
    next += 1;
    return { ...p, sessionId, agentId: null };
  });
  return { ...closed, panes };
}

export function setPaneTarget(ws: Workspace, index: number, sessionId: SessionId | null, agentId: string | null): Workspace {
  const panes = ws.panes.map((p, i) => (i === index ? { ...p, sessionId, agentId } : p));
  return { ...ws, panes, tabs: withTab(ws.tabs, sessionId) };
}

/** Quita de pestañas y paneles las sesiones que ya no existen. */
export function pruneWorkspace(ws: Workspace, alive: readonly SessionId[]): Workspace {
  const set = new Set(alive);
  const referenced = [...ws.tabs, ...ws.panes.map((p) => p.sessionId)];
  const dead = new Set(referenced.filter((id): id is SessionId => id !== null && !set.has(id)));
  return [...dead].reduce(closeTab, ws);
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

function isWorkspace(v: unknown): v is Workspace {
  if (!v || typeof v !== "object") return false;
  const w = v as Workspace;
  return Array.isArray(w.tabs) && Array.isArray(w.panes) && w.panes.length > 0 && w.panes.length <= MAX_PANES;
}

export function loadWorkspace(): Workspace {
  try {
    const raw = storage().getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!isWorkspace(parsed)) return emptyWorkspace;
    return clampFocus({ ...parsed, panes: parsed.panes.map((p) => ({ key: newKey(), sessionId: p.sessionId ?? null, agentId: p.agentId ?? null })) });
  } catch {
    return emptyWorkspace;
  }
}

export function saveWorkspace(ws: Workspace): void {
  try {
    storage().setItem(STORAGE_KEY, JSON.stringify(ws));
  } catch {
    // Sin almacenamiento disponible: la disposición dura lo que la ventana.
  }
}

type WsAction = (ws: Workspace) => Workspace;

export const workspaceStore = createStore<Workspace, WsAction>((ws, fn) => fn(ws), emptyWorkspace);

export function initWorkspace(): void {
  workspaceStore.dispatch(() => loadWorkspace());
  workspaceStore.subscribe(() => saveWorkspace(workspaceStore.getState()));
}

export function updateWorkspace(fn: WsAction): void {
  workspaceStore.dispatch(fn);
}

export function useWorkspace(): Workspace {
  return useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getState);
}
