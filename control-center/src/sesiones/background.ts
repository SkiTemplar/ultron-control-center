// Trabajo en segundo plano de una sesión: subagentes y runs de `Workflow` que
// siguen vivos, más los shells, monitores y despertadores que la CLI deja en
// vuelo al cerrar el turno (`backgroundTasks`, del hook `Stop`). Con el hilo
// principal libre, la sesión no ha acabado del todo: la barra lateral, las
// pestañas y la línea de estado lo distinguen de «Listo».
// Puras salvo `useBackgroundWork`, para poder probarlas en tabla.

import type { State } from "./reducer";
import type { SessionState } from "./session-state";
import { useStore } from "./store";
import type { SessionId, SessionInfo } from "./types";

/** Trabajo en segundo plano que el mod no ve (`puente_fondo.rs`). */
export interface BackgroundTask {
  id: string;
  /** `shell`, `monitor` o `cron` (u otro tipo que añada la CLI). */
  kind: string;
  description: string;
  /** Expresión cron de un despertador. */
  schedule?: string;
  recurring?: boolean;
}

export interface BackgroundWork {
  /** Subagentes en curso que no pertenecen a un `Workflow` en curso. */
  agents: number;
  /** Runs de `Workflow` en curso. */
  workflows: number;
  /** Shells y monitores lanzados en segundo plano que siguen vivos. */
  processes: number;
  /** Despertadores programados (`ScheduleWakeup`, `/loop`). */
  wakeups: number;
  /** «HH:MM» del primer despertador de un solo disparo; null si no hay o no se puede leer. */
  wakeAt: string | null;
}

export const NO_BACKGROUND: BackgroundWork = { agents: 0, workflows: 0, processes: 0, wakeups: 0, wakeAt: null };

/** Estado del punto: `background` = hilo principal libre con trabajo vivo. */
export type DisplayStatus = SessionInfo["status"] | "background";

const two = (n: string): string => n.padStart(2, "0");

/** Hora de un cron de un solo disparo («30 14 23 11 *» → «14:30»); null si minuto u hora no son fijos. */
export function cronTime(schedule: string): string | null {
  const [min, hour] = schedule.trim().split(/\s+/);
  if (!/^\d{1,2}$/.test(min ?? "") || !/^\d{1,2}$/.test(hour ?? "")) return null;
  return `${two(hour)}:${two(min)}`;
}

function taskWork(tasks: readonly BackgroundTask[] | undefined): Pick<BackgroundWork, "processes" | "wakeups" | "wakeAt"> {
  const list = tasks ?? [];
  const crons = list.filter((t) => t.kind === "cron");
  const oneShot = crons.find((t) => !t.recurring && t.schedule);
  return {
    processes: list.length - crons.length,
    wakeups: crons.length,
    wakeAt: oneShot?.schedule ? cronTime(oneShot.schedule) : null,
  };
}

export function backgroundWork(
  s: Pick<SessionState, "agents" | "workflows"> | undefined,
  tasks?: readonly BackgroundTask[],
): BackgroundWork {
  const fromTasks = taskWork(tasks);
  if (!s) return { ...NO_BACKGROUND, ...fromTasks };
  const running = Object.values(s.workflows).filter((r) => r.status === "running");
  // Un agente de un run en curso ya cuenta como parte del run.
  const inRun = new Set(running.flatMap((r) => r.agents.map((a) => a.agentId)));
  const agents = s.agents.filter((a) => a.status === "running" && !inRun.has(a.agentId)).length;
  return { agents, workflows: running.length, ...fromTasks };
}

export function hasBackground(bg: BackgroundWork): boolean {
  return bg.agents + bg.workflows + bg.processes + bg.wakeups > 0;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** «2 subagentes, 1 proceso y despierta a las 14:30»; cadena vacía sin trabajo vivo. */
export function backgroundText(bg: BackgroundWork): string {
  const parts: string[] = [];
  if (bg.agents > 0) parts.push(plural(bg.agents, "subagente", "subagentes"));
  if (bg.workflows > 0) parts.push(plural(bg.workflows, "workflow", "workflows"));
  if (bg.processes > 0) parts.push(plural(bg.processes, "proceso", "procesos"));
  if (bg.wakeups > 0) parts.push(bg.wakeups === 1 && bg.wakeAt ? `despierta a las ${bg.wakeAt}` : plural(bg.wakeups, "despertador", "despertadores"));
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

/** Solo `idle` pasa a `background`: trabajando, esperando o terminada mandan sobre el segundo plano. */
export function displayStatus(status: SessionInfo["status"], bg: BackgroundWork): DisplayStatus {
  return status === "idle" && hasBackground(bg) ? "background" : status;
}

/** Selectores primitivos: un objeto nuevo por lectura haría que `useSyncExternalStore` no parase de renderizar. */
export function useBackgroundWork(id: SessionId | null): BackgroundWork {
  const agents = useStore((st) => (id ? backgroundWork(st.bySession[id]).agents : 0));
  const workflows = useStore((st) => (id ? backgroundWork(st.bySession[id]).workflows : 0));
  const tasks = (st: State) =>
    taskWork(id ? st.sessions.find((x) => x.id === id)?.backgroundTasks : undefined);
  const processes = useStore((st) => tasks(st).processes);
  const wakeups = useStore((st) => tasks(st).wakeups);
  const wakeAt = useStore((st) => tasks(st).wakeAt);
  return { agents, workflows, processes, wakeups, wakeAt };
}
