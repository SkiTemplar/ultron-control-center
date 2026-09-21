import { describe, expect, it } from "vitest";
import { motivoEstado } from "../McpCard";

describe("motivoEstado", () => {
  it("degradado dice cuánto tardó", () => {
    // El usuario preguntó el 2026-09-21 "no sé por qué pone degraded". Una
    // etiqueta sin motivo no es información.
    expect(motivoEstado({ status: "degraded", latency_ms: 7400 }, "degraded")).toContain("7.4 s");
  });

  it("degradado sin medición lo dice igual, sin inventar el número", () => {
    expect(motivoEstado({ status: "degraded", latency_ms: null }, "degraded")).toContain("5 s");
  });

  it("un error concreto manda sobre la etiqueta", () => {
    expect(
      motivoEstado({ status: "missing", error: "connection refused on :8080" }, "missing"),
    ).toBe("connection refused on :8080");
  });

  it("conectado y a su hora no inventa un problema", () => {
    // Caso negativo: un MCP sano no puede salir con una coletilla de aviso.
    expect(motivoEstado({ status: "ok", latency_ms: 120 }, "connected")).toBeNull();
  });

  it("no vuelca un error kilométrico en la tarjeta", () => {
    const largo = "x".repeat(400);
    expect(motivoEstado({ status: "missing", error: largo }, "missing")!.length).toBeLessThanOrEqual(120);
  });
});
