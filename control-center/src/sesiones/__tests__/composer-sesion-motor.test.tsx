// F3 de la paridad (plans/2026-11-06-sesiones-motor-paridad-claude.md): una
// sesión de motor usa el mismo Composer que Claude. Enter con el motor libre abre
// un turno (`engineSessionSend`), ocupado va a la cola; Esc y «Interrumpir» cortan
// el turno del motor (no el PTY de Claude); no hay selector de destino ni
// comandos de Claude, y «Enviar ya» explica que aún no existe en vez de no hacer nada.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Composer } from "../components/composer/Composer";
import { ApiContext } from "../context";
import { store } from "../store";
import type { EngineStatus, SessionInfo } from "../types";

const IDLE: SessionInfo = {
  id: "m1", projectId: "p", projectName: "p", cwd: "C:/p", title: "Codex · p", claudeSessionId: null, status: "idle", model: "gpt-6.1-sol",
  startedAt: "", bridgeConnected: false, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "unknown",
  permissionMode: null, launchPermissionMode: "default", exitCode: null, bridgeProtocol: 0, engine: "codex",
};
const WORKING: SessionInfo = { ...IDLE, status: "working" };
const READY: EngineStatus[] = [{ id: "codex", available: true } as EngineStatus, { id: "gemini", available: true } as EngineStatus];

const ENGINE_COMMANDS = [{ name: "compact", description: "Compacta el hilo", source: "motor", kind: "prompt" }];
const DEFAULTS: Record<string, unknown> = { promptHistory: [], listFiles: [], commands: ENGINE_COMMANDS, engineModels: [], queueEnqueue: [], queueMove: [], queueSendNow: [] };

type Calls = Map<string, ReturnType<typeof vi.fn>>;

function fakeApi(calls: Calls, order: string[]): SesionesApi {
  return new Proxy({ isMock: true }, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (prop === "then") return undefined;
      if (!calls.has(prop)) {
        const fn = prop === "gitSnapshot"
          ? vi.fn().mockRejectedValue(new Error("sin git"))
          : vi.fn(async () => {
            order.push(prop);
            return DEFAULTS[prop];
          });
        calls.set(prop, fn);
      }
      return calls.get(prop);
    },
  }) as SesionesApi;
}

function mount(info: SessionInfo) {
  const calls: Calls = new Map();
  const order: string[] = [];
  act(() => {
    store.dispatch({ type: "sessions", sessions: [info] });
    store.dispatch({ type: "engineStatus", engines: READY });
  });
  render(<ApiContext.Provider value={fakeApi(calls, order)}><Composer sessionId={info.id} /></ApiContext.Provider>);
  const box = screen.getByRole("textbox", { name: "Mensaje" });
  return { calls, order, box };
}

async function type(box: HTMLElement, text: string, key: Partial<KeyboardEvent> = { key: "Enter", code: "Enter" }) {
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, key);
    await new Promise((r) => setTimeout(r, 0));
  });
}

const notes = () => store.getState().bySession.m1?.notes ?? [];

afterEach(() => {
  cleanup();
  act(() => store.dispatch({ type: "sessions", sessions: [] }));
});

describe("Composer de una sesión de motor", () => {
  it("Enter con el motor libre abre un turno con engineSessionSend y no toca la cola de Claude", async () => {
    const { calls, box } = mount(IDLE);
    await type(box, "arregla el test");
    expect(calls.get("engineSessionSend")).toHaveBeenCalledWith({ id: "m1", text: "arregla el test" });
    expect(calls.get("send")).toBeUndefined();
    expect(calls.get("queueEnqueue")).toBeUndefined();
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("sin selector de destino ni subagente; con «Comandos» del motor y el modelo de la sesión", () => {
    mount(IDLE);
    expect(screen.queryByTestId("send-target")).toBeNull();
    expect(screen.getByRole("button", { name: /Comandos/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Subagente" })).toBeNull();
    expect(screen.getByTestId("engine-session-model").textContent).toContain("gpt-6.1-sol");
  });

  it("con el motor ocupado, Enter encola en vez de abrir un turno", async () => {
    const { calls, box } = mount(WORKING);
    expect(screen.getByTestId("enqueue").textContent).toContain("Encolar");
    await type(box, "y luego esto");
    expect(calls.get("engineSessionSend")).toBeUndefined();
    const [args] = calls.get("queueEnqueue")?.mock.calls[0] ?? [];
    expect(args).toMatchObject({ id: "m1", item: { text: "y luego esto", delegate: false, kind: "prompt" } });
  });

  it("Esc con la caja vacía interrumpe el turno del motor, no el PTY de Claude", async () => {
    const { calls, box } = mount(WORKING);
    await type(box, "", { key: "Escape", code: "Escape" });
    expect(calls.get("engineSessionInterrupt")).toHaveBeenCalledWith("m1");
    expect(calls.get("recover")).toBeUndefined();
  });

  it("«Interrumpir y enviar» encola, pone el mensaje delante y después interrumpe", async () => {
    const { order, box } = mount(WORKING);
    await type(box, "para y haz esto", { key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true });
    expect(order.filter((p) => p.startsWith("queue") || p === "engineSessionInterrupt")).toEqual(["queueEnqueue", "queueMove", "engineSessionInterrupt"]);
  });

  it("«Enviar ya» (Ctrl+Enter) con Codex encola y lo pasa al turno activo (queueSendNow)", async () => {
    const { calls, order, box } = mount(WORKING);
    fireEvent.change(box, { target: { value: "ya" } });
    expect(screen.getByTestId("send-now")).toBeTruthy();
    await type(box, "ya", { key: "Enter", code: "Enter", ctrlKey: true });
    expect(order.filter((p) => p.startsWith("queue"))).toEqual(["queueEnqueue", "queueSendNow"]);
    const [args] = calls.get("queueSendNow")?.mock.calls[0] ?? [];
    expect(args).toMatchObject({ id: "m1" });
  });

  it("«Enviar ya» con Gemini no es un no-op: explica que no lo admite y encola", async () => {
    const { calls, box } = mount({ ...WORKING, engine: "gemini" });
    fireEvent.change(box, { target: { value: "ya" } });
    expect(screen.queryByTestId("send-now")).toBeNull();
    await type(box, "ya", { key: "Enter", code: "Enter", ctrlKey: true });
    expect(calls.get("queueEnqueue")).toHaveBeenCalledTimes(1);
    expect(calls.get("queueSendNow")).toBeUndefined();
    expect(notes().some((n) => n.text.includes("Gemini no admite añadir mensajes a un turno en curso"))).toBe(true);
  });

  it("la paleta «/» ofrece solo los comandos del motor y Enter los manda como texto", async () => {
    const { calls, box } = mount(IDLE);
    fireEvent.change(box, { target: { value: "/", selectionStart: 1 } });
    await act(async () => {
      fireEvent.change(box, { target: { value: "/com", selectionStart: 4 } });
      await new Promise((r) => setTimeout(r, 0));
    });
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options.some((t) => t.includes("compact"))).toBe(true);
    expect(options.some((t) => t.includes("mejorar") || t.includes("export"))).toBe(false);
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", code: "Enter" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.get("engineSessionSend")).toHaveBeenCalledWith({ id: "m1", text: "/compact" });
  });

  it("caso negativo: una sesión de Claude sigue usando su propio envío", async () => {
    const claude: SessionInfo = { ...IDLE, id: "m1", engine: undefined, claudeSessionId: "c", screen: "prompt", bridgeConnected: true, bridgeProtocol: 2, permissionMode: "bypassPermissions" };
    const { calls, box } = mount(claude);
    await type(box, "hola");
    expect(calls.get("engineSessionSend")).toBeUndefined();
    expect(screen.getByTestId("send-target")).toBeTruthy();
  });
});
