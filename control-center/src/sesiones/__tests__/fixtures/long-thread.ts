// Hilo sintético de una sesión larga para las pruebas de carga y de paginación:
// turnos de diez mensajes (prompt, respuestas con herramientas, resultados y
// respuesta final con `usage`).

import type { ChatMessage } from "../../types";

const BASE = Date.parse("2026-10-01T08:00:00Z");

function at(i: number): string {
  return new Date(BASE + i * 1000).toISOString();
}

export function prompt(uuid: string, i: number, text = `pregunta ${uuid}`): ChatMessage {
  return { uuid, role: "user", timestamp: at(i), agentId: null, kind: "prompt", blocks: [{ kind: "text", text }] };
}

export function toolUse(uuid: string, i: number, toolId: string, name = "Bash"): ChatMessage {
  return {
    uuid, role: "assistant", timestamp: at(i), agentId: null, model: "claude-opus-5-5",
    blocks: [{ kind: "text", text: `Voy a ejecutar ${name}.` }, { kind: "toolUse", id: toolId, name, input: { command: `ls ${toolId}` }, summary: `ls ${toolId}` }],
  };
}

export function toolResult(uuid: string, i: number, toolId: string): ChatMessage {
  return { uuid, role: "user", timestamp: at(i), agentId: null, blocks: [{ kind: "toolResult", toolUseId: toolId, text: `salida de ${toolId}`, isError: false }] };
}

export function answer(uuid: string, i: number, text = `Respuesta **${uuid}** con \`código\`.`): ChatMessage {
  return {
    uuid, role: "assistant", timestamp: at(i), agentId: null, model: "claude-opus-5-5",
    usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0 },
    blocks: [{ kind: "text", text }],
  };
}

/** `count` mensajes en turnos de diez: prompt, cuatro herramientas con su resultado y la respuesta. */
export function longThread(count: number, prefix = "m"): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; out.length < count; i += 1) {
    const slot = i % 10;
    const id = `${prefix}${i}`;
    if (slot === 0) out.push(prompt(id, i));
    else if (slot === 9) out.push(answer(id, i));
    else if (slot % 2 === 1) out.push(toolUse(id, i, `t-${prefix}${i}`));
    else out.push(toolResult(id, i, `t-${prefix}${i - 1}`));
  }
  return out;
}
