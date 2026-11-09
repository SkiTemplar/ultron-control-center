// Forzar con Claude trabajando (§3.4): «Enviar ya» (Ctrl+Enter), «Interrumpir y
// enviar» (Ctrl+Mayús+Enter), «Segundo plano» (Ctrl+B) y el atajo de «Subagente»
// (Ctrl+Mayús+D). Ningún atajo ni botón puede quedarse en un no-op mudo.

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Composer } from "../components/composer/Composer";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import { clearDrafts } from "../components/composer/drafts";
import { BACKGROUND_BUSY_TEXT, INTERRUPT_DEBOUNCED_TEXT, NO_FOREGROUND_TEXT, backgroundNote, forceKey, interruptSendNote } from "../components/composer/force";
import { DIALOG_BLOCK_REASON } from "../components/composer/submit";
import { ApiContext } from "../context";
import { useShortcuts } from "../hooks/useShortcuts";
import { store } from "../store";
import { emptyWorkspace, showInFocused, updateWorkspace } from "../workspace";
import type { ForegroundTool, InterruptSendOutcome, QueueItem, SessionInfo } from "../types";

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: "claude-opus-5-5",
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

const ITEM: QueueItem = { clientId: "x", text: "para", attachments: [], delegate: false, kind: "prompt", origin: "ultron", state: "sending", createdAt: "" };
const BASH: ForegroundTool = { toolUseId: "t1", name: "Bash", since: new Date().toISOString(), backgroundable: true };

const DEFAULTS: Record<string, unknown> = {
  promptHistory: [], listFiles: [], commands: FALLBACK_COMMANDS, queueEnqueue: [], engineModels: [],
  settings: { model: null, effort: "high", permissionMode: null, socratic: null, projectId: "p", launchPermissionMode: "bypassPermissions" },
  send: { clientId: "x", disposition: "written" }, runCommand: { disposition: "written" },
  interruptAndSend: { interrupted: true, sent: true, steps: ["encoladoDelante", "turn.abort", "enviado"], item: ITEM },
  background: { ok: true, toolUseId: "t1", tool: "Bash", evidence: "toolEnd", steps: ["pista", "ctrlB", "toolEnd"] },
};

type FakeApi = SesionesApi & Record<string, ReturnType<typeof vi.fn>>;

function fakeApi(overrides: Record<string, unknown> = {}): FakeApi {
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
  }) as FakeApi;
}

function setup(info: Partial<SessionInfo> = {}, overrides: Record<string, unknown> = {}) {
  const api = fakeApi(overrides);
  act(() => store.dispatch({ type: "sessions", sessions: [{ ...base, ...info }] }));
  render(<ApiContext.Provider value={api}><Composer sessionId="s1" /></ApiContext.Provider>);
  return { api, box: screen.getByRole("textbox", { name: "Mensaje" }) };
}

function write(box: HTMLElement, text: string) {
  fireEvent.change(box, { target: { value: text, selectionStart: text.length } });
}

async function press(box: HTMLElement, key: string, opts: Partial<KeyboardEventInit> = {}) {
  await act(async () => {
    fireEvent.keyDown(box, { key, code: key, ...opts });
    await new Promise((r) => setTimeout(r, 0));
  });
}

const notes = () => store.getState().bySession.s1?.notes ?? [];
const lastNote = () => notes()[notes().length - 1];

beforeEach(() => {
  clearDrafts();
  store.dispatch({ type: "reset", id: "s1" });
  store.dispatch({ type: "commands", id: "s1", items: [] });
});
afterEach(() => cleanup());

describe("atajos de forzar (§3.4)", () => {
  it("la tabla de atajos: Ctrl+Enter, Ctrl+Mayús+Enter, Ctrl+B y Ctrl+Mayús+D; sin Ctrl o con Alt, nada", () => {
    const k = (key: string, o: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean } = {}) =>
      forceKey({ key, ctrlKey: o.ctrlKey ?? true, metaKey: false, shiftKey: o.shiftKey ?? false, altKey: o.altKey ?? false });
    expect(k("Enter")).toBe("now");
    expect(k("Enter", { shiftKey: true })).toBe("interrupt");
    expect(k("b")).toBe("background");
    expect(k("D", { shiftKey: true })).toBe("delegate");
    expect(k("Enter", { ctrlKey: false })).toBeNull();
    expect(k("b", { altKey: true })).toBeNull();
    expect(k("B", { shiftKey: true })).toBeNull();
    expect(k("d")).toBeNull();
  });

  it("Ctrl+Enter trabajando manda ya (mode now) y no encola", async () => {
    const { api, box } = setup({ status: "working" });
    write(box, "hola");
    await press(box, "Enter", { ctrlKey: true });
    expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", text: "hola", mode: "now" }));
    expect(api.queueEnqueue).not.toHaveBeenCalled();
  });

  it("Ctrl+Mayús+Enter trabajando interrumpe y envía, con eco y sin nota", async () => {
    const { api, box } = setup({ status: "working" });
    write(box, "para y haz esto");
    await press(box, "Enter", { ctrlKey: true, shiftKey: true });
    expect(api.interruptAndSend).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", text: "para y haz esto", delegate: false, clientId: expect.any(String) }));
    expect(api.send).not.toHaveBeenCalled();
    expect(store.getState().bySession.s1.echoes.map((e) => e.text)).toEqual(["para y haz esto"]);
    expect(notes()).toHaveLength(0);
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("si no pudo interrumpir, avisa de que el mensaje queda el primero de la cola y quita el eco", async () => {
    const out: InterruptSendOutcome = { interrupted: false, sent: false, steps: ["encoladoDelante", "esc", "sigueTrabajando"], item: { ...ITEM, state: "queued" } };
    const { box } = setup({ status: "working" }, { interruptAndSend: out });
    write(box, "para");
    await press(box, "Enter", { ctrlKey: true, shiftKey: true });
    expect(lastNote()).toMatchObject({ level: "warn", text: interruptSendNote(out) });
    expect(lastNote().text).toMatch(/esc → sigueTrabajando.*el primero de la cola/);
    expect(store.getState().bySession.s1.echoes).toHaveLength(0);
  });

  it("un /comando con Ctrl+Mayús+Enter va por interruptAndSend sin eco, no por run_command", async () => {
    const { api, box } = setup({ status: "working" });
    write(box, "/compact");
    await press(box, "Enter", { ctrlKey: true, shiftKey: true });
    expect(api.interruptAndSend).toHaveBeenCalledWith(expect.objectContaining({ text: "/compact" }));
    expect(api.runCommand).not.toHaveBeenCalled();
    expect(store.getState().bySession.s1.echoes).toHaveLength(0);
  });

  it("caso negativo: con un menú abierto, forzar deja una nota de error y no llama a la API", async () => {
    const { api, box } = setup({ status: "waiting", screen: "dialog", waiting: { kind: "menu", label: "/config", since: "" } });
    write(box, "hola");
    await press(box, "Enter", { ctrlKey: true, shiftKey: true });
    await press(box, "Enter", { ctrlKey: true });
    expect(api.interruptAndSend).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(lastNote()).toMatchObject({ level: "error", text: DIALOG_BLOCK_REASON });
    expect((box as HTMLTextAreaElement).value).toBe("hola");
  });

  it("caso negativo: Ctrl+B sin herramienta en primer plano deja un error y no llama al backend", async () => {
    const { api, box } = setup({ status: "working" });
    await press(box, "b", { ctrlKey: true });
    expect(api.background).not.toHaveBeenCalled();
    expect(lastNote()).toMatchObject({ level: "error", text: NO_FOREGROUND_TEXT });
  });

  it("Ctrl+B con un Bash en primer plano llama al backend y confirma", async () => {
    const { api, box } = setup({ status: "working", foregroundTool: BASH });
    await press(box, "b", { ctrlKey: true });
    expect(api.background).toHaveBeenCalledWith({ id: "s1" });
    expect(lastNote()).toMatchObject({ level: "info", text: expect.stringMatching(/Bash terminó o pasó a segundo plano/) });
  });

  it("Ctrl+B con un Bash aún sin pista llega al backend, que espera la pista y explica si no sale", async () => {
    const { api, box } = setup({ status: "working", foregroundTool: { ...BASH, backgroundable: false } });
    await press(box, "b", { ctrlKey: true });
    expect(api.background).toHaveBeenCalledWith({ id: "s1" });
    const sinPista = { ok: false, toolUseId: "t1", tool: "Bash", evidence: "none", steps: ["sinPista"], reason: "Claude Code no lo ofrece ahora (la TUI no pinta «ctrl+b to run in background»); Esc para interrumpir" };
    expect(backgroundNote(sinPista as never)).toMatchObject({ level: "error", text: expect.stringMatching(/^No se pudo pasar Bash a segundo plano: Claude Code no lo ofrece ahora/) });
  });

  it("caso negativo: Ctrl+B con un Read no llama al backend", async () => {
    const { api, box } = setup({ status: "working", foregroundTool: { ...BASH, name: "Read", backgroundable: false } });
    await press(box, "b", { ctrlKey: true });
    expect(api.background).not.toHaveBeenCalled();
    expect(lastNote()).toMatchObject({ level: "error", text: expect.stringMatching(/^Read no se puede pasar a segundo plano/) });
  });

  it("un Ctrl+B sin confirmar o rechazado por el backend se ve como error", async () => {
    const failed = { ok: false, toolUseId: "t1", tool: "Bash", evidence: "none", steps: ["sinPista", "ctrlB", "sinCierre"], reason: "Claude Code no confirmó el paso a segundo plano en 3 s" };
    expect(backgroundNote(failed as never)).toMatchObject({ level: "error", text: expect.stringMatching(/no confirmó/) });
    const { api, box } = setup({ status: "working", foregroundTool: BASH }, { background: undefined });
    vi.mocked(api.background).mockRejectedValueOnce(new Error("Ctrl+B rechazado: no hay ninguna tarea en primer plano"));
    await press(box, "b", { ctrlKey: true });
    expect(lastNote()).toMatchObject({ level: "error", text: expect.stringMatching(/Ctrl\+B rechazado/) });
  });

  it("Ctrl+B mantenido o repetido en vuelo: una sola llamada y sin nota de error", async () => {
    const { api, box } = setup({ status: "working", foregroundTool: BASH }, { background: undefined });
    const errors = () => notes().filter((n) => n.level === "error").length;
    const errorsBefore = errors();
    let resolve: (v: never) => void = () => {};
    vi.mocked(api.background).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    await press(box, "b", { ctrlKey: true });
    await press(box, "b", { ctrlKey: true, repeat: true });
    await press(box, "b", { ctrlKey: true });
    expect(api.background).toHaveBeenCalledTimes(1);
    expect(lastNote()).toMatchObject({ level: "info", text: BACKGROUND_BUSY_TEXT });
    await act(async () => { resolve(DEFAULTS.background as never); await new Promise((r) => setTimeout(r, 0)); });
    expect(lastNote()).toMatchObject({ level: "info", text: expect.stringMatching(/Bash terminó o pasó a segundo plano/) });
    expect(errors()).toBe(errorsBefore);
    // Caso negativo: acabado el vuelo, otra pulsación sí llama.
    await press(box, "b", { ctrlKey: true });
    expect(api.background).toHaveBeenCalledTimes(2);
  });

  it("un «enCurso» o «antirrebote» del backend es informativo, no un error", () => {
    const busy = { ok: false, toolUseId: "", tool: "", evidence: "none" as const, steps: ["enCurso"] };
    expect(backgroundNote(busy)).toEqual({ level: "info", text: BACKGROUND_BUSY_TEXT });
    expect(backgroundNote({ ...busy, steps: ["antirrebote"] }).level).toBe("info");
    expect(backgroundNote({ ...busy, steps: ["ctrlB", "sinCierre"], tool: "Bash" }).level).toBe("error");
  });

  it("con la cola en pausa, la nota pide «Enviar ahora» en vez de prometer el envío al terminar", () => {
    const out = { interrupted: false, sent: false, steps: ["encoladoDelante", "enCurso", "otraNoParo", "colaPausada"], item: { ...ITEM, state: "queued" as const } };
    const note = interruptSendNote(out) ?? "";
    expect(note).toMatch(/en pausa; pulsa «Enviar ahora»/);
    expect(note).not.toMatch(/colaPausada|al terminar el turno/);
    expect(interruptSendNote({ ...out, steps: ["encoladoDelante", "esc", "sigueTrabajando"] })).toMatch(/sale al terminar el turno/);
  });

  it("en el antirrebote la nota explica por qué no se interrumpió, también con la cola en pausa", () => {
    const out = { interrupted: false, sent: false, steps: ["encoladoDelante", "antirrebote"], item: { ...ITEM, state: "queued" as const } };
    const note = interruptSendNote(out) ?? "";
    expect(note.startsWith(INTERRUPT_DEBOUNCED_TEXT)).toBe(true);
    expect(note).toMatch(/menos de 1,5 s/);
    expect(note).toMatch(/sale al terminar el turno\.$/);
    expect(note).not.toMatch(/\(antirrebote\)/);
    const paused = interruptSendNote({ ...out, steps: [...out.steps, "colaPausada"] }) ?? "";
    expect(paused.startsWith(INTERRUPT_DEBOUNCED_TEXT)).toBe(true);
    expect(paused).toMatch(/en pausa; pulsa «Enviar ahora»\.$/);
    expect(paused).not.toMatch(/colaPausada|al terminar el turno/);
  });

  it("Ctrl+Mayús+D alterna «Subagente»", async () => {
    const { box } = setup();
    const chip = screen.getByRole("button", { name: "Subagente" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    await press(box, "D", { ctrlKey: true, shiftKey: true });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    await press(box, "D", { ctrlKey: true, shiftKey: true });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("Ctrl+B global con el foco fuera del composer (§3.4)", () => {
  afterEach(() => act(() => updateWorkspace(() => emptyWorkspace)));

  it("pasa a segundo plano la herramienta de la sesión del panel con foco", async () => {
    const api = fakeApi();
    act(() => {
      store.dispatch({ type: "sessions", sessions: [{ ...base, status: "working", foregroundTool: BASH }] });
      updateWorkspace(() => showInFocused(emptyWorkspace, "s1"));
    });
    renderHook(() => useShortcuts(api));
    await act(async () => {
      fireEvent.keyDown(window, { key: "b", ctrlKey: true });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(api.background).toHaveBeenCalledWith({ id: "s1" });
  });

  it("caso negativo: sin sesión en el panel no hace nada, y con la tecla mantenida solo cuenta la primera", async () => {
    const api = fakeApi();
    renderHook(() => useShortcuts(api));
    act(() => {
      fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    });
    expect(api.background).not.toHaveBeenCalled();
    act(() => {
      store.dispatch({ type: "sessions", sessions: [{ ...base, status: "working", foregroundTool: BASH }] });
      updateWorkspace(() => showInFocused(emptyWorkspace, "s1"));
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "b", ctrlKey: true });
      fireEvent.keyDown(window, { key: "b", ctrlKey: true, repeat: true });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(api.background).toHaveBeenCalledTimes(1);
  });
});

describe("botones de forzar en la barra (§3.4)", () => {
  it("trabajando y con borrador aparecen «Enviar ya» e «Interrumpir y enviar»; Enviar ya manda en modo now", async () => {
    const { api, box } = setup({ status: "working" });
    expect(screen.queryByTestId("send-now")).toBeNull();
    write(box, "hola");
    expect(screen.getByTestId("interrupt-send").title).toMatch(/Ctrl\+Mayús\+Enter/);
    // El límite de la CLI con los hooks de este equipo se declara, no se esconde.
    expect(screen.getByTestId("send-now").title).toMatch(/Ctrl\+Enter.*Ctrl\+B.*PostToolUse.*tool\.call/s);
    await act(async () => {
      fireEvent.click(screen.getByTestId("send-now"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ text: "hola", mode: "now" }));
  });

  it("esperando una respuesta solo ofrece «Interrumpir y enviar»", () => {
    const { box } = setup({ status: "waiting", waiting: { kind: "permission", askId: "k", label: "permiso Bash", since: "" } });
    write(box, "mejor otra cosa");
    expect(screen.getByTestId("interrupt-send")).toBeTruthy();
    expect(screen.queryByTestId("send-now")).toBeNull();
  });

  it("con borrador el Interrumpir suelto deja paso a «Interrumpir y enviar» (una sola fila)", () => {
    const { box } = setup({ status: "working" });
    expect(screen.getByTestId("interrupt")).toBeTruthy();
    write(box, "hola");
    expect(screen.queryByTestId("interrupt")).toBeNull();
    expect(screen.getByTestId("interrupt-send").textContent).toContain("Interrumpir y enviar");
    write(box, "");
    expect(screen.getByTestId("interrupt")).toBeTruthy();
  });

  it("caso negativo: con la sesión libre no aparece ninguno de los dos", () => {
    const { box } = setup();
    write(box, "hola");
    expect(screen.queryByTestId("send-now")).toBeNull();
    expect(screen.queryByTestId("interrupt-send")).toBeNull();
  });
});
