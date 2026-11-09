// Ecos frente al historial y al reset (§5.2). Los mensajes del historial llegan
// sin `clientId`: un envío ya entregado no debe resucitar como eco al abrir o
// recargar la ventana, ni tras un /clear; un prompt repetido de verdad sí se ve.

import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../reducer";
import type { ChatMessage, QueueItem } from "../types";

const SENT = "2026-10-13T10:00:00.000Z";

const item = (clientId: string, text: string, state: QueueItem["state"], sentAt = SENT): QueueItem => ({
  clientId, text, attachments: [], delegate: false, kind: "prompt", origin: "ultron", state, createdAt: sentAt, sentAt,
});

/** Prompt tal y como lo trae el historial: sin `clientId`. */
const prompt = (uuid: string, text: string, timestamp: string): ChatMessage => ({
  uuid, role: "user", timestamp, agentId: null, kind: "prompt", blocks: [{ kind: "text", text }],
});

const echoIds = (s: State) => s.bySession.s1.echoes.map((e) => e.clientId);

describe("eco de un envío entregado frente al historial sin clientId", () => {
  it("cola entregada y luego historial con ese prompt: el eco se retira", () => {
    let s = reducer(initialState, { type: "queue", id: "s1", items: [item("c1", "Arregla el test", "delivered")] });
    expect(echoIds(s)).toEqual(["c1"]);
    s = reducer(s, { type: "history", id: "s1", agentId: null, messages: [prompt("m1", "Arregla el test\n", "2026-10-13T10:00:01.000Z")], generation: 0 });
    expect(echoIds(s)).toEqual([]);
  });

  it("historial primero y luego la cola: un entregado sin messageUuid no se convierte en eco", () => {
    let s = reducer(initialState, { type: "history", id: "s1", agentId: null, messages: [prompt("m1", "Arregla el test", "2026-10-13T10:00:01.000Z")], generation: 0 });
    s = reducer(s, { type: "queue", id: "s1", items: [item("c1", "Arregla el test", "delivered")] });
    expect(echoIds(s)).toEqual([]);
  });

  it("caso negativo: un prompt repetido de verdad (el del historial es anterior al envío) sigue como eco", () => {
    let s = reducer(initialState, { type: "history", id: "s1", agentId: null, messages: [prompt("m0", "sí", "2026-10-13T09:50:00.000Z")], generation: 0 });
    s = reducer(s, { type: "queue", id: "s1", items: [item("c2", "sí", "delivered")] });
    expect(echoIds(s)).toEqual(["c2"]);
  });

  it("caso negativo: dos envíos iguales y un solo mensaje en el hilo dejan un eco", () => {
    let s = reducer(initialState, { type: "history", id: "s1", agentId: null, messages: [prompt("m1", "sigue", "2026-10-13T10:00:01.000Z")], generation: 0 });
    s = reducer(s, {
      type: "queue", id: "s1",
      items: [item("c1", "sigue", "delivered"), item("c2", "sigue", "delivered", "2026-10-13T10:00:00.500Z")],
    });
    expect(echoIds(s)).toHaveLength(1);
  });
});

describe("reset (/clear) frente a los entregados que la cola aún retiene", () => {
  const delivered = [item("c1", "Prompt viejo", "delivered")];

  it("la siguiente instantánea de la cola no resucita los prompts de la conversación anterior", () => {
    let s = reducer(initialState, { type: "history", id: "s1", agentId: null, messages: [prompt("m1", "Prompt viejo", "2026-10-13T10:00:01.000Z")], generation: 0 });
    s = reducer(s, { type: "queue", id: "s1", items: delivered });
    s = reducer(s, { type: "reset", id: "s1" });
    s = reducer(s, { type: "queue", id: "s1", items: delivered });
    expect(echoIds(s)).toEqual([]);
  });

  it("caso negativo: un envío nuevo tras el reset sí aparece como eco", () => {
    let s = reducer(initialState, { type: "queue", id: "s1", items: delivered });
    s = reducer(s, { type: "reset", id: "s1" });
    s = reducer(s, { type: "queue", id: "s1", items: [...delivered, item("c9", "Prompt nuevo", "sending")] });
    expect(echoIds(s)).toEqual(["c9"]);
  });
});

describe("dos resets seguidos y una carga de historial atrasada", () => {
  it("la respuesta de la primera generación se descarta con la segunda vigente", () => {
    let s = reducer(initialState, { type: "reset", id: "s1" });
    const firstGeneration = s.bySession.s1.generation;
    s = reducer(s, { type: "reset", id: "s1" });
    const stale = reducer(s, { type: "history", id: "s1", agentId: null, messages: [prompt("m1", "viejo", SENT)], generation: firstGeneration });
    expect(stale).toBe(s);
    const fresh = reducer(s, { type: "history", id: "s1", agentId: null, messages: [prompt("m2", "nuevo", SENT)], generation: s.bySession.s1.generation });
    expect(fresh.bySession.s1.messages.map((m) => m.uuid)).toEqual(["m2"]);
  });
});
