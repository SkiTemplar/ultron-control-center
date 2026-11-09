// Sesión del chat que se está pintando, para las piezas memoizadas (acciones
// de turno, bloques de motor) sin pasarla por props a cada mensaje.

import { createContext, useContext } from "react";
import type { SessionId } from "../../types";

export interface ChatScope {
  sessionId: SessionId;
  /** Transcript de un subagente: solo lectura, sin acciones. */
  readOnly: boolean;
  /** Conversación de los marcadores (ver bookmarks.ts); null o ausente = sin marcadores. */
  bookmarks?: string | null;
}

export const ChatScopeContext = createContext<ChatScope | null>(null);

export function useChatScope(): ChatScope | null {
  return useContext(ChatScopeContext);
}
