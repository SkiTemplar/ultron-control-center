// Marcadores en el chat: fijar un mensaje lo lleva al menú «Marcadores», y
// pulsarlo desplaza la lista hasta él y lo resalta. Caso negativo: un marcador
// de un mensaje que no está en el transcript explica por qué no salta; uno que
// está en una página anterior se carga solo y salta.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { storageKey } from "../bookmarks";
import { BookmarkLoadStalled, MAX_BOOKMARK_PAGES, loadUntilBookmark } from "../components/chat/Bookmarks";
import { ChatPane } from "../components/chat/ChatPane";
import { ApiContext } from "../context";
import { store } from "../store";
import type { ChatMessage, SessionInfo } from "../types";
import { toggleTurn } from "../ui";

const info = (id: string, claudeSessionId: string): SessionInfo => ({
  id, projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId, status: "idle", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
});

const msg = (uuid: string, role: ChatMessage["role"], text: string, at: string): ChatMessage => ({
  uuid, role, timestamp: at, blocks: [{ kind: "text", text }], agentId: null,
});

const THREAD: ChatMessage[] = [
  msg("u1", "user", "Pregunta marcable", "2026-10-14T10:00:00.000Z"),
  msg("a1", "assistant", "Respuesta del asistente", "2026-10-14T10:00:05.000Z"),
];

const OLDER: ChatMessage[] = [msg("viejo", "assistant", "Mensaje de la página anterior", "2026-10-13T09:00:00.000Z")];

function fakeApi(paged = false): SesionesApi {
  const known: Record<string, unknown> = {
    isMock: true,
    history: async (req: { beforeUuid?: string }) => (paged && req.beforeUuid ? { messages: OLDER, hasMore: false } : { messages: THREAD, hasMore: paged }),
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

function mount(id: string, paged = false) {
  return render(
    <ApiContext.Provider value={fakeApi(paged)}>
      <ChatPane sessionId={id} agentId={null} />
    </ApiContext.Provider>,
  );
}

const scrollIntoView = vi.fn();

/** jsdom no trae ResizeObserver; la lista lo usa para seguir el final del chat. */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// jsdom mide 0 px: con un contenedor de alto 0 la lista virtual no pinta ninguna fila.
const SIZE_PROPS = ["offsetHeight", "offsetWidth"] as const;
const originalSizes = SIZE_PROPS.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));

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
});

/**
 * La primera pasada de la lista virtual aún no ve su contenedor (la ref del padre
 * se asigna después del efecto del hijo); en la app la repinta el desplazamiento
 * medido de la cabecera, que en jsdom es 0. Se fuerza un repintado y se espera a
 * que aparezca el texto.
 */
async function shown(text: string) {
  await waitFor(() => expect(document.querySelector(".vlist")).not.toBeNull());
  act(() => {
    toggleTurn("repintado");
    toggleTurn("repintado");
  });
  await screen.findByText(text);
}

const article = (uuid: string) => document.querySelector<HTMLElement>(`[data-msg-uuid="${uuid}"]`);

describe("marcadores en el hilo", () => {
  it("fijar → aparece en la lista → al pulsarlo desplaza y resalta el mensaje", async () => {
    store.dispatch({ type: "sessions", sessions: [info("bm1", "conv-bm1")] });
    mount("bm1");
    await shown("Pregunta marcable");
    expect(screen.queryByRole("button", { name: /Marcadores/ })).toBeNull();

    const user = article("u1");
    expect(user).not.toBeNull();
    fireEvent.click(within(user!).getByRole("button", { name: "Fijar en marcadores" }));
    expect(article("u1")).toHaveClass("pinned");
    expect(window.localStorage.getItem(storageKey("conv-bm1"))).toContain('"u1"');

    fireEvent.click(screen.getByRole("button", { name: /Marcadores/ }));
    const dialog = screen.getByRole("dialog", { name: "Marcadores" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Ir al mensaje de Tú: Pregunta marcable/ }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.contexts[0]).toBe(article("u1"));
    expect(article("u1")).toHaveAttribute("data-flash");
    expect(article("a1")).not.toHaveAttribute("data-flash");
  });

  it("caso negativo: un marcador de un mensaje no cargado avisa y no desplaza", async () => {
    window.localStorage.setItem(storageKey("conv-bm2"), JSON.stringify([
      { uuid: "fuera-de-pagina", preview: "Mensaje antiguo", role: "assistant", createdAt: "2026-10-01T00:00:00.000Z" },
    ]));
    store.dispatch({ type: "sessions", sessions: [info("bm2", "conv-bm2")] });
    mount("bm2");
    await shown("Pregunta marcable");

    fireEvent.click(screen.getByRole("button", { name: /Marcadores/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Ir al mensaje de Claude: Mensaje antiguo/ }));

    await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Marcadores" })).getByRole("status")).toHaveTextContent("no está en el historial"));
    await new Promise((r) => window.setTimeout(r, 50));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("un marcador de una página anterior carga el historial hasta él y salta", async () => {
    window.localStorage.setItem(storageKey("conv-bm4"), JSON.stringify([
      { uuid: "viejo", preview: "Mensaje de la página anterior", role: "assistant", createdAt: "2026-10-13T09:00:00.000Z" },
    ]));
    store.dispatch({ type: "sessions", sessions: [info("bm4", "conv-bm4")] });
    mount("bm4", true);
    await shown("Pregunta marcable");
    fireEvent.click(screen.getByRole("button", { name: /Marcadores/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Ir al mensaje de Claude: Mensaje de la página anterior/ }));
    await waitFor(() => expect(store.getState().bySession.bm4.messages.some((m) => m.uuid === "viejo")).toBe(true));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it("caso negativo: si la página anterior no carga, se corta tras unas vueltas en vez de repetir la petición hasta el tope", async () => {
    // Directo sobre `loadUntilBookmark`, sin montar el chat: la lista también pagina
    // sola mientras el hilo no llena la vista y repetiría la petición por su cuenta.
    store.dispatch({ type: "sessions", sessions: [info("bm5", "conv-bm5")] });
    store.dispatch({ type: "history", id: "bm5", agentId: null, messages: THREAD, hasMore: true });
    const history = vi.fn(async () => {
      throw new Error("historial caído");
    });
    const api = { isMock: true, history } as unknown as SesionesApi;
    await expect(loadUntilBookmark(api, "bm5", "viejo")).rejects.toBeInstanceOf(BookmarkLoadStalled);
    expect(history.mock.calls.length).toBeLessThan(MAX_BOOKMARK_PAGES);
    expect(history).toHaveBeenCalledTimes(3);
  });

  it("quitar desde la lista desfija el mensaje y vacía el almacenamiento", async () => {
    store.dispatch({ type: "sessions", sessions: [info("bm3", "conv-bm3")] });
    mount("bm3");
    await shown("Respuesta del asistente");
    fireEvent.click(within(article("a1")!).getByRole("button", { name: "Fijar en marcadores" }));
    fireEvent.click(screen.getByRole("button", { name: /Marcadores/ }));
    fireEvent.click(screen.getByRole("button", { name: /Quitar marcador/ }));
    expect(article("a1")).not.toHaveClass("pinned");
    expect(window.localStorage.getItem(storageKey("conv-bm3"))).toBeNull();
    expect(screen.queryByRole("button", { name: /Marcadores/ })).toBeNull();
  });
});
