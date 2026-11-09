import { describe, expect, it } from "vitest";
import { sameMessageProps } from "../components/chat/Message";
import { buildResultIndex } from "../parse";
import { buildTimelineParts, createTimelineCache, currentTurnActivity } from "../timeline";
import type { ChatMessage } from "../types";
import { answer, longThread, prompt, toolResult, toolUse } from "./fixtures/long-thread";

const msgItems = (items: ReturnType<typeof buildTimelineParts>["items"]) => items.filter((it) => it.kind === "msg");

describe("memo de las filas del chat", () => {
  it("un índice de resultados nuevo no rompe la fila si sus resultados son los mismos", () => {
    const base = longThread(10);
    const m = base[1];
    const before = buildResultIndex(base);
    const after = buildResultIndex([...base, toolResult("otro", 99, "t-otro")]);
    expect(sameMessageProps({ m, results: before }, { m, results: after })).toBe(true);
  });

  it("si llega el resultado de una herramienta de la fila, sí se repinta (caso negativo)", () => {
    const m = toolUse("u", 1, "t-x");
    const before = buildResultIndex([m]);
    const after = buildResultIndex([m, toolResult("r", 2, "t-x")]);
    expect(sameMessageProps({ m, results: before }, { m, results: after })).toBe(false);
  });

  it("la caché reutiliza los objetos de los turnos sin cambios y rehace el que cambió", () => {
    const cache = createTimelineCache();
    const notes: never[] = [];
    const thread = longThread(40);
    const first = msgItems(buildTimelineParts(thread, [], { cache, notes }).items);
    const grown = [...thread, prompt("p-nuevo", 100), toolUse("a-nuevo", 101, "t-nuevo")];
    const second = msgItems(buildTimelineParts(grown, [], { cache, notes }).items);
    // Los cuatro turnos completos conservan sus filas (y su actividad y gasto) tal cual.
    first.forEach((it, i) => expect(second[i]).toBe(it));
    const last = second[second.length - 1];
    expect(last.kind === "msg" && last.activity?.toolIds).toEqual(["t-nuevo"]);
    // Sin caché las filas se recrean (caso negativo).
    const uncached = msgItems(buildTimelineParts(grown, [], { notes }).items);
    expect(uncached[0]).not.toBe(second[0]);
    expect(uncached).toEqual(second);
  });

  it("la caché da la misma línea que sin caché tras anteponer una página y recortar la cabeza", () => {
    const cache = createTimelineCache();
    const all = longThread(80);
    buildTimelineParts(all.slice(40), [], { cache });
    const prepended = buildTimelineParts(all, [], { cache }).items;
    expect(prepended).toEqual(buildTimelineParts(all, [], {}).items);
    const trimmed = buildTimelineParts(all.slice(20), [], { cache }).items;
    expect(trimmed).toEqual(buildTimelineParts(all.slice(20), [], {}).items);
  });

  it("la actividad en curso busca el último prompt hacia atrás y no cuenta dos veces un id vivo", () => {
    const thread: ChatMessage[] = [...longThread(30), prompt("p", 50), toolUse("a", 51, "t-1"), answer("b", 52)];
    const act = currentTurnActivity(thread, [
      { toolUseId: "t-1", name: "Bash", agentId: null },
      { toolUseId: "t-2", name: "Read", agentId: null },
    ]);
    expect(act.toolIds).toEqual(["t-1", "t-2"]);
    expect(act.tools).toBe(2);
  });
});
