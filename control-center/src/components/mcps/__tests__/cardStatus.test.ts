import { describe, expect, it } from "vitest";
import { mcpHealthLine, shouldShowUnknownBadge } from "../cardStatus";

const NOW = Date.parse("2026-10-18T12:00:00Z");

describe("mcpHealthLine", () => {
  it("sin fecha: «sin comprobar» y ninguna fecha aparte", () => {
    expect(mcpHealthLine("unknown", false, null, NOW)).toEqual({
      statusText: "sin comprobar",
      checkedText: null,
      stale: true,
    });
    expect(mcpHealthLine("ok", false, "basura", NOW).statusText).toBe("sin comprobar");
  });

  it("servidor ausente de la última pasada: «sin comprobar» aunque la pasada sea reciente", () => {
    expect(mcpHealthLine("unknown", false, "2026-10-18T11:00:00Z", NOW)).toEqual({
      statusText: "sin comprobar",
      checkedText: null,
      stale: true,
    });
  });

  it("fecha vieja: una sola verdad, «comprobado hace 3 meses», sin «sin comprobar»", () => {
    const line = mcpHealthLine("ok", false, "2026-07-20T12:01:33Z", NOW);
    expect(line.statusText).toBe("comprobado hace 3 meses");
    expect(line.checkedText).toBeNull();
    expect(line.stale).toBe(true);
    // Caso negativo: un «ok» de hace meses no se vende como «conectado».
    expect(line.statusText).not.toMatch(/conectado|sin comprobar/);
  });

  it("fecha reciente: el estado y aparte la antigüedad", () => {
    expect(mcpHealthLine("ok", false, "2026-10-18T10:00:00Z", NOW)).toEqual({
      statusText: "conectado",
      checkedText: "comprobado hace 2 h",
      stale: false,
    });
    expect(mcpHealthLine("degraded", true, "2026-10-18T11:00:00Z", NOW).statusText).toBe(
      "desconectado",
    );
  });
});

describe("shouldShowUnknownBadge", () => {
  it("no la pinta en servidores que puso el usuario", () => {
    expect(shouldShowUnknownBadge(true, "user")).toBe(false);
    expect(shouldShowUnknownBadge(true, "plugin")).toBe(false);
    expect(shouldShowUnknownBadge(true, "settings")).toBe(false);
  });

  it("la pinta en un .mcp.json de proyecto o de origen desconocido sin catalogar", () => {
    expect(shouldShowUnknownBadge(true, "project")).toBe(true);
    expect(shouldShowUnknownBadge(true, "unknown")).toBe(true);
  });

  it("nunca si el servidor está en el catálogo", () => {
    expect(shouldShowUnknownBadge(false, "project")).toBe(false);
    expect(shouldShowUnknownBadge(undefined, "unknown")).toBe(false);
  });
});
