// Sesiones de motor (Codex, Gemini y OpenCode sin Claude, 2026-11-04): el panel pinta los
// turnos `chat` en orden y el texto en curso, Enviar llama a `engineSessionSend`
// y se bloquea con un turno vivo, «+ Codex»/«+ Gemini» crean la sesión o se
// deshabilitan si el motor no está, y Motores no enseña los turnos `chat`.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Motores, tasksOfSession } from "../components/inspector/Motores";
import { NewEngineSession } from "../components/NewEngineSession";
import { PaneView } from "../components/Pane";
import { Sidebar } from "../components/Sidebar";
import { ApiContext } from "../context";
import { resetEngineModelsCache } from "../engines";
import { createMockApi } from "../mock/api-mock";
import { setPrefs } from "../prefs";
import { store } from "../store";
import type { EngineStatus, EngineTask, SessionInfo, TurnPayload } from "../types";

const ENGINE_SESSION: SessionInfo = {
  id: "m-1", projectId: "ultron", projectName: "ultron", cwd: "C:/p", title: "Codex · ultron", claudeSessionId: null, status: "idle",
  model: null, startedAt: "2026-11-04T10:00:00Z", bridgeConnected: false, waiting: null, stalled: null, workingSince: null,
  lastActivityAt: "2026-11-04T10:00:00Z", turnId: null, screen: "unknown", permissionMode: null, launchPermissionMode: "default",
  exitCode: null, bridgeProtocol: 0, engine: "codex",
};
const CLAUDE_SESSION: SessionInfo = { ...ENGINE_SESSION, id: "c-1", title: "Claude", claudeSessionId: "conv", engine: undefined, bridgeProtocol: 2 };

const READY: EngineStatus[] = [
  { id: "codex", available: true, version: "codex 0.154" },
  { id: "gemini", available: true, version: "agy 1.2" },
];

function turn(over: Partial<EngineTask>): EngineTask {
  return {
    id: "t", engine: "codex", kind: "chat", mode: "local", cwd: "C:/p", prompt: "x", status: "done",
    startedAt: "2026-11-04T10:00:00Z", events: [], sessionId: ENGINE_SESSION.id, ...over,
  };
}

/** API de prueba: lo que no se pasa rechaza con un error explícito. */
function fakeApi(overrides: Partial<Record<keyof SesionesApi, unknown>>): SesionesApi {
  return new Proxy({ isMock: true } as unknown as SesionesApi, {
    get(target, key: string) {
      if (key in overrides) return overrides[key as keyof SesionesApi];
      if (key in target) return (target as unknown as Record<string, unknown>)[key];
      return () => Promise.reject(new Error(`${key}: no implementado en el test`));
    },
  });
}

const withApi = (api: SesionesApi, node: ReactNode) => <ApiContext.Provider value={api}>{node}</ApiContext.Provider>;

beforeEach(() => {
  resetEngineModelsCache();
  act(() => {
    store.dispatch({ type: "sessions", sessions: [ENGINE_SESSION, CLAUDE_SESSION] });
    store.dispatch({ type: "engineList", tasks: [] });
    store.dispatch({ type: "engineStatus", engines: READY });
  });
});

afterEach(() => {
  // Desmontar antes de vaciar el store: si no, el panel pasaría a montar el chat de Claude.
  cleanup();
  act(() => {
    store.dispatch({ type: "sessions", sessions: [] });
    store.dispatch({ type: "engineList", tasks: [] });
  });
});

describe("panel de una sesión de motor", () => {
  it("el panel monta el mismo chat que Claude para una sesión de motor (F3)", async () => {
    const history = vi.fn(async () => ({ messages: [], hasMore: false }));
    render(withApi(fakeApi({ history, agents: async () => [], workflows: async () => [], promptHistory: async () => [], commands: async () => [] }),
      <PaneView pane={{ key: "p0", sessionId: ENGINE_SESSION.id, agentId: null }} index={0} focused count={1} />));
    expect(screen.queryByTestId("engine-chat")).toBeNull();
    expect(await screen.findByText("Sesión de Codex lista")).toBeTruthy();
    expect(history).toHaveBeenCalledWith({ id: ENGINE_SESSION.id });
  });
});

describe("«+ Codex», «+ Gemini» y «+ OpenCode»", () => {
  it("«+ Codex» crea la sesión en el proyecto elegido", async () => {
    const engineSessionCreate = vi.fn(async () => ({ ...ENGINE_SESSION, id: "m-nueva" }));
    const api = fakeApi({
      engineSessionCreate,
      engineModels: async () => [],
      engineSessionPast: async () => [],
      projects: async () => [{ id: "tfg", name: "TFG", path: "C:/tfg" }],
    });
    render(withApi(api, <NewEngineSession engine="codex" focusedId={null} />));
    await act(async () => fireEvent.click(screen.getByTestId("new-engine-codex")));
    await act(async () => fireEvent.click(await screen.findByRole("option", { name: /TFG/ })));
    await waitFor(() => expect(engineSessionCreate).toHaveBeenCalledWith({ engine: "codex", projectId: "tfg" }));
    expect(store.getState().sessions.some((s) => s.id === "m-nueva")).toBe(true);
  });

  it("«+ Gemini» retoma una sesión cerrada del mismo motor y no ofrece las de Codex", async () => {
    const engineSessionCreate = vi.fn(async () => ({ ...ENGINE_SESSION, engine: "gemini" as const }));
    const past = [
      { id: "g-old", engine: "gemini" as const, projectId: "ultron", projectName: "ultron", cwd: "C:/p", title: "plan del TFG", startedAt: "", lastActivityAt: "2026-11-03T10:00:00Z", turns: 3 },
      { id: "c-old", engine: "codex" as const, projectId: "ultron", projectName: "ultron", cwd: "C:/p", title: "refactor de Codex", startedAt: "", lastActivityAt: "2026-11-03T10:00:00Z", turns: 1 },
    ];
    const api = fakeApi({ engineSessionCreate, engineModels: async () => [], engineSessionPast: async () => past, projects: async () => [] });
    render(withApi(api, <NewEngineSession engine="gemini" focusedId={null} />));
    await act(async () => fireEvent.click(screen.getByTestId("new-engine-gemini")));
    expect(screen.queryByRole("option", { name: /refactor de Codex/ })).toBeNull();
    await act(async () => fireEvent.click(await screen.findByRole("option", { name: /plan del TFG/ })));
    await waitFor(() => expect(engineSessionCreate).toHaveBeenCalledWith({ engine: "gemini", resume: "g-old" }));
  });

  it("caso negativo: con el motor no disponible el botón está deshabilitado y dice por qué", async () => {
    act(() => store.dispatch({ type: "engineStatus", engines: [READY[0], { id: "gemini", available: false, reason: "No se encontró agy" }] }));
    const engineSessionCreate = vi.fn();
    const projects = vi.fn(async () => []);
    render(withApi(fakeApi({ engineSessionCreate, projects, engineSessionPast: async () => [] }), <Sidebar onPicked={() => undefined} />));
    const gemini = screen.getByTestId("new-engine-gemini") as HTMLButtonElement;
    expect(gemini.disabled).toBe(true);
    expect(gemini.title).toContain("No se encontró agy");
    await act(async () => fireEvent.click(gemini));
    expect(projects).not.toHaveBeenCalled();
    expect(engineSessionCreate).not.toHaveBeenCalled();
    expect((screen.getByTestId("new-engine-codex") as HTMLButtonElement).disabled).toBe(false);
  });

  it("la barra lateral distingue la sesión de motor con su distintivo", () => {
    render(withApi(fakeApi({}), <Sidebar onPicked={() => undefined} />));
    const row = screen.getByText("Codex · ultron").closest(".sess") as HTMLElement;
    expect(within(row).getByTestId("sess-engine").textContent).toBe("CX");
  });

  it("«+ OpenCode» crea la sesión aquí y la barra la marca como OC", async () => {
    act(() => store.dispatch({ type: "engineStatus", engines: [...READY, { id: "opencode", available: true, version: "1.19.4" }] }));
    setPrefs({ engineModels: { codex: null, gemini: null, opencode: "openrouter/cohere/north-mini-code:free" } });
    const created: SessionInfo = { ...ENGINE_SESSION, id: "oc-1", title: "OpenCode · ultron", engine: "opencode" };
    const engineSessionCreate = vi.fn(async () => created);
    const api = fakeApi({ engineSessionCreate, engineModels: async () => [], engineSessionPast: async () => [], projects: async () => [] });
    render(withApi(api, <Sidebar onPicked={() => undefined} />));
    await act(async () => fireEvent.click(screen.getByTestId("new-engine-opencode")));
    await act(async () => fireEvent.click(await screen.findByRole("option", { name: /Aquí/ })));
    await waitFor(() => expect(engineSessionCreate).toHaveBeenCalledWith(expect.objectContaining({ engine: "opencode" })));
    const row = (await screen.findByText("OpenCode · ultron")).closest(".sess") as HTMLElement;
    expect(within(row).getByTestId("sess-engine").textContent).toBe("OC");
    setPrefs({ engineModels: { codex: null, gemini: null, opencode: null } });
  });

  it("caso negativo: OpenCode disponible pero sin modelo elegido no deja crear la sesión", () => {
    act(() => store.dispatch({ type: "engineStatus", engines: [...READY, { id: "opencode", available: true, version: "1.19.4" }] }));
    render(withApi(fakeApi({}), <Sidebar onPicked={() => undefined} />));
    const oc = screen.getByTestId("new-engine-opencode") as HTMLButtonElement;
    expect(oc.disabled).toBe(true);
    expect(oc.title).toContain("elige antes un modelo de OpenCode");
  });

  it("caso negativo: sin OpenCode en la detección, «+ OpenCode» está deshabilitado", () => {
    render(withApi(fakeApi({}), <Sidebar onPicked={() => undefined} />));
    const oc = screen.getByTestId("new-engine-opencode") as HTMLButtonElement;
    expect(oc.disabled).toBe(true);
    expect(oc.title).toContain("OpenCode");
  });
});

describe("Motores sin turnos chat", () => {
  it("tasksOfSession excluye los turnos chat (y sigue vacía sin sesión)", () => {
    const chat = turn({ id: "chat", sessionId: CLAUDE_SESSION.id });
    const tarea = turn({ id: "tarea", kind: "task", sessionId: CLAUDE_SESSION.id });
    expect(tasksOfSession([chat, tarea], CLAUDE_SESSION).map((t) => t.id)).toEqual(["tarea"]);
    expect(tasksOfSession([turn({ id: "propio" })], ENGINE_SESSION)).toEqual([]);
    expect(tasksOfSession([chat, tarea], null)).toEqual([]);
  });

  it("en una sesión de motor no ofrece intervenciones ni pinta sus turnos chat", () => {
    act(() => store.dispatch({ type: "engineList", tasks: [
      turn({ id: "chat", prompt: "turno de conversación" }),
    ] }));
    render(withApi(fakeApi({ engines: async () => READY }), <Motores session={ENGINE_SESSION} />));
    expect(screen.queryByText("turno de conversación")).toBeNull();
    expect(screen.queryByRole("button", { name: "Lanzar" })).toBeNull();
    expect(screen.getByText(/las intervenciones de motores se lanzan desde una sesión de Claude/)).toBeTruthy();
  });

  it("en una sesión de Claude pinta las intervenciones y no los turnos chat", () => {
    act(() => store.dispatch({ type: "engineList", tasks: [
      turn({ id: "chat", prompt: "turno de conversación", sessionId: CLAUDE_SESSION.id }),
      turn({ id: "tarea", kind: "task", prompt: "intervención real", sessionId: CLAUDE_SESSION.id }),
    ] }));
    render(withApi(fakeApi({ engines: async () => READY }), <Motores session={CLAUDE_SESSION} />));
    expect(screen.queryByText("turno de conversación")).toBeNull();
    expect(screen.getByText("intervención real")).toBeTruthy();
  });
});

describe("mock de sesiones de motor", () => {
  it("crea la sesión, responde con mensajes del chat y la retoma tras cerrarla", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockApi({ autoplay: false });
      const turns: TurnPayload[] = [];
      await api.on("sesiones://turn", (t) => turns.push(t));
      const info = await api.engineSessionCreate({ engine: "codex", projectId: "ultron" });
      expect(info.engine).toBe("codex");
      const first = await api.engineSessionSend({ id: info.id, text: "hola" });
      expect(first.kind).toBe("chat");
      await expect(api.engineSessionSend({ id: info.id, text: "otra" })).rejects.toThrow("la sesión ya está trabajando");
      await vi.runAllTimersAsync();
      expect(turns.map((t) => t.reason)).toEqual(["answer"]);
      const page = await api.history({ id: info.id });
      expect(page.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(JSON.stringify(page.messages[1].blocks)).toContain("hola");
      await api.engineSessionSend({ id: info.id, text: "larga" });
      await api.engineSessionInterrupt(info.id);
      expect(turns.map((t) => t.reason)).toEqual(["answer", "aborted"]);
      await api.kill(info.id);
      const past = await api.engineSessionPast();
      expect(past.map((p) => p.id)).toEqual([info.id]);
      const again = await api.engineSessionCreate({ engine: "codex", resume: info.id });
      expect(again.id).toBe(info.id);
    } finally {
      vi.useRealTimers();
    }
  });
});
