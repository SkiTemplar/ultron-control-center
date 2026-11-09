// `/mejorar` en el composer: lo resuelve la app (AI Router, zona light) y deja
// el resultado en el composer para revisarlo; no llega al PTY de Claude.

import type { ChatMessage } from "../../types";

/** Borrador de `/mejorar <borrador>`; `null` si el texto no es ese comando. */
export function parseMejorar(text: string): string | null {
  const m = /^\/mejorar(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? (m[1] ?? "").trim() : null;
}

/** Texto del último resultado de herramienta con error del hilo principal. */
export function lastToolError(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.agentId) continue;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j];
      if (b.kind === "toolResult" && b.isError && b.text.trim()) return b.text.trim().slice(0, 300);
    }
  }
  return null;
}
