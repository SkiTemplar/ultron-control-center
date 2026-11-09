// Texto en vivo frente al fin de turno real del puente y al reset de la sesión.
// El `turnEnd` de `puente_aplicar.rs` llega sin `step` ni `block`: debe marcar
// como terminadas todas las entradas del turno para que la red de seguridad las
// retire en cuanto el mensaje definitivo ya está en el hilo.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStreamList, clearSessionStream, getStream, getStreamEntries, pushStream, resetStreamsForTests, setMessagesSource, type StreamEntry,
} from "../stream";
import type { ChatMessage, StreamPayload } from "../types";

const answer = (text: string, agentId: string | null = null): ChatMessage => ({
  uuid: `a-${text}`, role: "assistant", timestamp: "", agentId, blocks: [{ kind: "text", text }],
});

const delta = (turnId: string, text: string, step = 0, block = 0, agentId: string | null = null): StreamPayload => ({
  id: "s1", agentId, turnId, step, block, text, done: false,
});

/** Fin de turno tal y como lo emite el backend: sin `step` ni `block`. */
const turnEnd = (turnId: string, agentId: string | null = null): StreamPayload =>
  ({ id: "s1", agentId, turnId, text: "", done: true }) as unknown as StreamPayload;

const frame = () => new Promise((r) => window.setTimeout(r, 50));

beforeEach(() => resetStreamsForTests());
afterEach(() => setMessagesSource(() => []));

describe("fin de turno sin step ni block (protocolo del puente)", () => {
  it("marca done en todas las entradas del turno y no crea una entrada «undefined»", () => {
    let list: StreamEntry[] = [];
    list = applyStreamList(list, delta("t", "Uno", 0, 0));
    list = applyStreamList(list, delta("t", "Dos", 1, 0));
    list = applyStreamList(list, delta("otro", "Ajeno", 0, 0));
    const next = applyStreamList(list, turnEnd("t"));
    expect(next.map((e) => [e.key, e.done])).toEqual([
      ["t:main:0:0", true],
      ["t:main:1:0", true],
      ["otro:main:0:0", false],
    ]);
    expect(next.some((e) => e.key.includes("undefined"))).toBe(false);
  });

  it("la burbuja cuyo texto ya está en el hilo sale al llegar el fin de turno, sin esperar 2 s", async () => {
    setMessagesSource(() => [answer("Respuesta completa.")]);
    pushStream(delta("t", "Respuesta completa."));
    await frame();
    expect(getStream("s1", null)?.text).toBe("Respuesta completa.");
    pushStream(turnEnd("t"));
    await frame();
    expect(getStream("s1", null)).toBeUndefined();
  });

  it("caso negativo: una burbuja sin pareja en el hilo sigue tras el fin de turno (sale por el retardo de gracia)", async () => {
    setMessagesSource(() => [answer("Otra cosa.")]);
    pushStream(delta("t", "Texto interrumpido"));
    pushStream(turnEnd("t"));
    await frame();
    expect(getStream("s1", null)?.text).toBe("Texto interrumpido");
    expect(getStream("s1", null)?.done).toBe(true);
  });

  it("el fin del turno principal también cierra las entradas de los subagentes de ese turno", async () => {
    setMessagesSource((_, agentId) => (agentId === "ag1" ? [answer("Hecho por el subagente.", "ag1")] : []));
    pushStream(delta("t", "Hecho por el subagente.", 0, 0, "ag1"));
    pushStream(turnEnd("t"));
    await frame();
    expect(getStreamEntries("s1", "ag1")).toEqual([]);
  });
});

describe("reset de la sesión con deltas pendientes del fotograma", () => {
  it("clearSessionStream descarta el lote pendiente: los deltas viejos no reaparecen tras el reset", async () => {
    pushStream(delta("viejo", "Texto de la conversación anterior"));
    clearSessionStream("s1");
    await frame();
    expect(getStream("s1", null)).toBeUndefined();
  });

  it("caso negativo: los deltas pendientes de otra sesión se conservan", async () => {
    pushStream({ ...delta("t", "De otra sesión"), id: "s2" });
    clearSessionStream("s1");
    await frame();
    expect(getStream("s2", null)?.text).toBe("De otra sesión");
  });
});
