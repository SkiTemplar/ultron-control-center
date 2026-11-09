// Estado de interfaz compartido entre componentes lejanos (pestaña del inspector,
// petición de foco en el formulario de motores, texto que otro componente quiere
// dejar en el composer y visor de imágenes), más los canales entre paquetes del
// contrato de estabilidad (§7.4, fase 0b): cada petición lleva un `tick` creciente
// para que el consumidor reaccione una sola vez por petición.

import { useSyncExternalStore } from "react";
import { createStore } from "./store";
import type { EngineId, SessionId } from "./types";

export type InspectorTab =
  | "agentes"
  | "git"
  | "contexto"
  | "uso"
  | "adjuntos"
  | "motores"
  | "bitacora";

/** Texto que el HUD o la paleta piden escribir en el composer de una sesión. */
export interface ComposerInsert {
  sessionId: SessionId;
  text: string;
  /** `replace` sustituye el borrador; `append` lo añade al final; `insert`, en el cursor. */
  how: "replace" | "append" | "insert";
  tick: number;
}

/** Imagen del visor; `path` (ruta en disco) habilita abrir y mostrar en la carpeta. */
export interface ViewerItem {
  src: string;
  caption: string;
  path?: string;
}

/** Petición dirigida a una sesión; `tick` distingue dos peticiones iguales seguidas. */
export interface SessionRequest {
  sessionId: SessionId;
  tick: number;
}

export interface AttachRequest extends SessionRequest {
  files: readonly File[];
}

export interface InspectorTabRequest extends SessionRequest {
  tab: InspectorTab;
}

export interface EngineTaskRequest extends SessionRequest {
  engine: EngineId;
}

/** Menú que el bloque del chat debe teclear él mismo (backend con el cable antiguo). */
export interface MenuRequest extends SessionRequest {
  command: string;
}

export interface UiState {
  inspectorTab: InspectorTab;
  engineFocusTick: number;
  composerInsert: ComposerInsert | null;
  viewer: { items: ViewerItem[]; index: number } | null;
  /** Turnos con la actividad desplegada (clave = uuid del prompt). */
  expandedTurns: Readonly<Record<string, true>>;
  // Canales entre paquetes (§7.4). Emite WP-MOTORES, consume WP-CHAT:
  attachRequest: AttachRequest | null;
  dictationToggleTick: number;
  // Emite WP-CHAT, consume WP-MOTORES:
  inspectorTabRequest: InspectorTabRequest | null;
  engineTaskRequest: EngineTaskRequest | null;
  sessionSettingsRequest: SessionRequest | null;
  // Interno de WP-CHAT:
  menuRequest: MenuRequest | null;
}

type UiAction = (s: UiState) => UiState;

export const uiStore = createStore<UiState, UiAction>((s, fn) => fn(s), {
  inspectorTab: "agentes",
  engineFocusTick: 0,
  composerInsert: null,
  viewer: null,
  expandedTurns: {},
  attachRequest: null,
  dictationToggleTick: 0,
  inspectorTabRequest: null,
  engineTaskRequest: null,
  sessionSettingsRequest: null,
  menuRequest: null,
});

export function setUi(fn: UiAction): void {
  uiStore.dispatch(fn);
}

export function useUi<T>(selector: (s: UiState) => T): T {
  return useSyncExternalStore(uiStore.subscribe, () => selector(uiStore.getState()));
}

export function toggleTurn(turn: string): void {
  setUi((s) => {
    const { [turn]: open, ...rest } = s.expandedTurns;
    return { ...s, expandedTurns: open ? rest : { ...s.expandedTurns, [turn]: true } };
  });
}

export function openViewer(src: string, caption: string, path?: string): void {
  setUi((s) => ({ ...s, viewer: { items: [{ src, caption, path }], index: 0 } }));
}

/**
 * Abre el visor con todas las imágenes del hilo que contiene `el` (las que
 * llevan `data-gallery`), empezando por la pulsada: ← y → pasan entre ellas.
 */
export function openViewerFrom(el: HTMLElement, fallback: ViewerItem): void {
  const scope = el.closest("[data-testid='message-scroll']") ?? document;
  const nodes = [...scope.querySelectorAll<HTMLImageElement>("img[data-gallery]")];
  const items = nodes.map((n) => ({ src: n.src, caption: n.alt || "imagen", path: n.dataset.path || undefined }));
  const target = el.matches("img[data-gallery]") ? el : el.querySelector("img[data-gallery]");
  const index = target ? nodes.indexOf(target as HTMLImageElement) : -1;
  setUi((s) => ({ ...s, viewer: index >= 0 ? { items, index } : { items: [fallback], index: 0 } }));
}

export function stepViewer(dir: -1 | 1): void {
  setUi((s) => {
    if (!s.viewer) return s;
    const n = s.viewer.items.length;
    return { ...s, viewer: { ...s.viewer, index: (s.viewer.index + dir + n) % n } };
  });
}

export function openInspector(tab: InspectorTab): void {
  setUi((s) => ({ ...s, inspectorTab: tab }));
}

export function insertInComposer(sessionId: SessionId, text: string, how: ComposerInsert["how"] = "replace"): void {
  setUi((s) => ({ ...s, composerInsert: { sessionId, text, how, tick: (s.composerInsert?.tick ?? 0) + 1 } }));
}

const nextTick = (prev: { tick: number } | null): number => (prev?.tick ?? 0) + 1;

/** Ficheros soltados en la ventana para el composer de una sesión (lo emite `drop.ts`). */
export function requestAttach(sessionId: SessionId, files: readonly File[]): void {
  setUi((s) => ({ ...s, attachRequest: { sessionId, files: [...files], tick: nextTick(s.attachRequest) } }));
}

/** Atajo global de dictado: el composer con foco arranca o para la voz. */
export function requestDictationToggle(): void {
  setUi((s) => ({ ...s, dictationToggleTick: s.dictationToggleTick + 1 }));
}

/** Abre una pestaña del inspector para una sesión (paneles `git`, `agentes` y `uso`). */
export function requestInspectorTab(sessionId: SessionId, tab: InspectorTab): void {
  setUi((s) => ({ ...s, inspectorTabRequest: { sessionId, tab, tick: nextTick(s.inspectorTabRequest) } }));
}

/** Nueva tarea de un motor para una sesión (panel `engines`). */
export function requestEngineTask(sessionId: SessionId, engine: EngineId): void {
  setUi((s) => ({ ...s, engineTaskRequest: { sessionId, engine, tick: nextTick(s.engineTaskRequest) } }));
}

/** Abre Ajustes → Sesión actual para una sesión (clic en el modo del HUD). */
export function requestSessionSettings(sessionId: SessionId): void {
  setUi((s) => ({ ...s, sessionSettingsRequest: { sessionId, tick: nextTick(s.sessionSettingsRequest) } }));
}

/** El bloque de menú del chat abre `/command` tecleándolo en la terminal adjunta. */
export function requestMenu(sessionId: SessionId, command: string): void {
  setUi((s) => ({ ...s, menuRequest: { sessionId, command, tick: nextTick(s.menuRequest) } }));
}

export function clearMenuRequest(sessionId: SessionId): void {
  setUi((s) => (s.menuRequest?.sessionId === sessionId ? { ...s, menuRequest: null } : s));
}
