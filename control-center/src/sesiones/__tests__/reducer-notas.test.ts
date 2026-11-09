// Hallazgo 37: las notas del chat son de la sesión de ULTRON, no de la
// conversación de Claude: un reset (/clear, compactación) no las borra y la
// cota deja sitio a una sesión larga. Los registros de turno siguen acotados.

import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../reducer";
import type { TurnPayload } from "../types";

function withNotes(n: number): State {
  let s = initialState;
  for (let i = 0; i < n; i += 1) {
    s = reducer(s, { type: "note", id: "s1", note: { id: `n${i}`, at: "2026-10-13T10:00:00Z", level: "info", text: `nota ${i}` } });
  }
  return s;
}

const turn = (i: number): TurnPayload => ({
  id: "s1", turnId: `t${i}`, startedAt: "", endedAt: "", durationMs: 0, reason: "answer",
});

describe("notas del chat a través de un reset", () => {
  it("150 notas y luego un reset: siguen las 150", () => {
    const s = reducer(withNotes(150), { type: "reset", id: "s1" });
    expect(s.bySession.s1.notes).toHaveLength(150);
    expect(s.bySession.s1.notes[0].text).toBe("nota 0");
  });

  it("caso negativo: el reset sí vacía los mensajes y los registros de turno", () => {
    let s = reducer(withNotes(1), { type: "messages", id: "s1", messages: [{ uuid: "m", role: "user", timestamp: "", agentId: null, blocks: [] }] });
    s = reducer(s, { type: "turn", payload: turn(0) });
    s = reducer(s, { type: "reset", id: "s1" });
    expect(s.bySession.s1.messages).toEqual([]);
    expect(s.bySession.s1.turns).toEqual([]);
    expect(s.bySession.s1.notes).toHaveLength(1);
  });

  it("las notas siguen acotadas: no crecen sin límite", () => {
    expect(withNotes(1200).bySession.s1.notes.length).toBeLessThan(1200);
  });
});
