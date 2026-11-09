// Carga asíncrona con estado de carga, error visible y recarga manual.
// Una petición vieja nunca pisa a una más nueva, y el dato va atado a su
// `key`: al cambiar de clave (otro proyecto) no se enseña el de la anterior,
// ni siquiera si la carga nueva falla.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionStatus } from "../types";

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** Sustituye el dato sin volver a pedirlo (p. ej. la respuesta de un toggle). */
  set: (data: T) => void;
}

interface LoadState<T> {
  key: string;
  data: T | null;
  error: string | null;
  loading: boolean;
}

export function useLoad<T>(fn: (() => Promise<T>) | null, key: string): Loaded<T> {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<LoadState<T>>({ key, data: null, error: null, loading: false });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    const run = fnRef.current;
    if (!run) {
      setState({ key, data: null, error: null, loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ key, data: s.key === key ? s.data : null, error: null, loading: true }));
    run()
      .then((data) => alive && setState({ key, data, error: null, loading: false }))
      .catch((e: unknown) => alive && setState((s) => ({ key, data: s.key === key ? s.data : null, error: e instanceof Error ? e.message : String(e), loading: false })));
    return () => {
      alive = false;
    };
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((data: T) => setState({ key: keyRef.current, data, error: null, loading: false }), []);
  // En el render del cambio de clave el efecto aún no ha corrido: nada de la anterior.
  const current = state.key === key;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: current ? state.loading : fn !== null, reload, set };
}

const isBusy = (s: SessionStatus | null | undefined): boolean => s === "working" || s === "waiting";

/**
 * Llama a `reload` cuando la sesión termina un turno (deja de estar ocupada):
 * Claude puede haber tocado el kanban, la bitácora o el repositorio.
 */
export function useReloadOnTurnEnd(status: SessionStatus | null | undefined, reload: () => void): void {
  const busy = isBusy(status);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) reload();
    wasBusy.current = busy;
  }, [busy, reload]);
}
