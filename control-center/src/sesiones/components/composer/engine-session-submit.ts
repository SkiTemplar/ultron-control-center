// Envío desde el composer de una sesión de motor (Codex, Gemini u OpenCode sin
// Claude): con el motor libre, un turno nuevo; ocupado, a su cola (el backend la
// drena al cerrar cada turno). «Interrumpir y enviar» corta el turno y encola, así
// que el mensaje sale en cuanto el motor queda libre. «Enviar ya» solo con Codex
// (el backend lo pasa al turno activo con turn/steer); los modos de Claude
// («Subagente», «Segundo plano») no se aplican aquí.

import { addNote, reportError } from "../../bootstrap";
import type { SesionesApi } from "../../api";
import { ENGINE_LABEL, engineBlockReason } from "../../engines";
import { enqueueItem, moveItem, sendNow } from "../../queue";
import type { EngineId, EngineStatus, SessionId } from "../../types";
import type { Attachment } from "./useAttachments";
import { outgoingPayload } from "./attachment-kind";
import type { SubmitMode } from "./submit";

export interface EngineSessionSend {
  api: SesionesApi;
  sessionId: SessionId;
  engine: EngineId;
  engineStatus: EngineStatus[] | null;
  prompt: string;
  attachments: readonly Attachment[];
  /** El motor está con un turno: el mensaje se encola. */
  busy: boolean;
  mode: SubmitMode;
}

/** «Enviar ya» solo existe con Codex (`turn/steer`): Gemini y OpenCode no admiten mensajes a mitad de turno. */
export function sendsNow(engine: EngineId): boolean {
  return engine === "codex";
}

/** Nota del modo que no se aplica a una sesión de motor; `null` si se aplica. */
export function unsupportedModeNote(engine: EngineId, mode: SubmitMode): string | null {
  if (mode !== "now" || sendsNow(engine)) return null;
  return `${ENGINE_LABEL[engine]} no admite añadir mensajes a un turno en curso: el mensaje se encola y sale al terminar el turno.`;
}

/** Envía o encola; `true` si el mensaje quedó en manos del backend (el borrador se puede vaciar). */
export async function submitEngineSession(s: EngineSessionSend): Promise<boolean> {
  const label = ENGINE_LABEL[s.engine];
  const reason = engineBlockReason(s.engineStatus, s.engine);
  if (reason) {
    reportError(`${label} no disponible: ${reason}`);
    return false;
  }
  if (!s.prompt) {
    reportError(`Escribe el mensaje para ${label}.`);
    return false;
  }
  const note = unsupportedModeNote(s.engine, s.mode);
  if (note) addNote(s.sessionId, "info", note);
  const payload = outgoingPayload(s.prompt, s.attachments);
  try {
    if (s.busy) {
      const clientId = crypto.randomUUID();
      await enqueueItem(s.api, s.sessionId, { clientId, text: payload.text, attachments: payload.attachments, delegate: false, kind: "prompt" });
      // «Interrumpir y enviar» va por delante de lo que ya esperaba en la cola.
      // «Enviar ya» con Codex: el backend lo pasa al turno activo con turn/steer.
      if (s.mode === "now" && sendsNow(s.engine)) await sendNow(s.api, s.sessionId, clientId);
      // Se interrumpe después de encolar: el drenaje que sigue al corte ya lo encuentra primero.
      if (s.mode === "interrupt") {
        await moveItem(s.api, s.sessionId, clientId, 0);
        await s.api.engineSessionInterrupt(s.sessionId);
      }
    } else {
      await s.api.engineSessionSend({ id: s.sessionId, text: payload.text, ...(payload.attachments.length ? { attachments: payload.attachments } : {}) });
    }
    return true;
  } catch (e) {
    reportError(e);
    return false;
  }
}

/** Esc o «Interrumpir» en una sesión de motor; el fallo queda en el chat. */
export function interruptEngineSession(api: SesionesApi, sessionId: SessionId, engine: EngineId): void {
  api.engineSessionInterrupt(sessionId).catch((e: unknown) => {
    addNote(sessionId, "error", `No se pudo interrumpir ${ENGINE_LABEL[engine]}: ${e instanceof Error ? e.message : String(e)}`);
  });
}
