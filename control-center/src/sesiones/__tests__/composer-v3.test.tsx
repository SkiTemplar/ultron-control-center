import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { AskCard, planOptions, questionAnswer } from "../components/chat/AskCard";
import { Composer } from "../components/composer/Composer";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import { PermSeg } from "../components/hud/SegmentsSession";
import { ApiContext } from "../context";
import { store } from "../store";
import type { Ask, SessionInfo } from "../types";
import { uiStore } from "../ui";
import { workspaceStore } from "../workspace";

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: "claude-opus-5-5",
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

const DEFAULTS: Record<string, unknown> = {
  promptHistory: [], listFiles: [], commands: FALLBACK_COMMANDS, queueEnqueue: [], engineModels: [],
  settings: { model: null, effort: "high", permissionMode: null, socratic: null, projectId: "p", launchPermissionMode: "bypassPermissions" },
  send: { clientId: "x", disposition: "written" }, runCommand: { disposition: "written" },
  recover: { ok: true, action: "interrupt", steps: [], status: "idle" },
};

function fakeApi(overrides: Record<string, unknown> = {}): SesionesApi & Record<string, ReturnType<typeof vi.fn>> {
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({ isMock: true }, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (!fns.has(prop)) {
        const value = prop in overrides ? overrides[prop] : DEFAULTS[prop];
        fns.set(prop, prop === "gitSnapshot" ? vi.fn().mockRejectedValue(new Error("sin git")) : vi.fn().mockResolvedValue(value));
      }
      return fns.get(prop);
    },
  }) as SesionesApi & Record<string, ReturnType<typeof vi.fn>>;
}

function setup(info: Partial<SessionInfo> = {}, overrides: Record<string, unknown> = {}) {
  const api = fakeApi(overrides);
  act(() => store.dispatch({ type: "sessions", sessions: [{ ...base, ...info }] }));
  render(<ApiContext.Provider value={api}><Composer sessionId="s1" /></ApiContext.Provider>);
  const box = screen.getByRole("textbox", { name: "Mensaje" });
  return { api, box };
}

async function type(box: HTMLElement, text: string, key = "Enter", opts: Partial<KeyboardEventInit> = {}) {
  fireEvent.change(box, { target: { value: text, selectionStart: text.length } });
  await act(async () => {
    fireEvent.keyDown(box, { key, code: key, ...opts });
    await Promise.resolve();
  });
}

const lastNote = () => { const n = store.getState().bySession.s1.notes; return n[n.length - 1]; };

beforeEach(() => {
  store.dispatch({ type: "reset", id: "s1" });
  store.dispatch({ type: "commands", id: "s1", items: [] });
});

describe("composer v3: Enter, Esc y comandos", () => {
  it("con una pregunta pendiente, Enter encola y nunca envía (EST-04)", async () => {
    const { api, box } = setup({ status: "waiting", waiting: { kind: "question", label: "", since: "" } });
    await type(box, "hola");
    expect(api.queueEnqueue).toHaveBeenCalledTimes(1);
    expect(api.send).not.toHaveBeenCalled();
  });

  it("libre, Enter envía con clientId y pinta el eco al momento (VEL-01)", async () => {
    const { api, box } = setup();
    await type(box, "hola");
    expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", text: "hola", mode: "auto", clientId: expect.any(String) }));
    expect(api.queueEnqueue).not.toHaveBeenCalled();
    expect(store.getState().bySession.s1.echoes.map((e) => e.text)).toEqual(["hola"]);
  });

  it("Esc con un menú abierto sale del menú; trabajando interrumpe; con texto no hace nada", async () => {
    const menu = setup({ status: "waiting", screen: "dialog", waiting: { kind: "menu", label: "/config", since: "" } });
    await type(menu.box, "", "Escape");
    expect(menu.api.recover).toHaveBeenCalledWith({ id: "s1", action: "exitMenu" });
  });

  it("Esc trabajando interrumpe y con texto en el composer no llama a recover (caso negativo)", async () => {
    const { api, box } = setup({ status: "working" });
    await type(box, "a medias", "Escape");
    expect(api.recover).not.toHaveBeenCalled();
    await type(box, "", "Escape");
    expect(api.recover).toHaveBeenCalledWith({ id: "s1", action: "interrupt" });
  });

  it("/config va por run_command, sin send y sin abrir la terminal en superposición (AC-2, AC-22)", async () => {
    const { api, box } = setup();
    await type(box, "/config");
    expect(api.runCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "config", args: "" }));
    expect(api.send).not.toHaveBeenCalled();
    expect(workspaceStore.getState().panes.every((p) => !("view" in p))).toBe(true);
    expect(uiStore.getState().menuRequest).toBeNull();
  });

  it("con el cable antiguo (disposition panel), el bloque de menú del chat teclea el comando", async () => {
    const { box } = setup({}, { runCommand: { disposition: "panel", panel: "config" } });
    await type(box, "/config");
    expect(uiStore.getState().menuRequest).toMatchObject({ sessionId: "s1", command: "config" });
  });

  it("/vim deja una nota y no toca la sesión (unsupported)", async () => {
    const { api, box } = setup();
    await type(box, "/vim");
    expect(api.runCommand).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(lastNote()?.text).toMatch(/vim/);
  });

  it("con lista viva, un comando ausente es un error con sugerencias; sin ella se envía con aviso", async () => {
    act(() => store.dispatch({ type: "commands", id: "s1", items: FALLBACK_COMMANDS.slice(0, 5) }));
    const live = setup();
    await type(live.box, "/codex:rescue x");
    expect(live.api.runCommand).not.toHaveBeenCalled();
    expect(lastNote()).toMatchObject({ level: "error" });
  });

  it("sin lista viva, /codex:rescue se envía tal cual con aviso", async () => {
    const { api, box } = setup({ bridgeProtocol: 0 }, { commands: [] });
    await type(box, "/codex:rescue x");
    expect(api.runCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "codex:rescue", args: "x" }));
    expect(store.getState().bySession.s1.notes.some((n) => /no catalogado/.test(n.text))).toBe(true);
  });

  it("sesión terminada: el envío muestra «la sesión terminó» y no llama a la API (AC-13)", async () => {
    const { api, box } = setup({ status: "exited", exitCode: 0 });
    await type(box, "hola");
    expect(api.send).not.toHaveBeenCalled();
    expect(lastNote()?.text).toMatch(/La sesión terminó/);
  });
});

describe("tarjetas de pregunta y plan (§4.3, SC-16)", () => {
  const ask: Ask = {
    askId: "k", id: "s1", kind: "question",
    questions: [{ question: "¿Qué?", header: "", multiSelect: true, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }],
  };

  it("en multiSelect, «Otro» se suma a lo elegido; en selección única sustituye", () => {
    expect(questionAnswer(ask.kind === "question" ? ask.questions[0] : ({} as never), ["A"], "texto")).toBe("A, texto");
    expect(questionAnswer({ question: "q", header: "", multiSelect: false, options: [] }, ["A"], "texto")).toBe("texto");
  });

  it("Responder con A + Otro manda «A, texto»", async () => {
    const api = fakeApi({ answer: undefined });
    render(<ApiContext.Provider value={api}><AskCard ask={ask} /></ApiContext.Provider>);
    fireEvent.click(screen.getByRole("checkbox", { name: /^A/ }));
    expect(screen.getByRole("checkbox", { name: /^A/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByRole("textbox", { name: "Otra respuesta" }), { target: { value: "texto" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Responder" })));
    expect(api.answer).toHaveBeenCalledWith({ askId: "k", answer: { kind: "question", answers: { "¿Qué?": "A, texto" } } });
  });

  it("Rechazar manda rejected y no una respuesta vacía", async () => {
    const api = fakeApi({ answer: undefined });
    render(<ApiContext.Provider value={api}><AskCard ask={ask} /></ApiContext.Provider>);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rechazar" })));
    expect(api.answer).toHaveBeenCalledWith({ askId: "k", answer: { kind: "question", rejected: true } });
  });

  it("la selección única es un radiogroup de radios; la múltiple, casillas", () => {
    const single: Ask = { ...ask, questions: [{ ...ask.questions[0], multiSelect: false }] } as Ask;
    render(<ApiContext.Provider value={fakeApi()}><AskCard ask={single} /></ApiContext.Provider>);
    expect(screen.getByRole("radiogroup", { name: "¿Qué?" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("la tarjeta no repite Interrumpir: el del composer la oculta al momento y pide la interrupción", async () => {
    act(() => store.dispatch({ type: "ask", ask }));
    render(<ApiContext.Provider value={fakeApi()}><AskCard ask={ask} /></ApiContext.Provider>);
    expect(screen.queryByRole("button", { name: "Interrumpir" })).toBeNull();
    const { api, box } = setup({ status: "waiting", waiting: { kind: "question", askId: "k", label: "", since: "" } });
    fireEvent.change(box, { target: { value: "" } });
    await act(async () => fireEvent.click(screen.getByTestId("interrupt")));
    expect(store.getState().interruptingAsks).toContain("k");
    expect(api.recover).toHaveBeenCalledWith({ id: "s1", action: "interrupt" });
  });

  it("el plan ofrece primero mantener bypass si era el modo previo; si no, aceptar ediciones", () => {
    expect(planOptions("bypassPermissions")[0]).toEqual({ label: "Sí, mantener sin permisos (bypass)", mode: "bypassPermissions" });
    expect(planOptions("acceptEdits")[0].mode).toBe("acceptEdits");
    expect(planOptions("default")[0].mode).toBe("default");
  });
});

describe("HUD: modo de permisos real (AC-21)", () => {
  it("bypass lleva la clase de aviso; default no (caso negativo)", () => {
    const api = fakeApi();
    const { container, rerender } = render(<ApiContext.Provider value={api}><PermSeg info={base} mode="bypassPermissions" /></ApiContext.Provider>);
    expect(container.querySelector(".perm-bypass")).not.toBeNull();
    rerender(<ApiContext.Provider value={api}><PermSeg info={base} mode="default" /></ApiContext.Provider>);
    expect(container.querySelector(".perm-bypass")).toBeNull();
  });
});
