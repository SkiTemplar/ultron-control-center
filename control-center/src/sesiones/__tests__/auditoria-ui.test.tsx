// Auditoría de la UI de Sesiones (2026-10-13): un caso por bug, cada uno falla
// sin su arreglo. Composer por sesión, doble envío, pestañas que duplican paneles,
// autorrepetición de atajos, modo de permisos que no sale de «Cargando…», edición
// de la cola perdida en silencio, desplegables fuera de pantalla y log de git ajeno.

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Composer } from "../components/composer/Composer";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import { clearDrafts } from "../components/composer/drafts";
import { QueuePanel } from "../components/composer/QueuePanel";
import { Dropdown, fitSide } from "../components/Dropdown";
import { Git } from "../components/inspector/Git";
import { Sidebar } from "../components/Sidebar";
import { ApiContext } from "../context";
import { useShortcuts } from "../hooks/useShortcuts";
import { store } from "../store";
import type { QueueItem, SessionInfo } from "../types";
import { emptyWorkspace, showInFocused, splitWith, updateWorkspace, workspaceStore } from "../workspace";

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: "claude-opus-5-5",
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

const DEFAULTS: Record<string, unknown> = {
  promptHistory: [], listFiles: [], commands: FALLBACK_COMMANDS, queueEnqueue: [], engineModels: [], projects: [], past: [],
  settings: { model: null, effort: "high", permissionMode: null, socratic: null, projectId: "p", launchPermissionMode: "bypassPermissions" },
  send: { clientId: "x", disposition: "written" }, runCommand: { disposition: "written" },
};

type FakeApi = SesionesApi & Record<string, ReturnType<typeof vi.fn>>;

function fakeApi(overrides: Record<string, ReturnType<typeof vi.fn>> = {}): FakeApi {
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({ isMock: true }, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (!fns.has(prop)) {
        fns.set(prop, overrides[prop] ?? (prop === "gitSnapshot" ? vi.fn().mockRejectedValue(new Error("sin git")) : vi.fn().mockResolvedValue(DEFAULTS[prop])));
      }
      return fns.get(prop);
    },
  }) as FakeApi;
}

function withApi(api: SesionesApi, node: React.ReactNode) {
  return <ApiContext.Provider value={api}>{node}</ApiContext.Provider>;
}

const box = () => screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

beforeEach(() => {
  clearDrafts();
  act(() => {
    store.dispatch({ type: "sessions", sessions: [base, { ...base, id: "s2", title: "otra" }] });
    store.dispatch({ type: "reset", id: "s1" });
    store.dispatch({ type: "reset", id: "s2" });
  });
});

describe("composer por sesión", () => {
  it("el borrador de una sesión no aparece en otra y vuelve al regresar", () => {
    const api = fakeApi();
    const view = render(withApi(api, <Composer sessionId="s1" />));
    fireEvent.change(box(), { target: { value: "borrador de s1", selectionStart: 14 } });
    view.rerender(withApi(api, <Composer sessionId="s2" />));
    expect(box().value).toBe("");
    view.rerender(withApi(api, <Composer sessionId="s1" />));
    expect(box().value).toBe("borrador de s1");
  });

  it("Enter repetido mientras el envío está en vuelo manda una sola vez", async () => {
    let release: (v: unknown) => void = () => undefined;
    const send = vi.fn(() => new Promise((r) => { release = r; }));
    const api = fakeApi({ send });
    render(withApi(api, <Composer sessionId="s1" />));
    fireEvent.change(box(), { target: { value: "hola", selectionStart: 4 } });
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter", code: "Enter" });
      fireEvent.keyDown(box(), { key: "Enter", code: "Enter" });
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ clientId: "x", disposition: "written" });
      await Promise.resolve();
    });
  });
});

describe("pestañas y paneles", () => {
  it("mostrar una sesión que ya está en otro panel le pasa el foco en vez de duplicarla", () => {
    const ws = splitWith(showInFocused(emptyWorkspace, "a"), "b", "right");
    const next = showInFocused({ ...ws, focused: 1 }, "a");
    expect(next.panes.map((p) => p.sessionId)).toEqual(["a", "b"]);
    expect(next.focused).toBe(0);
  });

  it("una sesión que no está en ningún panel sigue entrando en el panel con foco (caso negativo)", () => {
    const ws = splitWith(showInFocused(emptyWorkspace, "a"), "b", "right");
    expect(showInFocused(ws, "c").panes.map((p) => p.sessionId)).toEqual(["a", "c"]);
  });
});

describe("atajos globales", () => {
  afterEach(() => act(() => updateWorkspace(() => emptyWorkspace)));

  it("Ctrl+T mantenido abre una sola sesión y Ctrl+W mantenido cierra un solo panel", async () => {
    const api = fakeApi({ create: vi.fn().mockResolvedValue({ ...base, id: "s3" }) });
    renderHook(() => useShortcuts(api));
    await act(async () => {
      fireEvent.keyDown(window, { key: "t", ctrlKey: true });
      fireEvent.keyDown(window, { key: "t", ctrlKey: true, repeat: true });
      fireEvent.keyDown(window, { key: "t", ctrlKey: true, repeat: true });
      await Promise.resolve();
    });
    expect(api.create).toHaveBeenCalledTimes(1);
    act(() => updateWorkspace(() => splitWith(splitWith(showInFocused(emptyWorkspace, "s1"), "s2", "right"), "s3", "right")));
    act(() => {
      fireEvent.keyDown(window, { key: "w", ctrlKey: true });
      fireEvent.keyDown(window, { key: "w", ctrlKey: true, repeat: true });
    });
    expect(workspaceStore.getState().panes).toHaveLength(2);
  });
});

describe("«+ Claude»", () => {
  it("si no se puede leer el modo de permisos, lo dice en vez de quedarse en «Cargando…»", async () => {
    const api = fakeApi({ prefsGet: vi.fn().mockRejectedValue(new Error("sin prefs")) });
    render(withApi(api, <Sidebar onPicked={() => undefined} />));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ Claude" }));
      await Promise.resolve();
    });
    expect(screen.queryByText("Cargando…")).toBeNull();
    expect(screen.getByText(/No se pudo leer el modo/)).toBeTruthy();
  });
});

describe("cola: edición de un elemento que sale de la cola", () => {
  const item: QueueItem = {
    clientId: "q1", text: "original", attachments: [], delegate: false, kind: "prompt", origin: "ultron", state: "queued", createdAt: "",
  };

  it("si el backend lo envía con el editor abierto, la edición no se pierde en silencio", () => {
    act(() => store.dispatch({ type: "queue", id: "s1", items: [item] }));
    render(withApi(fakeApi(), <QueuePanel sessionId="s1" />));
    fireEvent.click(screen.getByTitle("Editar"));
    fireEvent.change(screen.getByRole("textbox", { name: "Editar mensaje en cola" }), { target: { value: "texto editado" } });
    act(() => store.dispatch({ type: "queue", id: "s1", items: [{ ...item, state: "sending" }] }));
    const notes = store.getState().bySession.s1.notes;
    expect(notes.some((n) => n.level === "warn" && n.text.includes("texto editado"))).toBe(true);
  });

  it("Cancelar no deja ningún aviso (caso negativo)", () => {
    act(() => store.dispatch({ type: "queue", id: "s1", items: [item] }));
    // El reset del beforeEach ya no vacía las notas: se compara con las previas.
    const before = store.getState().bySession.s1.notes.length;
    render(withApi(fakeApi(), <QueuePanel sessionId="s1" />));
    fireEvent.click(screen.getByTitle("Editar"));
    fireEvent.change(screen.getByRole("textbox", { name: "Editar mensaje en cola" }), { target: { value: "otro" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    act(() => store.dispatch({ type: "queue", id: "s1", items: [{ ...item, state: "sending" }] }));
    expect(store.getState().bySession.s1.notes).toHaveLength(before);
  });
});

describe("desplegable al borde de la ventana", () => {
  it("elige el lado con hueco", () => {
    expect(fitSide("down", 600, 30)).toBe("up");
    expect(fitSide("up", 20, 500)).toBe("down");
    expect(fitSide("down", 600, 300)).toBe("down");
  });

  it("abierto hacia abajo junto al borde inferior se abre hacia arriba en vez de salirse", () => {
    render(<Dropdown label="Modelo" options={[{ value: "a", label: "A" }]} trigger={<span>Modelo</span>} />);
    const trigger = screen.getByRole("button", { name: "Modelo" });
    const vh = window.innerHeight;
    trigger.getBoundingClientRect = () => ({ top: vh - 40, bottom: vh - 10, left: 10, right: 100, width: 90, height: 30, x: 10, y: vh - 40, toJSON: () => ({}) });
    fireEvent.click(trigger);
    const pop = document.querySelector<HTMLElement>(".dd-pop");
    expect(pop?.style.top).toBe("");
    expect(pop?.style.bottom).not.toBe("");
    expect(pop?.classList.contains("up")).toBe(true);
  });
});

describe("inspector Git", () => {
  it("el log de un repo anterior que llega tarde no pisa el del repo actual", async () => {
    const snapshot = { state: { is_repo: true, branch: "main", remote: null, ahead: 0, behind: 0, dirty: false, dirty_count: 0, path: "" }, changes: [] };
    let releaseOld: (v: unknown) => void = () => undefined;
    const gitLog = vi.fn((cwd: string) => (cwd === "C:/viejo"
      ? new Promise((r) => { releaseOld = r; })
      : Promise.resolve([{ hash: "n", short: "nuevo1", author: "", date: "", subject: "del repo nuevo" }])));
    const api = fakeApi({ gitSnapshot: vi.fn().mockResolvedValue(snapshot), gitLog });
    const view = render(withApi(api, <Git cwd="C:/viejo" />));
    await act(async () => { await Promise.resolve(); });
    view.rerender(withApi(api, <Git cwd="C:/nuevo" />));
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      releaseOld([{ hash: "v", short: "viejo1", author: "", date: "", subject: "del repo viejo" }]);
      await Promise.resolve();
    });
    expect(screen.queryByText(/del repo viejo/)).toBeNull();
    expect(screen.getByText(/del repo nuevo/)).toBeTruthy();
  });
});
