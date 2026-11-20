// Delegaciones de `delegate.mjs` en el árbol de Agentes: motor, modelo,
// intento y estado de cada run de la sesión.

import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agentes } from "../components/inspector/Agentes";
import { DELEGATIONS_POLL_MS } from "../components/inspector/Delegaciones";
import { ApiContext } from "../context";
import { SESSIONS } from "../mock/data";
import type { SesionesApi } from "../api";
import type { DelegationRun } from "../types";

const run = (over: Partial<DelegationRun>): DelegationRun => ({
  id: "standard-20261119-1000-ab12", title: "Portar el parser", tier: "standard", status: "running",
  engine: "codex", model: "gpt-6.1-terra", attempt: 2, startedAt: "2026-11-19T10:00:00.000Z",
  attempts: [{ attempt: 1, engine: "claude-p", model: "claude-sonnet-5-5", outcome: "check-fail", reason: "check" }],
  ...over,
});

function withApi(delegations: SesionesApi["delegations"], node: ReactNode) {
  return <ApiContext.Provider value={{ delegations } as unknown as SesionesApi}>{node}</ApiContext.Provider>;
}

const flush = () => act(async () => { await Promise.resolve(); });

describe("Agentes · delegaciones de delegate.mjs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pinta motor, modelo e intento del run en curso y el historial en el título", async () => {
    const delegations = vi.fn(async () => [run({})]);
    render(withApi(delegations, <Agentes session={SESSIONS[0]} currentAgent={null} />));
    await flush();
    expect(delegations).toHaveBeenCalledWith(SESSIONS[0].id);
    const fila = screen.getByText("Portar el parser").closest(".node");
    expect(fila?.textContent).toContain("codex · gpt-6.1-terra · intento 2");
    expect(fila?.textContent).toContain("en curso");
    expect(fila?.getAttribute("title")).toContain("1. claude-p (claude-sonnet-5-5): check-fail · check");
    expect(screen.queryByText("Sin subagentes.")).toBeNull();
  });

  it("sondea y refleja el cambio de estado; sin motor aún no inventa uno", async () => {
    let actual = [run({ engine: null, model: null, attempt: 0, attempts: [] })];
    const delegations = vi.fn(async () => actual);
    render(withApi(delegations, <Agentes session={SESSIONS[0]} currentAgent={null} />));
    await flush();
    const texto = () => screen.getByText("Portar el parser").closest(".node")?.textContent ?? "";
    expect(texto()).toContain("nivel standard · eligiendo motor");
    actual = [run({ status: "done", engine: "claude-p", model: null, attempt: 1 })];
    await act(async () => { await vi.advanceTimersByTimeAsync(DELEGATIONS_POLL_MS); });
    expect(delegations).toHaveBeenCalledTimes(2);
    expect(texto()).toContain("claude-p · modelo por defecto");
    expect(texto()).toContain("✓ check");
    expect(texto()).not.toContain("intento");
  });

  it("caso negativo: sin runs no hay bloque, y un fallo de lectura se dice", async () => {
    const vacio = render(withApi(async () => [], <Agentes session={SESSIONS[0]} currentAgent={null} />));
    await flush();
    expect(screen.queryByTestId("agentes-delegaciones")).toBeNull();
    vacio.unmount();
    render(withApi(async () => { throw new Error("read denegado"); }, <Agentes session={SESSIONS[0]} currentAgent={null} />));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("read denegado");
  });
});
