// Protección al terminar una sesión: con un turno en curso o envíos en cola se
// pide confirmación aunque Ajustes la tenga desactivada, y se dice qué se pierde.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killRisk } from "../actions";
import type { SesionesApi } from "../api";
import { Sidebar } from "../components/Sidebar";
import { ApiContext } from "../context";
import { DEFAULT_PREFS, prefsStore } from "../prefs";
import { store } from "../store";
import type { EngineTask, QueueItem, SessionInfo } from "../types";

const base: SessionInfo = {
  id: "k1", projectId: "p", projectName: "p", cwd: "C:/p", title: "tarea", claudeSessionId: "c", status: "idle", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: null, launchPermissionMode: "default", exitCode: null, bridgeProtocol: 2,
};

const item = (state: QueueItem["state"]): QueueItem => ({
  clientId: `q-${state}`, text: "x", attachments: [], delegate: false, kind: "prompt", origin: "ultron", state, createdAt: "",
});

function renderSidebar(kill: ReturnType<typeof vi.fn>) {
  const api = { isMock: true, kill } as unknown as SesionesApi;
  render(<ApiContext.Provider value={api}><Sidebar onPicked={() => undefined} /></ApiContext.Provider>);
  return screen.getByRole("button", { name: "Terminar tarea" });
}

describe("killRisk", () => {
  it("dice qué se pierde: turno en curso, espera y envíos pendientes", () => {
    expect(killRisk("working", [])).toMatch(/se cortará el turno/);
    expect(killRisk("waiting", undefined)).toMatch(/espera tu respuesta/);
    expect(killRisk("idle", [item("queued"), item("cliQueued")])).toBe("2 envíos en cola se perderán");
    expect(killRisk("working", [item("sending")])).toMatch(/turno; 1 envío en cola se perderá$/);
  });

  it("cuenta los motores en curso, que se cancelan con la sesión", () => {
    expect(killRisk("idle", [], 1)).toBe("1 motor en curso se cancelará");
    expect(killRisk("idle", undefined, 2)).toBe("2 motores en curso se cancelarán");
    expect(killRisk("working", [item("queued")], 1)).toBe("está trabajando: se cortará el turno; 1 envío en cola se perderá; 1 motor en curso se cancelará");
    expect(killRisk("idle", [], 0)).toBeNull();
  });

  it("sin turno ni pendientes no hay nada que perder (caso negativo)", () => {
    expect(killRisk("idle", [item("delivered"), item("failed"), item("absorbed")])).toBeNull();
    expect(killRisk("exited", undefined)).toBeNull();
    expect(killRisk("starting", [])).toBeNull();
  });
});

describe("terminar una sesión desde la columna", () => {
  beforeEach(() => {
    act(() => prefsStore.dispatch((p) => ({ ...p, confirmKill: false })));
  });
  afterEach(() => {
    act(() => {
      prefsStore.dispatch(() => DEFAULT_PREFS);
      store.dispatch({ type: "sessions", sessions: [] });
    });
  });

  it("con un turno en curso pide confirmación aunque Ajustes no la pida", () => {
    act(() => store.dispatch({ type: "sessions", sessions: [{ ...base, status: "working" }] }));
    const kill = vi.fn().mockResolvedValue(undefined);
    const btn = renderSidebar(kill);
    fireEvent.click(btn);
    expect(kill).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(/Terminar: está trabajando/);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar: terminar tarea" }));
    expect(kill).toHaveBeenCalledWith("k1");
  });

  it("con envíos en cola también pide confirmación", () => {
    act(() => {
      store.dispatch({ type: "sessions", sessions: [base] });
      store.dispatch({ type: "queue", id: "k1", items: [item("queued")] });
    });
    const kill = vi.fn().mockResolvedValue(undefined);
    fireEvent.click(renderSidebar(kill));
    expect(kill).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(/1 envío en cola/);
  });

  describe("con motores", () => {
    const task = (sessionId: string, status: EngineTask["status"]) =>
      ({ id: `t-${sessionId}-${status}`, engine: "codex", kind: "task", mode: "local", cwd: "C:/p", prompt: "x", status, startedAt: "", events: [], sessionId }) as EngineTask;
    const setup = (tasks: EngineTask[]) => act(() => {
      store.dispatch({ type: "sessions", sessions: [base] });
      store.dispatch({ type: "queue", id: "k1", items: [] });
      store.dispatch({ type: "engineList", tasks });
    });
    afterEach(() => {
      act(() => store.dispatch({ type: "engineList", tasks: [] }));
    });

    it("uno en curso de esta sesión pide confirmación y lo dice", () => {
      setup([task("k1", "running"), task("k1", "done"), task("otra", "running")]);
      const kill = vi.fn().mockResolvedValue(undefined);
      fireEvent.click(renderSidebar(kill));
      expect(kill).not.toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toMatch(/Terminar: 1 motor en curso se cancelará/);
    });

    it("caso negativo: uno terminado o de otra sesión no pide confirmar", () => {
      setup([task("k1", "done"), task("otra", "running")]);
      const kill = vi.fn().mockResolvedValue(undefined);
      fireEvent.click(renderSidebar(kill));
      expect(kill).toHaveBeenCalledWith("k1");
    });
  });

  it("libre y sin cola, con la confirmación desactivada, termina al primer clic (caso negativo)", () => {
    act(() => {
      store.dispatch({ type: "sessions", sessions: [base] });
      store.dispatch({ type: "queue", id: "k1", items: [] });
    });
    const kill = vi.fn().mockResolvedValue(undefined);
    fireEvent.click(renderSidebar(kill));
    expect(kill).toHaveBeenCalledWith("k1");
  });
});
