// Historial paginado del mock (contrato v3 §7): la misma regla de página que el
// backend y una sesión larga sintética (`?largo=N`) para probar la carga de
// anteriores en el e2e.

import type { ChatMessage, HistoryPage, SessionInfo } from "../types";
import { CWD_ULTRON, ago, liveFields } from "./data";

export const HISTORY_LIMIT = 400;
const LIMIT_MAX = 2000;
export const LONG_SESSION_ID = "s-larga";

function opens(m: ChatMessage): boolean {
  return m.role === "user" && m.kind === "prompt";
}

/**
 * Los últimos `limit` mensajes anteriores a `beforeUuid` (sin él, hasta el final);
 * el inicio retrocede hasta el prompt anterior, como mucho otros `limit`.
 * Un cursor que ya no está en el transcript rechaza con `history_cursor_gone`.
 */
export function pageOf(all: readonly ChatMessage[], beforeUuid?: string, limit = HISTORY_LIMIT): HistoryPage {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), LIMIT_MAX);
  const end = beforeUuid === undefined ? all.length : all.findIndex((m) => m.uuid === beforeUuid);
  if (end === -1) throw new Error("history_cursor_gone");
  let start = Math.max(0, end - lim);
  const floor = Math.max(0, start - lim);
  while (start > floor && !opens(all[start])) start -= 1;
  return { messages: all.slice(start, end), hasMore: start > 0 };
}

/** Conversación sintética de `count` mensajes en turnos de cuatro (prompt, herramienta, resultado, respuesta). */
export function longConversation(count: number): ChatMessage[] {
  const base = Date.now() - count * 60000;
  const at = (i: number) => new Date(base + i * 60000).toISOString();
  const out: ChatMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    const turn = Math.floor(i / 4);
    const uuid = `larga-${i}`;
    const slot = i % 4;
    if (slot === 0) out.push({ uuid, role: "user", kind: "prompt", timestamp: at(i), agentId: null, blocks: [{ kind: "text", text: `Mensaje largo ${turn}` }] });
    else if (slot === 1) out.push({ uuid, role: "assistant", timestamp: at(i), agentId: null, model: "claude-opus-5-5", blocks: [{ kind: "toolUse", id: `tl-${i}`, name: "Read", input: { file_path: `src/f${turn}.ts` }, summary: `src/f${turn}.ts` }] });
    else if (slot === 2) out.push({ uuid, role: "user", timestamp: at(i), agentId: null, blocks: [{ kind: "toolResult", toolUseId: `tl-${i - 1}`, isError: false, text: "ok" }] });
    else out.push({ uuid, role: "assistant", timestamp: at(i), agentId: null, model: "claude-opus-5-5", blocks: [{ kind: "text", text: `Respuesta larga ${turn}.` }] });
  }
  return out;
}

export function longSession(): SessionInfo {
  return {
    id: LONG_SESSION_ID, projectId: "ultron", projectName: "ultron", cwd: CWD_ULTRON, title: "Sesión larga",
    claudeSessionId: "larga-conv", status: "idle", model: "claude-opus-5-5", startedAt: ago(60 * 48), bridgeConnected: true,
    ...liveFields("bypassPermissions"),
  };
}
