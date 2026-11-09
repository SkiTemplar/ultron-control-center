// Forzar con Claude trabajando (§3.4): atajos del composer, «Segundo plano»
// (Ctrl+B a la CLI con una herramienta en primer plano) y las notas de
// «Interrumpir y enviar». Toda acción deja un resultado visible: nunca un
// no-op silencioso.
//
// Atajos: Ctrl+Enter «Enviar ya» (cola nativa de la CLI: Claude lo lee al
// terminar la herramienta en curso), Ctrl+Mayús+Enter «Interrumpir y enviar»,
// Ctrl+B «Segundo plano» y Ctrl+Mayús+D alterna «Subagente».

import type { SesionesApi } from "../../api";
import { addNote } from "../../bootstrap";
import { store } from "../../store";
import type { BackgroundOutcome, InterruptSendOutcome, SessionId, SessionInfo } from "../../types";

export type ForceKey = "now" | "interrupt" | "background" | "delegate";

export const NO_FOREGROUND_TEXT = "No hay ninguna herramienta en primer plano que pasar a segundo plano.";
export const BACKGROUND_BUSY_TEXT = "El paso a segundo plano anterior sigue en curso o acaba de terminar: no se manda otro Ctrl+B.";

/** Pasos del backend sin Ctrl+B porque otro de la sesión está en vuelo o recién terminado. */
const BACKGROUND_BUSY_STEPS = new Set(["enCurso", "antirrebote"]);

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Atajo forzado de la pulsación, o `null` si no es ninguno. */
export function forceKey(e: KeyLike): ForceKey | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === "Enter") return e.shiftKey ? "interrupt" : "now";
  const k = e.key.toLowerCase();
  if (k === "b" && !e.shiftKey) return "background";
  if (k === "d" && e.shiftKey) return "delegate";
  return null;
}

/** Motivo por el que «Segundo plano» no puede ni intentarse, o `null`. */
export function backgroundBlockReason(info: SessionInfo | null | undefined): string | null {
  if (!info) return "La sesión ya no existe.";
  if (info.status === "exited") return "La sesión terminó: no hay nada que pasar a segundo plano.";
  const tool = info.foregroundTool;
  if (!tool) return NO_FOREGROUND_TEXT;
  // `backgroundable` exige además la pista de la TUI, que tarda ~3 s: un Bash recién
  // lanzado se deja pasar y el backend espera la pista (y explica si no sale).
  if (!movableTool(tool.name)) return `${tool.name} no se puede pasar a segundo plano (solo Bash, PowerShell, subagentes y MCP).`;
  return null;
}

/** Herramientas que Ctrl+B puede mover (`segundo_plano::movible` en el backend). */
export function movableTool(name: string): boolean {
  return ["Bash", "PowerShell", "Agent", "Task"].includes(name) || name.startsWith("mcp__");
}

/** Nota del resultado de `background`: éxito con la evidencia o el motivo del fallo. */
export function backgroundNote(out: BackgroundOutcome): { level: "info" | "error"; text: string } {
  if (!out.ok && out.steps.length === 1 && BACKGROUND_BUSY_STEPS.has(out.steps[0])) return { level: "info", text: BACKGROUND_BUSY_TEXT };
  if (out.ok) return { level: "info", text: `${out.tool} terminó o pasó a segundo plano: Claude sigue y te avisará al acabar.` };
  return { level: "error", text: `No se pudo pasar ${out.tool} a segundo plano: ${out.reason ?? out.steps.join(" → ")}.` };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Sesiones con un «Segundo plano» en vuelo: composer, atajo global y botón comparten la guarda. */
const backgroundInFlight = new Set<SessionId>();

/** Ctrl+B o el botón «Segundo plano»: comprueba, llama al backend y siempre informa. */
export async function backgroundNow(api: SesionesApi, id: SessionId): Promise<BackgroundOutcome | null> {
  const info = store.getState().sessions.find((s) => s.id === id);
  const reason = backgroundBlockReason(info);
  if (reason) {
    addNote(id, "error", reason);
    return null;
  }
  if (backgroundInFlight.has(id)) {
    addNote(id, "info", BACKGROUND_BUSY_TEXT);
    return null;
  }
  backgroundInFlight.add(id);
  try {
    const out = await api.background({ id });
    const note = backgroundNote(out);
    addNote(id, note.level, note.text);
    return out;
  } catch (e) {
    addNote(id, "error", `No se pudo pasar a segundo plano: ${message(e)}`);
    return null;
  } finally {
    backgroundInFlight.delete(id);
  }
}

/** Paso del backend: la interrupción anterior terminó hace menos de 1,5 s y no se manda otro Esc. */
const DEBOUNCED_STEP = "antirrebote";
/** Paso del backend: el mensaje queda en una cola en pausa, que no drena sola al terminar el turno. */
const PAUSED_QUEUE_STEP = "colaPausada";
export const INTERRUPT_DEBOUNCED_TEXT =
  "No se interrumpió: la interrupción anterior acabó hace menos de 1,5 s y Claude sigue trabajando, así que no se manda otro Esc tan seguido. Vuelve a pulsar «Interrumpir y enviar» en un momento";

/** Nota de «Interrumpir y enviar» cuando el mensaje no salió, o `null` si salió. */
export function interruptSendNote(out: InterruptSendOutcome): string | null {
  if (out.sent) return null;
  // Cola en pausa tras un turno abortado: no drena sola al terminar el turno.
  const queued = out.steps.includes(PAUSED_QUEUE_STEP)
    ? "tu mensaje queda el primero de la cola, que está en pausa; pulsa «Enviar ahora»."
    : "tu mensaje queda el primero de la cola y sale al terminar el turno.";
  // Antirrebote: el backend ni lo intentó; un «(antirrebote)» suelto no explica nada.
  if (out.steps.includes(DEBOUNCED_STEP)) return `${INTERRUPT_DEBOUNCED_TEXT}; ${queued}`;
  const steps = out.steps.filter((s) => s !== "encoladoDelante" && s !== PAUSED_QUEUE_STEP);
  const detail = steps.length > 0 ? ` (${steps.join(" → ")})` : "";
  return `No se pudo interrumpir${detail}: ${queued}`;
}
