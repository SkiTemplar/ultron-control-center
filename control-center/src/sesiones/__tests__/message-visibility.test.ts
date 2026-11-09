import { describe, expect, it } from "vitest";
import { rendersNothing } from "../components/chat/Message";
import type { ChatMessage } from "../types";

const results = new Map();
const tool = { kind: "toolUse" as const, id: "t1", name: "Bash", input: {}, summary: "ls" };

function assistant(blocks: ChatMessage["blocks"]): ChatMessage {
  return { uuid: "a", role: "assistant", timestamp: "2026-10-13T00:00:00Z", blocks, agentId: null };
}

const compact = { compactTools: true, expanded: false };

describe("rendersNothing: filas que la lista virtual omite", () => {
  it("una respuesta con solo herramientas plegadas no pinta nada", () => {
    expect(rendersNothing(assistant([tool]), { results }, compact)).toBe(true);
  });

  it("con texto, con el turno desplegado o al cerrar el turno sí pinta (caso negativo)", () => {
    expect(rendersNothing(assistant([tool, { kind: "text", text: "Hecho" }]), { results }, compact)).toBe(false);
    expect(rendersNothing(assistant([tool]), { results }, { compactTools: true, expanded: true })).toBe(false);
    expect(rendersNothing(assistant([tool]), { results, endsTurn: true }, compact)).toBe(false);
    expect(rendersNothing(assistant([tool]), { results }, { compactTools: false, expanded: false })).toBe(false);
  });

  it("la primera respuesta del turno lleva la línea de actividad", () => {
    const activity = { tools: 1, byName: [["Bash", 1]] as [string, number][], toolIds: ["t1"] };
    expect(rendersNothing(assistant([tool]), { results, activity }, compact)).toBe(false);
  });

  it("un aviso dentro del turno se omite solo plegado", () => {
    const sys: ChatMessage = { ...assistant([{ kind: "text", text: "interrumpido" }]), role: "system" };
    expect(rendersNothing(sys, { results, inTurn: true }, compact)).toBe(true);
    expect(rendersNothing(sys, { results, inTurn: true }, { compactTools: true, expanded: true })).toBe(false);
    expect(rendersNothing(sys, { results }, compact)).toBe(false);
  });
});
