// Relevo Claude → Codex → Gemini en el árbol de Agentes y en el HUD: las tareas
// del relevo persisten al terminar, el clic lleva al bloque del chat (o lo
// avisa) y el HUD pinta el motor activo con su cuota y tokens solo con relevo.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { relayQuotaText, relayTasks, relayTurnTokens } from "../components/hud/hud-data";
import { RelaySeg } from "../components/hud/SegmentsInfo";
import { Agentes } from "../components/inspector/Agentes";
import { ApiContext } from "../context";
import { SESSIONS } from "../mock/data";
import { store } from "../store";
import type { EnginePlanUsage, EnginesPlanUsage, EngineTask, RelayState } from "../types";

const session = SESSIONS[0];

function task(id: string, extra: Partial<EngineTask> = {}): EngineTask {
  return {
    id, engine: "codex", kind: "relay", mode: "local", cwd: "C:/otra", prompt: `prompt ${id}`, status: "done",
    startedAt: "2026-10-28T10:00:00.000Z", events: [{ kind: "message", text: "hola" }], sessionId: session.id, ...extra,
  };
}

const relay = (extra: Partial<RelayState> = {}): RelayState => ({
  sessionId: session.id, activeEngine: "codex", since: "2026-10-28T10:00:00.000Z", taskIds: [], failedPrompt: "x", ...extra,
});

const codexUsage: EnginePlanUsage = {
  id: "codex", label: "Codex", status: "ok", source: "rollout", readAtMs: 0, plan: "plus", activity: null, note: null,
  windows: [{ kind: "five_hour", group: null, usedPct: 42.4, resetsAtMs: null, expired: false }],
};

function fakeApi(enginesUsage: () => Promise<EnginesPlanUsage>): SesionesApi {
  return new Proxy({} as SesionesApi, {
    get(_t, key: string) {
      if (key === "enginesUsage") return enginesUsage;
      return () => Promise.reject(new Error(`${key}: no implementado en el test`));
    },
  });
}
const withApi = (api: SesionesApi, node: ReactNode) => <ApiContext.Provider value={api}>{node}</ApiContext.Provider>;

afterEach(() => {
  cleanup();
  store.dispatch({ type: "engineList", tasks: [] });
  store.dispatch({ type: "relay", id: session.id, relay: null });
  document.body.innerHTML = "";
});

describe("hud-data del relevo", () => {
  it("reúne las tareas por taskIds y por kind relay de la sesión, no las de otra", () => {
    const tasks = [task("a"), task("b", { kind: "task" }), task("c", { kind: "task" }), task("d", { sessionId: "otra" })];
    expect(relayTasks(tasks, relay({ taskIds: ["b"] }), session.id).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("tokens del turno: suma entrada y salida; sin usage, null", () => {
    expect(relayTurnTokens([task("a", { usage: { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200 } })])).toBe(1200);
    expect(relayTurnTokens([task("a")])).toBeNull();
  });

  it("cuota: ventana del motor activo; sin datos de ese motor, texto explícito", () => {
    const data: EnginesPlanUsage = { generatedAtMs: 0, engines: [codexUsage] };
    expect(relayQuotaText(data, null, "codex")).toBe("5h 42 %");
    expect(relayQuotaText(data, null, "gemini")).toBe("sin datos de uso");
    expect(relayQuotaText(null, "falló", "codex")).toBe("uso no disponible");
  });
});

describe("Agentes con relevo", () => {
  it("las tareas del relevo terminadas siguen en el árbol con eventos y tokens", () => {
    store.dispatch({ type: "engineList", tasks: [
      task("r1", { usage: { inputTokens: 3000, cachedInputTokens: 0, outputTokens: 1000 } }),
      task("r2", { engine: "gemini", status: "error" }),
    ] });
    render(<Agentes session={session} currentAgent={null} />);
    const r1 = screen.getByTestId("relevo-r1");
    expect(r1.textContent).toContain("terminada");
    expect(r1.textContent).toContain("1 ev · 4k tok");
    expect(screen.getByTestId("relevo-r2").textContent).toContain("error");
  });

  it("caso negativo: una tarea normal terminada no sale en el árbol", () => {
    store.dispatch({ type: "engineList", tasks: [task("n1", { kind: "task" })] });
    render(<Agentes session={session} currentAgent={null} />);
    expect(screen.queryByTestId("agentes-relevo")).toBeNull();
    expect(screen.queryByText("prompt n1")).toBeNull();
  });

  it("clic: lleva al bloque del chat; si no existe, deja una nota", () => {
    store.dispatch({ type: "engineList", tasks: [task("r1"), task("r2")] });
    const block = document.createElement("div");
    block.id = "engine-task-r1";
    const scroll = vi.fn();
    block.scrollIntoView = scroll;
    document.body.appendChild(block);
    render(<Agentes session={session} currentAgent={null} />);
    fireEvent.click(screen.getByTestId("relevo-r1"));
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    const before = store.getState().bySession[session.id]?.notes.length ?? 0;
    fireEvent.click(screen.getByTestId("relevo-r2"));
    const notes = store.getState().bySession[session.id]?.notes ?? [];
    expect(notes.length).toBeGreaterThan(before);
    expect(notes[notes.length - 1].text).toContain("no está en el chat visible");
  });
});

describe("Segmento del relevo en el HUD", () => {
  it("sin relevo no pinta nada ni consulta el uso", () => {
    const usage = vi.fn(() => Promise.resolve({ generatedAtMs: 0, engines: [codexUsage] }));
    render(withApi(fakeApi(usage), <RelaySeg id={session.id} />));
    expect(screen.queryByTestId("hud-relay")).toBeNull();
    expect(usage).not.toHaveBeenCalled();
  });

  it("con relevo: motor, cuota de su ventana y tokens del turno", async () => {
    store.dispatch({ type: "engineList", tasks: [task("r1", { usage: { inputTokens: 1500, cachedInputTokens: 0, outputTokens: 500 } })] });
    store.dispatch({ type: "relay", id: session.id, relay: relay({ taskIds: ["r1"] }) });
    render(withApi(fakeApi(() => Promise.resolve({ generatedAtMs: 0, engines: [codexUsage] })), <RelaySeg id={session.id} />));
    await waitFor(() => expect(screen.getByTestId("hud-relay").textContent).toContain("5h 42 %"));
    const seg = screen.getByTestId("hud-relay").textContent ?? "";
    expect(seg).toContain("Codex");
    expect(seg).toContain("2k tok");
  });

  it("motor sin datos de uso: lo dice", async () => {
    store.dispatch({ type: "relay", id: session.id, relay: relay({ activeEngine: "gemini" }) });
    render(withApi(fakeApi(() => Promise.resolve({ generatedAtMs: 0, engines: [codexUsage] })), <RelaySeg id={session.id} />));
    await waitFor(() => expect(screen.getByTestId("hud-relay").textContent).toContain("sin datos de uso"));
    expect(screen.getByTestId("hud-relay").textContent).toContain("tokens sin dato");
  });
});
