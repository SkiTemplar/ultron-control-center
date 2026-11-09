import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNMATCHED_GRACE_MS, applyStreamList, getStreamEntries, matchMessages, matchStream, pushStream, resetStreamsForTests, scheduleTurnCleanup,
} from "../stream";
import type { ChatMessage, StreamPayload } from "../types";

const p = (step: number, text: string, extra: Partial<StreamPayload> = {}): StreamPayload => ({
  id: "s1", agentId: null, turnId: "T", step, block: 0, text, done: false, ...extra,
});

async function flushFrames() {
  await new Promise((r) => window.setTimeout(r, 40));
}

describe("texto en vivo por identidad (§5.3)", () => {
  beforeEach(() => resetStreamsForTests());
  afterEach(() => vi.useRealTimers());

  it("cada paso es una entrada distinta: nunca «A.## B»", () => {
    let list = applyStreamList([], p(0, "A."));
    list = applyStreamList(list, p(1, "## B"));
    expect(list.map((e) => e.text)).toEqual(["A.", "## B"]);
    expect(list.map((e) => e.key)).toEqual(["T:main:0:0", "T:main:1:0"]);
  });

  it("el razonamiento sale con stepDone y una entrada sin texto desaparece", () => {
    let list = applyStreamList([], p(0, "pienso", { thinking: true }));
    expect(list[0].thinking).toBe("pienso");
    list = applyStreamList(list, p(0, "", { stepDone: true }));
    expect(list).toEqual([]);
  });

  it("el delta de razonamiento (bandera del backend) no se pinta como respuesta ni concatena «true»", () => {
    let list = applyStreamList([], p(0, "Leo ", { thinking: true }));
    list = applyStreamList(list, p(0, "el fichero", { thinking: true }));
    expect(list[0].thinking).toBe("Leo el fichero");
    expect(list[0].text).toBe("");
    list = applyStreamList(list, p(0, "", { stepDone: true }));
    expect(list).toEqual([]);
  });

  it("stepEnd (bloque 0) cierra también el texto del bloque 1 y el razonamiento; otro paso no (caso negativo)", () => {
    let list = applyStreamList([], p(0, "pienso", { thinking: true }));
    list = applyStreamList(list, p(0, "Respuesta", { block: 1 }));
    list = applyStreamList(list, p(1, "Sigue", { block: 1 }));
    list = applyStreamList(list, p(0, "", { stepDone: true }));
    expect(list.map((e) => [e.key, e.text, e.thinking, e.stepDone])).toEqual([
      ["T:main:0:1", "Respuesta", "", true],
      ["T:main:1:1", "Sigue", "", false],
    ]);
  });

  it("stream-matched retira la burbuja antes del turnEnd; otra clave no (caso negativo)", async () => {
    pushStream(p(0, "Hola"));
    pushStream(p(1, "Adiós"));
    await flushFrames();
    matchStream("s1", "T:main:0:0");
    expect(getStreamEntries("s1", null).map((e) => e.text)).toEqual(["Adiós"]);
    matchStream("s1", "otra:main:0:0");
    expect(getStreamEntries("s1", null)).toHaveLength(1);
  });

  it("un mensaje con streamKey retira su entrada aunque llegue antes que el último delta", async () => {
    const m: ChatMessage = { uuid: "m1", role: "assistant", timestamp: "", agentId: null, blocks: [{ kind: "text", text: "Hola mundo" }], streamKey: "T:main:0:0" };
    matchMessages("s1", [m]);
    pushStream(p(0, "Hola mundo"));
    await flushFrames();
    expect(getStreamEntries("s1", null)).toEqual([]);
  });

  it("sin pareja, la entrada sale 2 s después del fin del turno y no antes", () => {
    vi.useFakeTimers();
    pushStream(p(0, "parcial"));
    vi.advanceTimersByTime(20);
    expect(getStreamEntries("s1", null)).toHaveLength(1);
    scheduleTurnCleanup("s1", "T");
    vi.advanceTimersByTime(UNMATCHED_GRACE_MS - 100);
    expect(getStreamEntries("s1", null)).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(getStreamEntries("s1", null)).toEqual([]);
  });

  it("un turno cerrado sin turnId retira el razonamiento sin stepDone (hallazgo 42)", () => {
    vi.useFakeTimers();
    pushStream(p(0, "pienso", { thinking: true }));
    vi.advanceTimersByTime(20);
    expect(getStreamEntries("s1", null)).toHaveLength(1);
    scheduleTurnCleanup("s1", "", 0);
    vi.advanceTimersByTime(1);
    expect(getStreamEntries("s1", null)).toEqual([]);
  });

  it("sin turnId solo retira los turnos que había al cerrar, no el que empieza después (caso negativo)", () => {
    vi.useFakeTimers();
    pushStream(p(0, "viejo"));
    vi.advanceTimersByTime(20);
    scheduleTurnCleanup("s1", "");
    pushStream(p(0, "nuevo", { turnId: "U" }));
    vi.advanceTimersByTime(UNMATCHED_GRACE_MS + 50);
    expect(getStreamEntries("s1", null).map((e) => e.text)).toEqual(["nuevo"]);
  });
});
