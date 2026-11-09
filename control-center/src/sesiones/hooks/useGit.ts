// Instantánea git de un directorio, compartida por todos los que miran el
// mismo `cwd` (composer, pestaña Git y barra superior): una sola petición en
// vuelo por directorio y una recarga (p. ej. al cerrar un turno) llega a todos.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { SesionesApi } from "../api";
import { useApi } from "../context";
import type { GitRepoSnapshot } from "../types";

export interface GitState {
  snapshot: GitRepoSnapshot | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

type Entry = Omit<GitState, "reload">;

const EMPTY: Entry = { snapshot: null, loading: false, error: null };

let entries: ReadonlyMap<string, Entry> = new Map();
const listeners = new Set<() => void>();
/** Petición en vuelo por directorio: con qué API y si hay que repetirla al acabar. */
interface Flight {
  api: SesionesApi;
  again: boolean;
}
const inFlight = new Map<string, Flight>();

function setEntry(cwd: string, entry: Entry): void {
  const next = new Map(entries);
  next.set(cwd, entry);
  entries = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Pide la instantánea de `cwd`. Con una petición en vuelo no lanza otra; con
 * `repeat` (una recarga explícita, p. ej. al cerrar un turno) la repite al
 * acabar, para que el resultado no sea anterior a los cambios.
 */
export function loadGit(api: SesionesApi, cwd: string, repeat = false): void {
  const current = inFlight.get(cwd);
  // Con otra API (otra ventana de pruebas o un arranque nuevo) se pide de nuevo.
  if (current && current.api === api) {
    if (repeat) inFlight.set(cwd, { api, again: true });
    return;
  }
  const flight: Flight = { api, again: false };
  inFlight.set(cwd, flight);
  setEntry(cwd, { ...(entries.get(cwd) ?? EMPTY), loading: true, error: null });
  const settle = (entry: Entry) => {
    // Una respuesta de una petición sustituida no pisa la nueva.
    if (inFlight.get(cwd)?.api !== api) return;
    const again = inFlight.get(cwd)?.again === true;
    inFlight.delete(cwd);
    setEntry(cwd, entry);
    if (again) loadGit(api, cwd, true);
  };
  api.gitSnapshot(cwd).then(
    (snapshot) => settle({ snapshot, loading: false, error: null }),
    (e: unknown) => settle({ snapshot: null, loading: false, error: e instanceof Error ? e.message : String(e) }),
  );
}

/** Vacía las instantáneas (tests). */
export function resetGitStore(): void {
  entries = new Map();
  inFlight.clear();
  listeners.forEach((l) => l());
}

export function useGit(cwd: string | null): GitState {
  const api = useApi();
  const entry = useSyncExternalStore(subscribe, () => (cwd ? entries.get(cwd) ?? EMPTY : EMPTY));
  // Al montar o cambiar de directorio se refresca; los demás reciben el dato.
  useEffect(() => {
    if (cwd) loadGit(api, cwd);
  }, [api, cwd]);
  const reload = useCallback(() => {
    if (cwd) loadGit(api, cwd, true);
  }, [api, cwd]);
  return { ...entry, reload };
}
