// Resultado de un Esc del composer (interrumpir o salir del menú) como nota del
// chat: un `ok: false` o una interrupción ya en marcha no pueden quedar en
// silencio, porque el usuario vuelve a pulsar Esc pensando que la CLI no responde.
//
// Incidente del 2026-10-15: dos Esc seguidos dejaban dos notas «Interrupción en
// curso» idénticas y un fallo recuperable acababa con tres mensajes rojos de
// «reiníciala». Por eso: una sola recuperación en vuelo por sesión (la segunda
// pulsación no llama al backend y avisa una vez); cuando el turno lo relevó otro
// abierto por el aviso de una tarea (`turnoNuevo`, `retomaPorTarea`) o la CLI no
// respondió (`sinRespuesta`), el aviso es de la máquina (`sesiones://notice`) y
// aquí no se repite; la línea de estado lo recuerda hasta que la sesión sale de
// working.

import { useSyncExternalStore } from "react";
import type { SesionesApi } from "../../api";
import { createStore } from "../../store";
import type { NoticeLevel, RecoverAction, RecoverOutcome, SessionId } from "../../types";

const ACTION_TEXT: Record<string, string> = {
  interrupt: "interrumpir el turno",
  exitMenu: "salir del menú",
  restart: "reiniciar la sesión",
};

/** Paso que devuelve el backend cuando ya hay una interrupción en curso. */
const IN_PROGRESS = "enCurso";
/** Paso del backend: la anterior terminó hace menos de 1,5 s (su resultado ya se contó). */
const DEBOUNCED = "antirrebote";
/** Pasos del backend: el turno pedido cerró y la CLI abrió otro con el aviso de una tarea en segundo plano. */
const NEW_TURN_STEPS = ["turnoNuevo", "retomaPorTarea", "retomaPorSubagente"];
/** Paso del backend: el mismo turno sigue sin actividad del puente (la máquina avisa en rojo). */
const NO_RESPONSE = "sinRespuesta";
/** Paso del backend: Reiniciar no halló el transcript y abrió una conversación nueva. */
const NEW_CONVERSATION = "sinTranscriptConversacionNueva";
/** Nota de un reinicio que no pudo retomar la conversación (`ok: true`, pero no es lo que se pidió). */
export const NEW_CONVERSATION_TEXT =
  "No se encontró el transcript: se ha abierto una conversación nueva con el mismo id, sin el historial anterior.";
export const IN_PROGRESS_TEXT = "Interrupción en curso: espera a que la CLI responda antes de volver a pulsar Esc.";
export const RESTART_IN_PROGRESS_TEXT = "Ya hay un reinicio en curso: espera a que Claude vuelva a arrancar.";
export const STILL_WORKING_TEXT = "Claude sigue trabajando tras interrumpir: pulsa Esc otra vez para pararlo.";

export interface RecoverNote {
  level: NoticeLevel;
  text: string;
}

/** La interrupción no paró porque la CLI abrió otro turno con el aviso de una tarea. */
export function resumedBySubagent(out: RecoverOutcome): boolean {
  return !out.ok && out.steps.some((s) => NEW_TURN_STEPS.includes(s));
}

/** Un paso que no se pudo escribir en el PTY: «esc: …», «ctrlC: …». */
function writeFailed(steps: readonly string[]): boolean {
  return steps.some((s) => /^[A-Za-z0-9.]+: /.test(s));
}

function onlyStep(out: RecoverOutcome, step: string): boolean {
  return out.steps.length === 1 && out.steps[0] === step;
}

/** Nota que merece el resultado, o `null` si todo fue bien o ya avisa la máquina. */
export function recoverNote(out: RecoverOutcome): RecoverNote | null {
  if (onlyStep(out, IN_PROGRESS)) return { level: "info", text: out.action === "restart" ? RESTART_IN_PROGRESS_TEXT : IN_PROGRESS_TEXT };
  if (onlyStep(out, DEBOUNCED)) return null;
  if (out.ok && out.steps.includes(NEW_CONVERSATION)) return { level: "warn", text: NEW_CONVERSATION_TEXT };
  if (out.ok) return null;
  const action = ACTION_TEXT[out.action] ?? out.action;
  const steps = out.steps.length > 0 ? out.steps.join(" → ") : "sin detalle";
  if (writeFailed(out.steps)) return { level: "error", text: `No se pudo ${action} (${steps}).` };
  if (resumedBySubagent(out) || out.steps.includes(NO_RESPONSE)) return null;
  if (out.action === "interrupt") return { level: "warn", text: STILL_WORKING_TEXT };
  return { level: "error", text: `No se pudo ${action} (${steps}).` };
}

// ---------------------------------------------------------------------------
// Una recuperación en vuelo por sesión
// ---------------------------------------------------------------------------

const inFlight = new Set<SessionId>();
const busyNoted = new Set<SessionId>();

/** Reserva la recuperación de `id`; false si ya hay una en vuelo. */
export function beginRecover(id: SessionId): boolean {
  if (inFlight.has(id)) return false;
  inFlight.add(id);
  busyNoted.delete(id);
  return true;
}

export function endRecover(id: SessionId): void {
  inFlight.delete(id);
  busyNoted.delete(id);
}

/** Nota «en curso» de una pulsación durante el vuelo: como mucho una por vuelo. */
function busyNoteOnce(id: SessionId): RecoverNote | null {
  if (busyNoted.has(id)) return null;
  busyNoted.add(id);
  return { level: "info", text: IN_PROGRESS_TEXT };
}

/**
 * Interrumpir o salir del menú con la guarda de vuelo: con otra en marcha no
 * llama al backend y devuelve `null`. `report` recibe la nota, si la hay.
 */
export async function runRecover(
  api: SesionesApi, id: SessionId, action: RecoverAction, report: (note: RecoverNote) => void,
): Promise<RecoverOutcome | null> {
  if (!beginRecover(id)) {
    const busy = busyNoteOnce(id);
    if (busy) report(busy);
    return null;
  }
  try {
    const out = await api.recover({ id, action });
    rememberRecover(id, out);
    const note = recoverNote(out);
    if (note) report(note);
    return out;
  } finally {
    endRecover(id);
  }
}

// ---------------------------------------------------------------------------
// Aviso de la línea de estado
// ---------------------------------------------------------------------------

type ResumeAction = { id: SessionId; resumed: boolean };

function reduceResume(s: ReadonlySet<SessionId>, a: ResumeAction): ReadonlySet<SessionId> {
  if (s.has(a.id) === a.resumed) return s;
  const next = new Set(s);
  if (a.resumed) next.add(a.id);
  else next.delete(a.id);
  return next;
}

/** Sesiones cuya última interrupción relevó un turno abierto por el aviso de una tarea. */
export const subagentResumeStore = createStore<ReadonlySet<SessionId>, ResumeAction>(reduceResume, new Set());

/** Anota el resultado de una recuperación: marca o retira el aviso de la línea de estado. */
export function rememberRecover(id: SessionId, out: RecoverOutcome): void {
  if (onlyStep(out, IN_PROGRESS) || onlyStep(out, DEBOUNCED)) return;
  subagentResumeStore.dispatch({ id, resumed: resumedBySubagent(out) });
}

/** La sesión salió de working: el aviso ya no describe lo que pasa. */
export function forgetSubagentResume(id: SessionId): void {
  subagentResumeStore.dispatch({ id, resumed: false });
}

export function useSubagentResume(id: SessionId): boolean {
  return useSyncExternalStore(subagentResumeStore.subscribe, () => subagentResumeStore.getState().has(id));
}
