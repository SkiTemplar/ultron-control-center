// «Descartar» un bloque de Codex/Gemini se recuerda entre recargas (localStorage).
// Casos negativos: un valor corrupto o con basura no entra y el tope se respeta.

import { afterEach, describe, expect, it } from "vitest";
import { DISMISSED_KEY, loadDismissed, saveDismissed } from "../engine-dismissed";

afterEach(() => window.localStorage.clear());

describe("descartes de motores persistentes", () => {
  it("lo guardado se vuelve a leer igual", () => {
    expect(saveDismissed(["t1", "t2"])).toBe(true);
    expect(loadDismissed()).toEqual(["t1", "t2"]);
  });

  it("caso negativo: JSON corrupto o entradas que no son ids no entran", () => {
    window.localStorage.setItem(DISMISSED_KEY, "{no es json");
    expect(loadDismissed()).toEqual([]);
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(["ok", 3, "", null, "x".repeat(300)]));
    expect(loadDismissed()).toEqual(["ok"]);
  });

  it("con tope se quedan los más recientes", () => {
    saveDismissed(["a", "b", "c"]);
    expect(loadDismissed(2)).toEqual(["b", "c"]);
  });
});
