// Publica en el store qué hilos de subagente están abiertos en algún panel de
// esta ventana: la cota de hilos (`thread-memory.ts`) nunca los suelta. Los
// demás se quedan en un LRU y, si salen de él, el panel que los abra después
// los vuelve a pedir paginados (`ChatPane` → `loadHistory`).

import type { Action } from "./reducer";
import type { Store } from "./store";
import type { SessionId } from "./types";
import { setPaneTarget, splitWith, updateWorkspace, type Workspace } from "./workspace";

/** Hilos de subagente abiertos por sesión, en el orden de los paneles y sin repetir. */
export function openAgentsOf(ws: Workspace): Record<SessionId, string[]> {
  const out: Record<SessionId, string[]> = {};
  for (const p of ws.panes) {
    if (!p.sessionId || !p.agentId) continue;
    const list = out[p.sessionId] ?? [];
    if (!list.includes(p.agentId)) out[p.sessionId] = [...list, p.agentId];
  }
  return out;
}

/** Abre el hilo de un subagente en el panel con foco o, con `newPane`, en uno nuevo a la derecha. */
export function openAgentThread(sessionId: SessionId, agentId: string | null, newPane: boolean): void {
  updateWorkspace((w) => (newPane ? splitWith(w, sessionId, "right", agentId) : setPaneTarget(w, w.focused, sessionId, agentId)));
}

/** Sigue el espacio de trabajo y publica los hilos abiertos; devuelve la baja de la suscripción. */
export function wireOpenAgents(workspace: Pick<Store<Workspace, unknown>, "getState" | "subscribe">, dispatch: (a: Action) => void): () => void {
  const publish = () => dispatch({ type: "openAgents", open: openAgentsOf(workspace.getState()) });
  publish();
  return workspace.subscribe(publish);
}
