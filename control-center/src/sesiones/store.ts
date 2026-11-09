// Almacén externo mínimo sobre el reducer y hooks con `useSyncExternalStore`.

import { useMemo, useSyncExternalStore } from "react";
import { emptySession, initialState, reducer, type Action, type SessionState, type State } from "./reducer";
import type { Ask, SessionId, SessionInfo } from "./types";

export interface Store<S, A> {
  getState(): S;
  dispatch(action: A): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S, A>(reduce: (s: S, a: A) => S, initial: S): Store<S, A> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const store = createStore<State, Action>(reducer, initialState);

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

export function useSession(id: SessionId | null): SessionState {
  return useStore((s) => (id ? s.bySession[id] ?? emptySession : emptySession));
}

export function useSessionInfo(id: SessionId | null): SessionInfo | null {
  return useStore((s) => (id ? s.sessions.find((x) => x.id === id) ?? null : null));
}

const noAsks: Ask[] = [];

/** Preguntas pendientes de una sesión; referencia estable si no hay ninguna. */
export function selectAsks(asks: readonly Ask[], id: SessionId | null): Ask[] {
  if (!id) return noAsks;
  const list = asks.filter((a) => a.id === id);
  return list.length === 0 ? noAsks : list;
}

export function useAsks(id: SessionId | null): Ask[] {
  const asks = useStore((s) => s.asks);
  return useMemo(() => selectAsks(asks, id), [asks, id]);
}
