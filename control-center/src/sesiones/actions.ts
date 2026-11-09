// Acciones de alto nivel que combinan API, store y espacio de trabajo.

import type { SesionesApi } from "./api";
import { reportError } from "./bootstrap";
import { prefsStore } from "./prefs";
import { store } from "./store";
import type { CreateSessionArgs, PastSession, QueueItem, QueueState, SessionId, SessionStatus } from "./types";
import { showInFocused, updateWorkspace } from "./workspace";

/** Estados de la cola que terminar la sesión pierde (la cola vive en memoria del backend). */
const PENDING_QUEUE: ReadonlySet<QueueState> = new Set(["queued", "sending", "cliQueued"]);

/**
 * Lo que se perdería al terminar la sesión: el turno en curso (o la pregunta que
 * espera respuesta), los envíos pendientes y los motores en curso, que el backend
 * cancela con ella (`motor::cancelar_de_sesion`). null si no hay nada que perder.
 */
export function killRisk(status: SessionStatus, queue: readonly QueueItem[] | undefined, runningEngines = 0): string | null {
  const pending = (queue ?? []).filter((q) => PENDING_QUEUE.has(q.state)).length;
  const parts = [
    ...(status === "working" ? ["está trabajando: se cortará el turno"] : []),
    ...(status === "waiting" ? ["espera tu respuesta: se cortará el turno"] : []),
    ...(pending > 0 ? [`${pending} envío${pending === 1 ? "" : "s"} en cola se perderá${pending === 1 ? "" : "n"}`] : []),
    ...(runningEngines > 0 ? [`${runningEngines} motor${runningEngines === 1 ? "" : "es"} en curso se cancelará${runningEngines === 1 ? "" : "n"}`] : []),
  ];
  return parts.length > 0 ? parts.join("; ") : null;
}

/** Directorio por defecto para una sesión nueva: el de la sesión con foco o la última abierta. */
export function defaultCwd(focusedSession: SessionId | null): { cwd: string; projectId?: string } | null {
  const sessions = store.getState().sessions;
  const ref = sessions.find((s) => s.id === focusedSession) ?? sessions[sessions.length - 1];
  if (!ref) return null;
  return { cwd: ref.cwd, projectId: ref.projectId ?? undefined };
}

export async function createSession(api: SesionesApi, args: CreateSessionArgs): Promise<void> {
  try {
    const info = await api.create(args);
    const sessions = store.getState().sessions;
    if (!sessions.some((s) => s.id === info.id)) {
      store.dispatch({ type: "sessions", sessions: [...sessions, info] });
    }
    updateWorkspace((ws) => showInFocused(ws, info.id));
  } catch (e) {
    reportError(e);
  }
}

/** Modelo y effort de las sesiones nuevas según los ajustes. */
function newSessionPrefs(): Pick<CreateSessionArgs, "model" | "effort"> {
  const { newModel, newEffort } = prefsStore.getState();
  return { ...(newModel ? { model: newModel } : {}), ...(newEffort ? { effort: newEffort } : {}) };
}

/**
 * Ajustes por sesión que elige el diálogo de sesión nueva: modo de permisos (v3)
 * y, con un perfil de lanzamiento, modelo, effort y carpeta. Sustituyen a los de
 * Ajustes; las claves ausentes no pisan nada (nunca se pasan con `undefined`).
 */
export type NewSessionOverrides = Partial<Pick<CreateSessionArgs, "permissionMode" | "model" | "effort" | "cwd">>;

/** Sesión nueva en un proyecto registrado (el backend resuelve su ruta). */
export async function newSessionInProject(api: SesionesApi, projectId: string, overrides: NewSessionOverrides = {}): Promise<void> {
  await createSession(api, { projectId, cwd: "", ...newSessionPrefs(), ...overrides });
}

export async function newSessionLike(
  api: SesionesApi,
  focusedSession: SessionId | null,
  overrides: NewSessionOverrides = {},
): Promise<void> {
  const base = defaultCwd(focusedSession);
  if (!base) {
    reportError("Elige un proyecto en «+ Claude» para la primera sesión.");
    return;
  }
  await createSession(api, { ...base, ...newSessionPrefs(), ...overrides });
}

/**
 * Sesión nueva en una carpeta concreta (`--sesiones-cwd`, entrada «ULTRON Sessions aquí»
 * del Explorador). La carpeta pedida manda sobre la del perfil; el backend la asocia al
 * proyecto registrado cuya ruta coincida (`gestor::resolver_cwd`).
 */
export async function newSessionInCwd(api: SesionesApi, cwd: string, overrides: NewSessionOverrides = {}): Promise<void> {
  await createSession(api, { ...newSessionPrefs(), ...overrides, cwd });
}

/** Retoma una conversación anterior de Claude Code (`--resume`) en su directorio. */
export async function resumeSession(api: SesionesApi, past: PastSession, overrides: NewSessionOverrides = {}): Promise<void> {
  await createSession(api, { cwd: past.cwd, resume: past.claudeSessionId, ...newSessionPrefs(), ...overrides });
}
