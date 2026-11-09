import { describe, expect, it } from "vitest";
import {
  addCatch,
  catchSummary,
  emptyCatches,
  parseCatches,
  rollCatch,
  serializeCatches,
} from "../activities/catches";

describe("capturas de pesca", () => {
  it("un JSON roto, de otra versión o con basura da un recuento vacío", () => {
    expect(parseCatches("{no es json")).toEqual(emptyCatches());
    expect(parseCatches(null)).toEqual(emptyCatches());
    expect(parseCatches(JSON.stringify({ v: 2, counts: { sardina: 3 } }))).toEqual(emptyCatches());
    expect(parseCatches(JSON.stringify({ v: 1, counts: { sardina: -4, bota: "x", ballena: 9 } }))).toEqual(emptyCatches());
  });

  it("ida y vuelta por el almacenamiento", () => {
    const c = addCatch(addCatch(emptyCatches(), "sardina"), "bota");
    expect(parseCatches(serializeCatches(c))).toEqual(c);
  });

  it("sumar una captura no muta el recuento anterior", () => {
    const a = Object.freeze(emptyCatches());
    const b = addCatch(a, "payaso");
    expect(a.payaso).toBe(0);
    expect(b.payaso).toBe(1);
  });

  it("la tabla reparte 50/20/20/10", () => {
    expect(rollCatch(0)).toBe("sardina");
    expect(rollCatch(0.49)).toBe("sardina");
    expect(rollCatch(0.5)).toBe("payaso");
    expect(rollCatch(0.75)).toBe("bota");
    expect(rollCatch(0.95)).toBe("tmp");
  });

  it("resumen para el menú: singular, plural y nada si no ha pescado", () => {
    expect(catchSummary(emptyCatches())).toBeNull();
    const c = addCatch(addCatch(addCatch(emptyCatches(), "sardina"), "sardina"), "tmp");
    expect(catchSummary(c)).toBe("Capturas: 2 sardinas, 1 fichero .tmp");
  });
});
