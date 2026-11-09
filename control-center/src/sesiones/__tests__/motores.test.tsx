// WP-MOTORES: el modelo elegido llega de verdad a `engineRun` (también desde la
// pestaña Motores), un modelo retirado no se envía, Codex Cloud usa el suyo y
// los fallos de la lista de modelos se recuerdan 60 s.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Motores } from "../components/inspector/Motores";
import { ApiContext } from "../context";
import { MODELS_ERROR_TTL_MS, loadEngineModels, resetEngineModelsCache, resolveEngineModel, runEngine } from "../engines";
import { SESSIONS } from "../mock/data";
import { setPrefs } from "../prefs";
import type { EngineRunArgs, EngineTask } from "../types";

const TASK: EngineTask = {
  id: "t1", engine: "codex", kind: "task", mode: "local", cwd: "C:/p", prompt: "x",
  status: "running", startedAt: new Date().toISOString(), events: [],
};

/** API de prueba: lo que no se pasa rechaza con un error explícito. */
export function fakeApi(overrides: Partial<Record<keyof SesionesApi, unknown>>): SesionesApi {
  return new Proxy({ isMock: true } as unknown as SesionesApi, {
    get(target, key: string) {
      if (key in overrides) return overrides[key as keyof SesionesApi];
      if (key in target) return (target as unknown as Record<string, unknown>)[key];
      return () => Promise.reject(new Error(`${key}: no implementado en el test`));
    },
  });
}

function withApi(api: SesionesApi, node: ReactNode) {
  return <ApiContext.Provider value={api}>{node}</ApiContext.Provider>;
}

const MODELS = [{ id: "gpt-6-astra", label: "GPT-6-Astra" }, { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }];

beforeEach(() => {
  resetEngineModelsCache();
  setPrefs({ engineModels: { codex: "gpt-6-astra", gemini: null, opencode: null } });
});
afterEach(() => setPrefs({ engineModels: { codex: null, gemini: null, opencode: null } }));

describe("runEngine aplica el modelo elegido", () => {
  it("manda el modelo de las preferencias en Codex local", async () => {
    const engineRun = vi.fn(async (_a: EngineRunArgs) => TASK);
    const api = fakeApi({ engineRun, engineModels: async () => MODELS });
    await runEngine(api, { sessionId: "s1", engine: "codex", prompt: "hola", kind: "task" });
    expect(engineRun).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-6-astra", includeContext: true, mode: "local" }));
  });

  it("con Codex Cloud no manda modelo (caso negativo)", async () => {
    const engineRun = vi.fn(async (_a: EngineRunArgs) => TASK);
    const api = fakeApi({ engineRun, engineModels: async () => MODELS });
    await runEngine(api, { sessionId: "s1", engine: "codex", prompt: "hola", kind: "task", cloud: true });
    expect(engineRun.mock.calls[0][0].model).toBeUndefined();
    expect(engineRun.mock.calls[0][0].mode).toBe("cloud");
  });

  it("un modelo retirado de la lista no se envía", async () => {
    setPrefs({ engineModels: { codex: "gpt-4-retirado", gemini: null, opencode: null } });
    const engineRun = vi.fn(async (_a: EngineRunArgs) => TASK);
    const api = fakeApi({ engineRun, engineModels: async () => MODELS });
    await runEngine(api, { sessionId: "s1", engine: "codex", prompt: "hola", kind: "task" });
    expect(engineRun.mock.calls[0][0].model).toBeUndefined();
  });

  it("sin lista (la CLI no respondió) se manda la preferencia y la valida el backend", () => {
    expect(resolveEngineModel("codex", false, null)).toBe("gpt-6-astra");
    expect(resolveEngineModel("gemini", false, MODELS)).toBeUndefined();
  });

  it("respeta includeContext=false", async () => {
    const engineRun = vi.fn(async (_a: EngineRunArgs) => TASK);
    const api = fakeApi({ engineRun, engineModels: async () => MODELS });
    await runEngine(api, { sessionId: "s1", engine: "codex", prompt: "hola", kind: "task", includeContext: false });
    expect(engineRun.mock.calls[0][0].includeContext).toBe(false);
  });
});

describe("lista de modelos", () => {
  it("un fallo se recuerda 60 s sin relanzar la CLI", async () => {
    const engineModels = vi.fn(async () => {
      throw new Error("codex no respondió en 10 s");
    });
    const api = fakeApi({ engineModels });
    await expect(loadEngineModels(api, "codex", 1_000)).rejects.toThrow("10 s");
    await expect(loadEngineModels(api, "codex", 30_000)).rejects.toThrow("10 s");
    expect(engineModels).toHaveBeenCalledTimes(1);
    await expect(loadEngineModels(api, "codex", 1_000 + MODELS_ERROR_TTL_MS + 1)).rejects.toThrow();
    expect(engineModels).toHaveBeenCalledTimes(2);
  });
});

describe("pestaña Motores", () => {
  it("Lanzar usa runEngine con el modelo elegido y el contexto marcado", async () => {
    const engineRun = vi.fn(async (_a: EngineRunArgs) => TASK);
    const api = fakeApi({ engineRun, engineModels: async () => MODELS, engines: async () => [] });
    render(withApi(api, <Motores session={SESSIONS[0]} />));
    fireEvent.change(screen.getByPlaceholderText(/qué tiene que hacer Codex/), { target: { value: "revisa el parser" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Contexto del hilo/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Lanzar" })));
    await waitFor(() => expect(engineRun).toHaveBeenCalled());
    expect(engineRun.mock.calls[0][0]).toMatchObject({ model: "gpt-6-astra", includeContext: false, prompt: "revisa el parser" });
    expect(screen.getByTestId("engine-model-codex")).toBeTruthy();
  });

  it("«Traer a Claude» se deshabilita mientras envía", async () => {
    let release: () => void = () => undefined;
    const engineBring = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const api = fakeApi({ engineBring, engines: async () => [], engineModels: async () => MODELS });
    const { store } = await import("../store");
    store.dispatch({ type: "engine", task: { ...TASK, id: "t-bring", status: "done", sessionId: SESSIONS[0].id } });
    render(withApi(api, <Motores session={SESSIONS[0]} />));
    const btn = screen.getAllByRole("button", { name: "Traer a Claude" })[0];
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(engineBring).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Enviando…" })).toHaveProperty("disabled", true);
    await act(async () => release());
  });
});
