// Mascota — conversación en curso de cada motor del chat, guardada en disco
// por el backend (mascot/chat_log.rs, `cockpit/mascot-chat.json`) para que
// «ver chat» la enseñe entera y no se pierda al reiniciar.
//
// Se guarda la conversación completa (hasta MAX_TURNS); al modelo solo le
// llegan los últimos MODEL_TURNS turnos, como antes.

import { useEffect, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentId } from "./icons";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface SavedConversation {
  agent: AgentId;
  tainted: boolean;
  /** Un turno trajo web o ficheros: el freno pide confirmar cada acción (chat_gate.rs). */
  gateTainted: boolean;
  turns: Turn[];
}

/** Turnos que viajan al modelo como contexto. */
export const MODEL_TURNS = 16;
/** Turnos que se guardan (el backend aplica el mismo tope). */
export const MAX_TURNS = 200;

export const modelHistory = (turns: readonly Turn[]): Turn[] => turns.slice(-MODEL_TURNS);

/** La conversación con una pregunta y su respuesta más. Pura. */
export function appendExchange(turns: readonly Turn[], question: string, answer: string): Turn[] {
  return [...turns, { role: "user" as const, text: question }, { role: "assistant" as const, text: answer }].slice(
    -MAX_TURNS,
  );
}

export const loadConversations = () => invoke<SavedConversation[]>("mascot_chat_load");

export const saveConversation = (conversation: SavedConversation) =>
  invoke<void>("mascot_chat_save", { conversation });

export const archiveConversation = (agent: AgentId) => invoke<void>("mascot_chat_archive", { agent });

/**
 * Al arrancar, la conversación en curso de cada motor vuelve del disco. No
 * pisa la de un motor con el que ya se ha hablado en esta vuelta.
 */
export function useSavedChat(
  ready: boolean,
  historyRef: MutableRefObject<Record<AgentId, Turn[]>>,
  taintedRef: MutableRefObject<Record<AgentId, boolean>>,
  gateTaintedRef: MutableRefObject<Record<AgentId, boolean>>,
  showErrorRef: MutableRefObject<(text: string) => void>,
) {
  useEffect(() => {
    if (!ready) return;
    loadConversations()
      .then((list) => {
        for (const c of list) {
          if (historyRef.current[c.agent].length) continue;
          historyRef.current[c.agent] = c.turns;
          taintedRef.current[c.agent] = c.tainted;
          gateTaintedRef.current[c.agent] = c.gateTainted;
        }
      })
      .catch((err) => showErrorRef.current(`No pude recuperar el chat guardado: ${String(err)}`));
  }, [ready, historyRef, taintedRef, gateTaintedRef, showErrorRef]);
}
