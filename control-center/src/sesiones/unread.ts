// Respuestas nuevas sin leer: un turno que termina en una sesión que no está a la
// vista en ningún panel deja una marca en su pestaña y en su fila de la barra
// lateral. Mostrarla en un panel la borra. Vive en memoria de la ventana: al
// recargar no hay nada sin leer (el hilo se rehidrata entero).

import { useSyncExternalStore } from "react";
import { createStore } from "./store";
import type { SessionId, TurnPayload } from "./types";
import type { Workspace } from "./workspace";

type Unread = ReadonlySet<SessionId>;
type UnreadAction = (s: Unread) => Unread;

export const unreadStore = createStore<Unread, UnreadAction>((s, fn) => fn(s), new Set());

/** Motivos de fin de turno que dejan algo que leer (no las interrupciones). */
const READABLE: ReadonlySet<TurnPayload["reason"]> = new Set(["answer", "refusal", "error"]);

function shown(ws: Workspace): Set<SessionId> {
  return new Set(ws.panes.map((p) => p.sessionId).filter((id): id is SessionId => id !== null));
}

/** Marca la sesión si su turno terminó con algo que leer y no está en ningún panel. */
export function markTurnUnread(p: Pick<TurnPayload, "id" | "reason">, ws: Workspace): void {
  if (!READABLE.has(p.reason) || shown(ws).has(p.id)) return;
  unreadStore.dispatch((s) => (s.has(p.id) ? s : new Set([...s, p.id])));
}

/** Borra la marca de las sesiones que están a la vista en algún panel. */
export function clearSeen(ws: Workspace): void {
  const visible = shown(ws);
  unreadStore.dispatch((s) => {
    const next = [...s].filter((id) => !visible.has(id));
    return next.length === s.size ? s : new Set(next);
  });
}

/** Mantiene las marcas al día con el espacio de trabajo; devuelve la baja. */
export function wireUnread(workspace: { getState: () => Workspace; subscribe: (l: () => void) => () => void }): () => void {
  return workspace.subscribe(() => clearSeen(workspace.getState()));
}

export function useUnread(id: SessionId): boolean {
  return useSyncExternalStore(unreadStore.subscribe, () => unreadStore.getState().has(id));
}
