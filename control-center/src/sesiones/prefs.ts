// Preferencias de ULTRON Sessions (por equipo, en localStorage): escala de la
// interfaz, razonamiento visible, confirmación al terminar sesiones y modelo y
// effort de las sesiones nuevas y avisos de atención (attention.ts). El tema se
// guarda aparte (themes.ts).

import { useSyncExternalStore } from "react";
import { createStore } from "./store";
import type { Effort, EngineId } from "./types";

export const SCALES = [90, 100, 110, 120] as const;
export type Scale = (typeof SCALES)[number];
export const NEW_SESSION_MODELS = ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2", "claude-fable-5-2[1m]"] as const;
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface Prefs {
  scale: Scale;
  showThinking: boolean;
  /** Pliega herramientas y razonamiento de cada turno: solo queda el texto. */
  compactTools: boolean;
  confirmKill: boolean;
  /** null = el modelo por defecto de Claude Code. */
  newModel: string | null;
  /** null = el effort por defecto de Claude Code. */
  newEffort: Effort | null;
  /** Modelo de cada motor externo; null = el predeterminado de su CLI. */
  engineModels: Record<EngineId, string | null>;
  /** Aviso de Windows (toast) al terminar un turno o pedir respuesta sin foco. */
  attentionToast: boolean;
  /** Parpadeo en la barra de tareas en esos mismos casos. */
  attentionFlash: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  scale: 100,
  showThinking: true,
  compactTools: true,
  confirmKill: true,
  newModel: null,
  newEffort: null,
  engineModels: { codex: null, gemini: null, opencode: null },
  attentionToast: true,
  attentionFlash: true,
};

const MODEL_ID = /^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,79}$/;
/** OpenCode: `proveedor/modelo` (el modelo puede llevar más `/`). */
const OPENCODE_MODEL_ID = /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-][A-Za-z0-9._:/-]{0,118}$/;

function sanitizeEngineModels(v: unknown): Prefs["engineModels"] {
  const r = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const one = (x: unknown) => (typeof x === "string" && MODEL_ID.test(x) ? x : null);
  const oc = typeof r.opencode === "string" && OPENCODE_MODEL_ID.test(r.opencode) && !r.opencode.startsWith("-") ? r.opencode : null;
  return { codex: one(r.codex), gemini: one(r.gemini), opencode: oc };
}

const STORAGE_KEY = "ultron.sesiones.prefs";

/** Normaliza lo leído del almacenamiento: campo inválido → valor por defecto. */
export function sanitizePrefs(raw: unknown): Prefs {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pick = <K extends keyof Prefs>(k: K, ok: (v: unknown) => boolean): Prefs[K] =>
    (ok(r[k]) ? r[k] : DEFAULT_PREFS[k]) as Prefs[K];
  return {
    scale: pick("scale", (v) => SCALES.includes(v as Scale)),
    showThinking: pick("showThinking", (v) => typeof v === "boolean"),
    compactTools: pick("compactTools", (v) => typeof v === "boolean"),
    confirmKill: pick("confirmKill", (v) => typeof v === "boolean"),
    newModel: pick("newModel", (v) => v === null || NEW_SESSION_MODELS.includes(v as (typeof NEW_SESSION_MODELS)[number])),
    newEffort: pick("newEffort", (v) => v === null || EFFORTS.includes(v as Effort)),
    engineModels: sanitizeEngineModels(r.engineModels),
    attentionToast: pick("attentionToast", (v) => typeof v === "boolean"),
    attentionFlash: pick("attentionFlash", (v) => typeof v === "boolean"),
  };
}

function load(): Prefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return sanitizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_PREFS;
  }
}

export const prefsStore = createStore<Prefs, (p: Prefs) => Prefs>((p, fn) => fn(p), load());

/** Aplica la escala de la interfaz (zoom de WebView2 sobre <html>). */
export function applyPrefs(p: Prefs): void {
  document.documentElement.style.setProperty("zoom", String(p.scale / 100));
}

export function setPrefs(patch: Partial<Prefs>): void {
  prefsStore.dispatch((p) => ({ ...p, ...patch }));
  const next = prefsStore.getState();
  applyPrefs(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Sin almacenamiento: las preferencias duran lo que la ventana.
  }
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(prefsStore.subscribe, prefsStore.getState);
}
