// Auditoría de estabilidad nocturna, hallazgo 6: con la ventana oculta no hay
// fotogramas (rAF congelado). Los deltas del texto en vivo no se acumulan sin
// tope: se vacían con un temporizador y, por encima de un umbral, en el acto.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDDEN_FLUSH_MS, PENDING_MAX, getStreamEntries, pushStream, resetStreamsForTests } from "../stream";
import type { StreamPayload } from "../types";

let visibility: DocumentVisibilityState = "visible";

function setVisibility(v: DocumentVisibilityState): void {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

const delta = (text: string, block = 0): StreamPayload =>
  ({ id: "h1", agentId: null, turnId: "T", step: 0, block, text, done: false }) as StreamPayload;

const text = () => getStreamEntries("h1", null).map((e) => e.text).join("|");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  // rAF que nunca llega, como con la ventana minimizada.
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  resetStreamsForTests();
});

afterEach(() => {
  resetStreamsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stream con la ventana oculta", () => {
  it(`oculta: los deltas se publican con un temporizador de ${HIDDEN_FLUSH_MS} ms, sin fotograma`, () => {
    setVisibility("hidden");
    pushStream(delta("Hola"));
    pushStream(delta(" mundo"));
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(text()).toBe("");
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    expect(text()).toBe("Hola mundo");
  });

  it("un fotograma pedido antes de ocultarse pasa a temporizador al ocultarse", () => {
    pushStream(delta("antes"));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    expect(text()).toBe("antes");
  });

  it(`aunque no llegue ni fotograma ni temporizador, más de ${PENDING_MAX} deltas se vacían en el acto`, () => {
    // Visible con rAF congelado (oclusión sin visibilitychange): el peor caso.
    for (let i = 0; i < PENDING_MAX; i += 1) pushStream(delta("x"));
    expect(text()).toBe("x".repeat(PENDING_MAX));
  });

  it("al volver a estar visible el texto queda completo y en orden", () => {
    setVisibility("hidden");
    pushStream(delta("uno "));
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    pushStream(delta("dos"));
    pushStream(delta("tres", 1));
    setVisibility("visible");
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    expect(text()).toBe("uno dos|tres");
  });

  it("visible, sin fotograma todavía, no publica nada (caso negativo: el camino normal sigue siendo rAF)", () => {
    pushStream(delta("espera"));
    vi.advanceTimersByTime(HIDDEN_FLUSH_MS * 4);
    expect(text()).toBe("");
  });
});
