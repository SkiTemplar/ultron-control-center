import { describe, expect, it } from "vitest";
import { ageFrom, classifyPlanError, planStaleView } from "./planStale";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const NOW_SECS = NOW / 1000;

describe("classifyPlanError", () => {
  it("un 401/403 es token rechazado, no «sin conexión»", () => {
    expect(
      classifyPlanError("token OAuth rechazado (401/403). Abre Claude Code para renovar la sesión."),
    ).toBe("auth");
    expect(classifyPlanError("credentials.json sin accessToken")).toBe("auth");
  });

  it("un fallo de red con la URL «/oauth/usage» sigue siendo red (caso negativo)", () => {
    expect(
      classifyPlanError("GET https://api.anthropic.com/api/oauth/usage: error sending request"),
    ).toBe("network");
    expect(classifyPlanError("sin red")).toBe("network");
  });

  it("vacío u otro motivo cae en «other»", () => {
    expect(classifyPlanError(null)).toBe("other");
    expect(classifyPlanError("respuesta de uso ilegible: EOF")).toBe("other");
  });

  it("un estado HTTP del servidor (429, 5xx) no es «sin conexión» (caso negativo)", () => {
    expect(classifyPlanError("endpoint de uso devolvió HTTP 429 Too Many Requests")).toBe("other");
    expect(classifyPlanError("endpoint de uso devolvió HTTP 503 Service Unavailable")).toBe("other");
    expect(classifyPlanError("cliente HTTP: builder error")).toBe("network");
  });
});

describe("ageFrom", () => {
  it("formatea minutos, horas y días", () => {
    expect(ageFrom(NOW_SECS - 30, NOW)).toBe("ahora mismo");
    expect(ageFrom(NOW_SECS - 12 * 60, NOW)).toBe("hace 12 min");
    expect(ageFrom(NOW_SECS - 5 * 3600, NOW)).toBe("hace 5 h");
    expect(ageFrom(NOW_SECS - 3 * 86400, NOW)).toBe("hace 3 d");
  });

  it("sin instante válido no inventa antigüedad", () => {
    expect(ageFrom(0, NOW)).toBeNull();
    expect(ageFrom(Number.NaN, NOW)).toBeNull();
  });
});

describe("planStaleView", () => {
  it("datos frescos sin error de refresco: nada que avisar (caso negativo)", () => {
    expect(planStaleView({ stale: false, fetched_at: NOW_SECS }, null, NOW)).toBeNull();
    expect(planStaleView(null, "boom", NOW)).toBeNull();
  });

  it("stale por token caducado: etiqueta propia, motivo, pista y antigüedad", () => {
    const v = planStaleView(
      { stale: true, fetched_at: NOW_SECS - 40 * 60, last_error: "token OAuth rechazado (401/403)." },
      null,
      NOW,
    );
    expect(v?.kind).toBe("auth");
    expect(v?.label).toMatch(/token rechazado/);
    expect(v?.label).not.toMatch(/sin conexión/);
    expect(v?.detail).toMatch(/401/);
    expect(v?.hint).toMatch(/renovar/);
    expect(v?.age).toBe("hace 40 min");
  });

  it("un refresco fallido sobre datos viejos también se avisa", () => {
    const v = planStaleView({ stale: false, fetched_at: NOW_SECS - 7200 }, "sin red", NOW);
    expect(v?.kind).toBe("network");
    expect(v?.detail).toBe("sin red");
    expect(v?.age).toBe("hace 2 h");
  });
});
