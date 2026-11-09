import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouterMetrics } from "./RouterMetrics";
import { routeSuccess } from "./routeSuccess";
import type { RouteOutcome, RouterMetrics as Metrics } from "./types";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const outcomes = (failed: number, primary: number): RouteOutcome[] => [
  ...Array<RouteOutcome>(failed).fill("failed"),
  ...Array<RouteOutcome>(primary).fill("primary"),
];

const model = { provider_id: "groq", model: "m", count: 3, success_count: 3, output_tokens: 10, latency_ms_avg: 1 };

/** Datos de la caída medida el 2026-11-01: 3/3 intentos OK y 192/200 rutas sin respuesta. */
const OUTAGE = {
  fallback_output_tokens: 0,
  cost_saved_usd: 0,
  by_class: {},
  by_model: { "groq::m": model },
  routes_total: 2628,
  routes_failed: 231,
  recent_outcomes: outcomes(192, 8),
} as unknown as Metrics;

describe("routeSuccess", () => {
  it("cuenta las rutas sin respuesta aunque ningún intento haya fallado", () => {
    const s = routeSuccess(OUTAGE);
    expect(s.pct).toBe(4);
    expect(s.failedRecent).toBe(192);
    expect(s.window).toBe(200);
    expect(Math.round(s.cumulativePct ?? 0)).toBe(91);
  });

  it("sin ventana usa el acumulado y sin rutas no inventa un porcentaje", () => {
    expect(routeSuccess({ ...OUTAGE, recent_outcomes: undefined }).pct).toBeCloseTo(91.2, 0);
    expect(routeSuccess({ ...OUTAGE, recent_outcomes: [], routes_total: 0, routes_failed: 0 }).pct).toBeNull();
  });

  it("con todas las rutas respondidas da 100", () => {
    expect(routeSuccess({ ...OUTAGE, recent_outcomes: outcomes(0, 5) }).pct).toBe(100);
  });
});

describe("RouterMetrics", () => {
  beforeEach(() => invokeMock.mockReset());

  it("la tarjeta dice 4 % en rojo durante la caída, no 100 % en verde", async () => {
    invokeMock.mockResolvedValue(OUTAGE);
    render(<RouterMetrics />);
    const value = await screen.findByText("4%");
    expect(value.style.color).toContain("--color-danger");
    expect(screen.getByText("Éxito por ruta")).toBeTruthy();
    expect(screen.getByText(/192 de 200 rutas sin respuesta/)).toBeTruthy();
    expect(screen.queryByText("100%", { selector: "span.text-\\[22px\\]" })).toBeNull();
  });

  it("si la cadena se salta entera (0 intentos) no dice que no hay tráfico", async () => {
    invokeMock.mockResolvedValue({ ...OUTAGE, by_model: {} });
    render(<RouterMetrics />);
    expect(await screen.findByText("4%")).toBeTruthy();
    expect(screen.queryByText(/aún no está registrando tráfico/)).toBeNull();
  });

  it("sin rutas ni intentos sí lo dice", async () => {
    invokeMock.mockResolvedValue({ ...OUTAGE, by_model: {}, routes_total: 0, routes_failed: 0, recent_outcomes: [] });
    render(<RouterMetrics />);
    expect(await screen.findByText(/aún no está registrando tráfico/)).toBeTruthy();
  });
});
