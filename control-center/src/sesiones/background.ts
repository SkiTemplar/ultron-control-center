// Trabajo en segundo plano de una sesión: subagentes y runs de `Workflow` que
// siguen vivos. Con el hilo principal libre, la sesión no ha acabado del todo:
// la barra lateral, las pestañas y la línea de estado lo distinguen de «Listo».
// Puras salvo `useBackgroundWork`, para poder probarlas en tabla.

import type { SessionState } from "./session-state";
import { useStore } from "./store";
import type { SessionId, SessionInfo } from "./types";

export interface BackgroundWork {
  /** Subagentes en curso que no pertenecen a un `Workflow` en curso. */
  agents: number;
  /** Runs de `Workflow` en curso. */
  workflows: number;
}

export const NO_BACKGROUND: BackgroundWork = { agents: 0, workflows: 0 };

/** Estado del punto: `background` = hilo principal libre con trabajo vivo. */
export type DisplayStatus = SessionInfo["status"] | "background";

export function backgroundWork(s: Pick<SessionState, "agents" | "workflows"> | undefined): BackgroundWork {
  if (!s) return NO_BACKGROUND;
  const running = Object.values(s.workflows).filter((r) => r.status === "running");
  // Un agente de un run en curso ya cuenta como parte del run.
  const inRun = new Set(running.flatMap((r) => r.agents.map((a) => a.agentId)));
  const agents = s.agents.filter((a) => a.status === "running" && !inRun.has(a.agentId)).length;
  return { agents, workflows: running.length };
}

export function hasBackground(bg: BackgroundWork): boolean {
  return bg.agents + bg.workflows > 0;
}

/** «2 subagentes y 1 workflow»; cadena vacía sin trabajo vivo. */
export function backgroundText(bg: BackgroundWork): string {
  const parts: string[] = [];
  if (bg.agents > 0) parts.push(`${bg.agents} subagente${bg.agents === 1 ? "" : "s"}`);
  if (bg.workflows > 0) parts.push(`${bg.workflows} workflow${bg.workflows === 1 ? "" : "s"}`);
  return parts.join(" y ");
}

/** Solo `idle` pasa a `background`: trabajando, esperando o terminada mandan sobre el segundo plano. */
export function displayStatus(status: SessionInfo["status"], bg: BackgroundWork): DisplayStatus {
  return status === "idle" && hasBackground(bg) ? "background" : status;
}

/** Dos selectores numéricos: un objeto nuevo por lectura haría que `useSyncExternalStore` no parase de renderizar. */
export function useBackgroundWork(id: SessionId | null): BackgroundWork {
  const agents = useStore((st) => (id ? backgroundWork(st.bySession[id]).agents : 0));
  const workflows = useStore((st) => (id ? backgroundWork(st.bySession[id]).workflows : 0));
  return { agents, workflows };
}
