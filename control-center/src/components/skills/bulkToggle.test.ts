import { describe, expect, it } from "vitest";
import { bulkToggleReport } from "./bulkToggle";

describe("bulkToggleReport", () => {
  it("todo correcto: sin mensaje y selección vacía (caso negativo)", () => {
    const r = bulkToggleReport(
      { requested: 2, succeeded: 2, failed: 0, outcomes: [{ name: "a", ok: true }, { name: "b", ok: true }] },
      true,
      "skill",
    );
    expect(r).toEqual({ message: null, failedNames: [] });
  });

  it("fallo parcial: cuenta, motivo y los fallidos quedan marcados", () => {
    const r = bulkToggleReport(
      {
        requested: 3,
        succeeded: 1,
        failed: 2,
        outcomes: [
          { name: "a", ok: true },
          { name: "b", ok: false, error: "destino ya existe" },
          { name: "c", ok: false },
        ],
      },
      false,
      "agent",
    );
    expect(r.message).toMatch(/^Se han desactivado 1 de 3 agentes; 2 con error: b \(destino ya existe\); c\./);
    expect(r.failedNames).toEqual(["b", "c"]);
  });

  it("recorta la lista larga", () => {
    const outcomes = ["a", "b", "c", "d", "e"].map((name) => ({ name, ok: false, error: "x" }));
    const r = bulkToggleReport({ requested: 5, succeeded: 0, failed: 5, outcomes }, true, "skill");
    expect(r.message).toMatch(/\+2 más/);
    expect(r.failedNames).toHaveLength(5);
  });
});
