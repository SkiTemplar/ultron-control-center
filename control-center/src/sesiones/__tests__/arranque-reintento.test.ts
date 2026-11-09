// Arranque fallido: si una suscripción a eventos falla, las que sí entraron se dan
// de baja (un «Reintentar» no duplica los eventos). Caso negativo: sin fallos no se
// da de baja nada.

import { describe, expect, it, vi } from "vitest";
import { allOrUnlisten } from "../bootstrap";

describe("suscripciones del arranque", () => {
  it("con un fallo da de baja las que entraron y propaga el error", async () => {
    const off = vi.fn();
    await expect(allOrUnlisten([Promise.resolve(off), Promise.reject(new Error("sin IPC")), Promise.resolve(off)])).rejects.toThrow("sin IPC");
    expect(off).toHaveBeenCalledTimes(2);
  });

  it("caso negativo: sin fallos devuelve todas y no da de baja ninguna", async () => {
    const off = vi.fn();
    const all = await allOrUnlisten([Promise.resolve(off), Promise.resolve(off)]);
    expect(all).toHaveLength(2);
    expect(off).not.toHaveBeenCalled();
  });
});
