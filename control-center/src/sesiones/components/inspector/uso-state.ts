// Uso del plan y su ritmo, compartidos por la pestaña Uso y el HUD
// (motores-ventanas:F12 y panel-uso 1-2): el refresco periódico de App.tsx y
// el botón Actualizar pasan por `refreshPlan`, que pide el uso y el ritmo del
// puente del mod ultron-uso. Un fallo queda en su almacén en vez de tragarse.
// Actualizar pide con `force`: el backend salta la muestra local, la caché y
// la espera tras un fallo (`sesiones_usage` y `sesiones_usage_pace`).

import { useSyncExternalStore } from "react";
import { createStore, store } from "../../store";
import type { PlanUsage, UsoPace } from "../../types";

/** Opciones de la petición: `force` pide el dato en vivo (botón Actualizar). */
export interface PlanRequest {
  force?: boolean;
}

/**
 * Lo que `refreshPlan` necesita de la API. Los métodos aceptan `PlanRequest`
 * opcional: una API que todavía no lo declara sigue siendo compatible.
 */
export interface PlanApi {
  usage(req?: PlanRequest): Promise<PlanUsage>;
  usagePace(req?: PlanRequest): Promise<UsoPace>;
}

/** Datos de la fuente que `sesiones_usage_pace` añade al ritmo del puente. */
export interface PaceSource {
  /** true si el endpoint falló y las cifras salen de la caché. */
  stale?: boolean;
  /** `local`: la línea de estado de Claude Code; `oauth`: el endpoint. */
  source?: "local" | "oauth";
  /** Instante de la lectura en ms Unix. */
  fetchedAtMs?: number;
  /** Motivo del último fallo del endpoint. */
  lastError?: string | null;
}

export type PlanPace = UsoPace & PaceSource;

const replace = <T,>(_: T, next: T): T => next;

export const usageErrorStore = createStore<string | null, string | null>(replace, null);
export const paceStore = createStore<PlanPace | null, PlanPace | null>(replace, null);
export const paceErrorStore = createStore<string | null, string | null>(replace, null);

export function useUsageError(): string | null {
  return useSyncExternalStore(usageErrorStore.subscribe, usageErrorStore.getState);
}

export function usePace(): PlanPace | null {
  return useSyncExternalStore(paceStore.subscribe, paceStore.getState);
}

export function usePaceError(): string | null {
  return useSyncExternalStore(paceErrorStore.subscribe, paceErrorStore.getState);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Sin `force` se llama sin argumentos, como siempre; con él, `{ force: true }`. */
const args = (req: PlanRequest): [] | [PlanRequest] => (req.force ? [{ force: true }] : []);

/** Pide el uso del plan; en error lo deja en `usageErrorStore` y devuelve `false`. */
export async function refreshUsage(api: PlanApi, req: PlanRequest = {}): Promise<boolean> {
  try {
    const usage = await api.usage(...args(req));
    store.dispatch({ type: "usage", usage });
    usageErrorStore.dispatch(null);
    return true;
  } catch (e) {
    usageErrorStore.dispatch(message(e));
    return false;
  }
}

/** Pide el ritmo; en error conserva el último y deja el motivo en `paceErrorStore`. */
export async function refreshPace(api: PlanApi, req: PlanRequest = {}): Promise<boolean> {
  try {
    paceStore.dispatch(await api.usagePace(...args(req)));
    paceErrorStore.dispatch(null);
    return true;
  } catch (e) {
    paceErrorStore.dispatch(message(e));
    return false;
  }
}

let inFlight: Promise<void> | null = null;

/**
 * Uso y ritmo en la misma pasada (el ritmo se pide aunque el uso falle). Sin
 * `force`, una petición en vuelo se comparte y el intervalo no se duplica. Con
 * `force` (Actualizar) no se une a la que ya va: encadena una nueva tras ella,
 * para que el dato llegue en vivo y no de la caché que esa otra devuelva.
 */
export function refreshPlan(api: PlanApi, req: PlanRequest = {}): Promise<void> {
  if (inFlight && !req.force) return inFlight;
  const previous = inFlight ?? Promise.resolve();
  const run = previous.then(async () => {
    await refreshUsage(api, req);
    await refreshPace(api, req);
  });
  const current: Promise<void> = run.finally(() => {
    if (inFlight === current) inFlight = null;
  });
  inFlight = current;
  return current;
}

/** Vacía los almacenes (tests y cambio de API). */
export function resetPlanState(): void {
  usageErrorStore.dispatch(null);
  paceStore.dispatch(null);
  paceErrorStore.dispatch(null);
}

/** Minutos desde `ms` hasta `now`, nunca negativos. */
export function minutesSince(ms: number, now: number): number {
  return Math.max(0, Math.round((now - ms) / 60000));
}

/**
 * De dónde y de cuándo es el dato: la caché tras un fallo con su motivo, o la
 * fuente y la antigüedad. `null` si el puente no dijo nada.
 */
export function sourceNote(p: PaceSource | null, now: number): { text: string; isError: boolean } | null {
  if (!p || typeof p.fetchedAtMs !== "number" || p.fetchedAtMs <= 0) return null;
  const ago = minutesSince(p.fetchedAtMs, now);
  const when = ago === 0 ? "hace menos de 1 min" : `hace ${ago} min`;
  if (p.stale) return { text: `Datos en caché desde ${when}${p.lastError ? `: ${p.lastError}` : "."}`, isError: true };
  const from = p.source === "local" ? "la línea de estado de Claude Code" : "el endpoint de uso";
  return { text: `Leído de ${from} ${when}.`, isError: false };
}
