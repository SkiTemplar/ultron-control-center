// Búsqueda en el hilo (Ctrl+F): plegado sin mayúsculas ni tildes, conteo y
// navegación circular, salto con resalte del mensaje, Esc que cierra y devuelve
// el foco al composer, aviso de páginas sin cargar y caso negativo (término
// inexistente → «0 de 0» y ningún salto).

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { ChatPane } from "../components/chat/ChatPane";
import { termRanges } from "../components/chat/search-jump";
import { ThreadSearchBar, type ThreadSearchState } from "../components/chat/ThreadSearch";
import { ApiContext } from "../context";
import { useShortcuts } from "../hooks/useShortcuts";
import type { ToolResultBlock } from "../parse";
import { NO_PAGING, type ThreadPaging } from "../session-state";
import { store } from "../store";
import { findMatches, foldedRanges, foldText, matchLabel, requestThreadSearch, stepMatch } from "../thread-search";
import type { TimelineItem } from "../timeline";
import type { ChatMessage, SessionInfo } from "../types";
import { toggleTurn } from "../ui";
import { emptyWorkspace, setPaneTarget, updateWorkspace } from "../workspace";

const info = (id: string): SessionInfo => ({
  id, projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: `conv-${id}`, status: "idle", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
});

const msg = (uuid: string, role: ChatMessage["role"], text: string, at: string): ChatMessage => ({
  uuid, role, timestamp: at, blocks: [{ kind: "text", text }], agentId: null,
});

const THREAD: ChatMessage[] = [
  msg("u1", "user", "Busca la Canción del verano", "2026-10-15T10:00:00.000Z"),
  msg("a1", "assistant", "La CANCION está en el disco", "2026-10-15T10:00:05.000Z"),
  msg("u2", "user", "Otra cosa distinta", "2026-10-15T10:01:00.000Z"),
  msg("a2", "assistant", "Hecho, sin más", "2026-10-15T10:01:05.000Z"),
];

const item = (m: ChatMessage, turn = "t"): TimelineItem => ({ kind: "msg", key: m.uuid, m, continued: false, endsTurn: false, turn });

// --- Lógica pura ----------------------------------------------------------------

describe("búsqueda en el hilo: lógica", () => {
  it("pliega mayúsculas y tildes", () => {
    expect(foldText("Canción ÁRBOL Pingüino")).toBe("cancion arbol pinguino");
    expect(foldText("CAFÉ")).toBe(foldText("café"));
  });

  it("localiza el término plegado en el texto original (para resaltarlo)", () => {
    const text = "Él cantó una canción; CANCIÓN otra vez";
    const ranges = foldedRanges(text, foldText("Cancion"));
    expect(ranges.map(([a, b]) => text.slice(a, b))).toEqual(["canción", "CANCIÓN"]);
    // Tilde en forma descompuesta (e + acento combinable): el rango la incluye.
    const nfd = "cafe\u0301 solo";
    expect(foldedRanges(nfd, "cafe").map(([a, b]) => nfd.slice(a, b))).toEqual(["cafe\u0301"]);
  });

  it("cuenta mensajes con coincidencias, incluidos los resultados de herramientas", () => {
    const tool: ChatMessage = { uuid: "a3", role: "assistant", timestamp: "", agentId: null, blocks: [{ kind: "toolUse", id: "tu1", name: "Bash", input: {}, summary: "ls" }] };
    const results = new Map<string, ToolResultBlock>([["tu1", { kind: "toolResult", toolUseId: "tu1", isError: false, text: "canción.mp3" }]]);
    const items = [...THREAD.map((m) => item(m)), item(tool), { kind: "note", key: "n1", note: { id: "n1", level: "info", text: "canción", at: "" } } as unknown as TimelineItem];
    expect(findMatches(items, results, "  CANCIÓN ").map((m) => m.key)).toEqual(["u1", "a1", "a3"]);
    expect(findMatches(items, results, "")).toEqual([]);
    expect(findMatches(items, results, "   ")).toEqual([]);
  });

  it("navega en círculo y rotula «n de m»", () => {
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(1, 3, 1)).toBe(2);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(-1, 0, 1)).toBe(-1);
    expect(matchLabel(0, 3)).toBe("1 de 3");
    expect(matchLabel(-1, 0)).toBe("0 de 0");
  });

  it("encuentra los rangos del término en el DOM pintado (Markdown incluido)", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Una <b>Canción</b> y otra cancion</p>";
    expect(termRanges(root, "CANCION").map((r) => r.toString())).toEqual(["Canción", "cancion"]);
    expect(termRanges(root, "inexistente")).toEqual([]);
  });
});

// --- Barra aislada: aviso de páginas y caso negativo ------------------------------

function searchState(overrides: Partial<ThreadSearchState> = {}): ThreadSearchState {
  return { owner: "o1", open: true, focusTick: 1, jump: null, setJump: vi.fn(), close: vi.fn(), ...overrides };
}

function bar(search: ThreadSearchState, paging: ThreadPaging = NO_PAGING, onLoadOlder = vi.fn()) {
  return render(<ThreadSearchBar search={search} items={THREAD.map((m) => item(m))} results={new Map()} paging={paging} onLoadOlder={onLoadOlder} />);
}

describe("búsqueda en el hilo: barra", () => {
  afterEach(cleanup);

  it("avisa de mensajes anteriores sin cargar y el botón los pide", () => {
    const onLoadOlder = vi.fn();
    bar(searchState(), { hasMore: true, loading: false, pinned: false }, onLoadOlder);
    expect(screen.getByTestId("thread-search-more")).toHaveTextContent("Hay mensajes anteriores sin cargar");
    fireEvent.click(screen.getByRole("button", { name: "Cargar anteriores" }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("sin páginas pendientes no hay aviso; cargando, el botón queda deshabilitado", () => {
    const { unmount } = bar(searchState());
    expect(screen.queryByTestId("thread-search-more")).toBeNull();
    unmount();
    bar(searchState(), { hasMore: true, loading: true, pinned: false });
    expect(screen.getByRole("button", { name: "Cargando…" })).toBeDisabled();
  });

  it("caso negativo: término inexistente → «0 de 0» y sin salto", async () => {
    const search = searchState();
    bar(search);
    expect(screen.getByRole("textbox", { name: "Buscar en el hilo" })).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar en el hilo" }), { target: { value: "zzz-no-existe" } });
    await waitFor(() => expect(screen.getByTestId("thread-search-count")).toHaveTextContent("0 de 0"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Buscar en el hilo" }), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Coincidencia anterior" })).toBeDisabled();
    expect(search.setJump).not.toHaveBeenCalledWith(expect.objectContaining({ key: expect.any(String) }));
  });

  it("Esc cierra la barra", () => {
    const search = searchState();
    bar(search);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Buscar en el hilo" }), { key: "Escape" });
    expect(search.close).toHaveBeenCalledTimes(1);
  });
});

// --- Integración con el chat ------------------------------------------------------

function fakeApi(): SesionesApi {
  const known: Record<string, unknown> = {
    isMock: true,
    history: async () => ({ messages: THREAD, hasMore: false }),
    gitSnapshot: async () => { throw new Error("sin git en el test"); },
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === "then") return undefined;
      if (prop === "on") return async () => () => undefined;
      return async () => [];
    },
  }) as unknown as SesionesApi;
}

const scrollIntoView = vi.fn();

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const SIZE_PROPS = ["offsetHeight", "offsetWidth"] as const;
const originalSizes = SIZE_PROPS.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));

function mount(id: string) {
  const api = fakeApi();
  return render(
    <ApiContext.Provider value={api}>
      <section data-pane-index="0">
        <ChatPane sessionId={id} agentId={null} />
      </section>
    </ApiContext.Provider>,
  );
}

/** Igual que en los marcadores: se fuerza un repintado para que la lista virtual pinte las filas. */
async function shown(text: string) {
  await waitFor(() => expect(document.querySelector(".vlist")).not.toBeNull());
  act(() => {
    toggleTurn("repintado");
    toggleTurn("repintado");
  });
  await screen.findByText(text);
}

const article = (uuid: string) => document.querySelector<HTMLElement>(`[data-msg-uuid="${uuid}"]`);
const count = () => screen.getByTestId("thread-search-count");
const field = () => screen.getByRole("textbox", { name: "Buscar en el hilo" });

describe("búsqueda en el hilo: chat", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    for (const p of SIZE_PROPS) Object.defineProperty(HTMLElement.prototype, p, { configurable: true, get: () => 600 });
    window.localStorage.clear();
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    SIZE_PROPS.forEach((p, i) => {
      const d = originalSizes[i];
      if (d) Object.defineProperty(HTMLElement.prototype, p, d);
    });
    act(() => updateWorkspace(() => emptyWorkspace));
  });

  it("Ctrl+F abre la barra del panel con foco, cuenta, salta en círculo y resalta", async () => {
    store.dispatch({ type: "sessions", sessions: [info("ts1")] });
    act(() => updateWorkspace((w) => setPaneTarget(w, 0, "ts1", null)));
    renderHook(() => useShortcuts(fakeApi()));
    mount("ts1");
    await shown("Otra cosa distinta");
    expect(screen.queryByTestId("thread-search")).toBeNull();

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(await screen.findByTestId("thread-search")).toBeInTheDocument();
    expect(field()).toHaveFocus();

    fireEvent.change(field(), { target: { value: "cancion" } });
    // Empieza por la coincidencia más reciente.
    await waitFor(() => expect(count()).toHaveTextContent("2 de 2"));
    await waitFor(() => expect(article("a1")).toHaveAttribute("data-search-hit"));
    expect(scrollIntoView.mock.contexts).toContain(article("a1"));

    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(count()).toHaveTextContent("1 de 2"));
    await waitFor(() => expect(article("u1")).toHaveAttribute("data-search-hit"));
    expect(article("a1")).not.toHaveAttribute("data-search-hit");

    // Vuelta al otro extremo, en los dos sentidos.
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(count()).toHaveTextContent("2 de 2"));
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    await waitFor(() => expect(count()).toHaveTextContent("1 de 2"));
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    await waitFor(() => expect(count()).toHaveTextContent("2 de 2"));
  });

  it("Esc cierra, quita el resalte y devuelve el foco al composer", async () => {
    store.dispatch({ type: "sessions", sessions: [info("ts2")] });
    mount("ts2");
    await shown("Otra cosa distinta");
    act(() => requestThreadSearch("ts2", null));
    fireEvent.change(await screen.findByRole("textbox", { name: "Buscar en el hilo" }), { target: { value: "CANCIÓN" } });
    await waitFor(() => expect(article("a1")).toHaveAttribute("data-search-hit"));

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByTestId("thread-search")).toBeNull();
    expect(article("a1")).not.toHaveAttribute("data-search-hit");
    const composer = document.querySelector(".composer textarea");
    expect(composer).not.toBeNull();
    expect(composer).toHaveFocus();
  });

  it("caso negativo: término inexistente en el chat no desplaza ni marca nada", async () => {
    store.dispatch({ type: "sessions", sessions: [info("ts3")] });
    mount("ts3");
    await shown("Otra cosa distinta");
    act(() => requestThreadSearch("ts3", null));
    fireEvent.change(await screen.findByRole("textbox", { name: "Buscar en el hilo" }), { target: { value: "inexistente" } });
    await waitFor(() => expect(count()).toHaveTextContent("0 de 0"));
    fireEvent.keyDown(field(), { key: "Enter" });
    await act(() => new Promise<void>((r) => window.setTimeout(r, 50)));
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.querySelector("[data-search-hit]")).toBeNull();
  });

  it("la petición de otro hilo no abre la barra de este, y con el foco en un campo ajeno Ctrl+F no actúa", async () => {
    store.dispatch({ type: "sessions", sessions: [info("ts4")] });
    act(() => updateWorkspace((w) => setPaneTarget(w, 0, "ts4", null)));
    renderHook(() => useShortcuts(fakeApi()));
    mount("ts4");
    await shown("Otra cosa distinta");
    act(() => requestThreadSearch("otra-sesion", null));
    expect(screen.queryByTestId("thread-search")).toBeNull();

    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(outside, { key: "f", ctrlKey: true });
    expect(screen.queryByTestId("thread-search")).toBeNull();
    outside.remove();
  });
});
