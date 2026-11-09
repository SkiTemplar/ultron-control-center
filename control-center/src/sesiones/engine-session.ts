// Sesiones de motor (Codex, Gemini u OpenCode sin Claude): crear o retomar una sesión.
// Los turnos `chat` (la caída a `exec`) no son intervenciones: Motores y las demás
// listas los excluyen. El envío va por el composer (engine-session-submit.ts).

import type { SesionesApi } from "./api";
import { reportError } from "./bootstrap";
import { loadEngineModels, resolveEngineModel } from "./engines";
import { store } from "./store";
import type { EngineId, EngineTask, SessionId } from "./types";
import { showInFocused, updateWorkspace } from "./workspace";

/** Sesión de motor cerrada (`sesiones_engine_session_past`), para «Retomar». */
export interface EngineSessionPast {
  id: SessionId;
  engine: EngineId;
  projectId: string | null;
  projectName: string;
  cwd: string;
  title: string;
  startedAt: string;
  lastActivityAt: string;
  turns: number;
}

/** Motores con los que se puede abrir una sesión propia. */
export type SessionEngine = Extract<EngineId, "codex" | "gemini" | "opencode">;
export const SESSION_ENGINES: readonly SessionEngine[] = ["codex", "gemini", "opencode"];

export function isChatTurn(t: EngineTask): boolean {
  return t.kind === "chat";
}

/** Intervenciones (todo lo que no es turno `chat`): lo que enseñan Motores y las listas de tareas. */
export function interventions(tasks: readonly EngineTask[]): EngineTask[] {
  return tasks.filter((t) => !isChatTurn(t));
}

export type EngineSessionTarget =
  | { kind: "here"; projectId: string | null; cwd: string }
  | { kind: "project"; projectId: string }
  | { kind: "resume"; past: EngineSessionPast };

/** Crea (o retoma) la sesión con el modelo guardado del motor y la muestra en el panel con foco. */
export async function openEngineSession(api: SesionesApi, engine: SessionEngine, target: EngineSessionTarget): Promise<SessionId | null> {
  try {
    const models = await loadEngineModels(api, engine).catch(() => null);
    const model = resolveEngineModel(engine, false, models);
    const where = target.kind === "resume"
      ? { resume: target.past.id }
      : target.kind === "project"
        ? { projectId: target.projectId }
        : { cwd: target.cwd, ...(target.projectId ? { projectId: target.projectId } : {}) };
    const info = await api.engineSessionCreate({ engine, ...where, ...(model ? { model } : {}) });
    const sessions = store.getState().sessions;
    if (!sessions.some((s) => s.id === info.id)) store.dispatch({ type: "sessions", sessions: [...sessions, info] });
    updateWorkspace((ws) => showInFocused(ws, info.id));
    return info.id;
  } catch (e) {
    reportError(e);
    return null;
  }
}

