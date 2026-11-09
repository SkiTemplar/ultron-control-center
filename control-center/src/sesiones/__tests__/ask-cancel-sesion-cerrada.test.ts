// `gestor::kill` saca la sesión del registro antes de cancelar sus preguntas
// (M1): el `ask-resolved` con `sessionExited` llega después de que
// `sesiones://sessions` la haya purgado y no puede resucitar su estado.
import { describe, expect, it } from "vitest";
import { onAskResolved } from "../bootstrap";
import { store } from "../store";
import type { SessionInfo } from "../types";

const session = (id: string) => ({ id, status: "idle" }) as unknown as SessionInfo;

describe("ask-resolved de una sesión que ya no existe", () => {
  it("quita la pregunta sin crear estado para la sesión cerrada", () => {
    store.dispatch({ type: "sessions", sessions: [session("viva")] });
    store.dispatch({ type: "ask", ask: { askId: "a1", id: "cerrada", kind: "plan", plan: "p" } });
    onAskResolved({ askId: "a1", id: "cerrada", outcome: "cancelled", reason: "sessionExited" });
    const s = store.getState();
    expect(s.asks.some((a) => a.askId === "a1")).toBe(false);
    expect(s.bySession.cerrada).toBeUndefined();
  });

  it("caso positivo: en una sesión viva deja la nota de la cancelación", () => {
    store.dispatch({ type: "sessions", sessions: [session("viva")] });
    onAskResolved({ askId: "a2", id: "viva", outcome: "cancelled", reason: "interrupted" });
    const notes = store.getState().bySession.viva?.notes ?? [];
    expect(notes[notes.length - 1]?.text).toBe("Pregunta cancelada: interrumpiste el turno.");
  });
});
