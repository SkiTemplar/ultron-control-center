import { describe, expect, it } from "vitest";
import { addUsage, costOf } from "../pricing";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("precios (USO-02)", () => {
  it("la caché de 5 min cuesta 1,25× la entrada y la de 1 h, 2× (Opus 5.5: 5 $ y 8 $ por millón)", () => {
    expect(costOf("claude-opus-5-5", { ...zero, cacheWrite: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 0 })).toBeCloseTo(5, 9);
    expect(costOf("claude-opus-5-5", { ...zero, cacheWrite: 1e6, cacheWrite5m: 0, cacheWrite1h: 1e6 })).toBeCloseTo(8, 9);
  });

  it("claude-haiku-5-5 tiene precio y un modelo desconocido no (caso negativo)", () => {
    expect(costOf("claude-haiku-5-5", { ...zero, input: 1e6 })).toBeCloseTo(0.1, 9);
    expect(costOf("modelo-raro", { ...zero, input: 1e6 })).toBeNull();
  });

  it("el modo rápido duplica el coste y el sufijo [1m] no cambia el precio", () => {
    const u = { ...zero, input: 1e6, output: 1e6 };
    expect(costOf("claude-opus-5-5[1m]", { ...u, speed: "fast" })).toBeCloseTo(48, 9);
    expect(costOf("claude-opus-5-5", { ...u, speed: "standard" })).toBeCloseTo(24, 9);
  });

  it("sumar usos conserva el desglose de caché si uno lo trae", () => {
    const a = { ...zero, cacheWrite: 100, cacheWrite5m: 40, cacheWrite1h: 60 };
    const b = { ...zero, cacheWrite: 10 };
    expect(addUsage(a, b)).toMatchObject({ cacheWrite: 110, cacheWrite5m: 50, cacheWrite1h: 60 });
    expect(addUsage(b, b).cacheWrite5m).toBeUndefined();
  });
});
