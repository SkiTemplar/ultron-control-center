// Saltar a un mensaje (Ctrl+F o un marcador) suelta el anclaje abajo: el
// siguiente crecimiento del contenido (ResizeObserver) ya no devuelve la vista al
// final. Este test usa un ResizeObserver que sí dispara sus callbacks (los de la
// búsqueda y los marcadores usan uno mudo, que tapaba el fallo). Caso negativo:
// sin salto, el crecimiento sigue llevando la vista al final.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { requestJump } from "../bookmarks";
import { ChatPane } from "../components/chat/ChatPane";
import { ApiContext } from "../context";
import { store } from "../store";
import { requestThreadSearch } from "../thread-search";
import type { ChatMessage, SessionInfo } from "../types";
import { toggleTurn } from "../ui";

const info = (id: string): SessionInfo => ({
  id, projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: `conv-${id}`, status: "idle", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
});

const msg = (uuid: string, role: ChatMessage["role"], text: string, at: string): ChatMessage => ({
  uuid, role, timestamp: at, blocks: [{ kind: "text", text }], agentId: null,
});

const THREAD: ChatMessage[] = [
  msg("u1", "user", "Primera pregunta con la palabra faro", "2026-10-17T10:00:00.000Z"),
  msg("a1", "assistant", "Respuesta intermedia", "2026-10-17T10:00:05.000Z"),
  msg("u2", "user", "Última pregunta", "2026-10-17T10:01:00.000Z"),
  msg("a2", "assistant", "Última respuesta", "2026-10-17T10:01:05.000Z"),
];

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

/** ResizeObserver que guarda sus callbacks para dispararlos a mano (el contenido «crece»). */
const observers = new Set<() => void>();
class FiringResizeObserver {
  private readonly fire: () => void;
  constructor(cb: ResizeObserverCallback) {
    this.fire = () => cb([], this as unknown as ResizeObserver);
  }
  observe(): void {
    observers.add(this.fire);
  }
  unobserve(): void {}
  disconnect(): void {
    observers.delete(this.fire);
  }
}
const grow = () => act(() => observers.forEach((fire) => fire()));

const SCROLL_HEIGHT = 5000;
const SIZE_PROPS = ["offsetHeight", "offsetWidth"] as const;
const originalSizes = SIZE_PROPS.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));
const scrollIntoView = vi.fn();

/** Desplazamiento del contenedor del chat, con registro de cada escritura. */
function trackScroll(): number[] {
  const el = screen.getByTestId("message-scroll");
  const writes: number[] = [];
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => SCROLL_HEIGHT });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
      writes.push(v);
    },
  });
  return writes;
}

function mount(id: string) {
  store.dispatch({ type: "sessions", sessions: [info(id)] });
  return render(
    <ApiContext.Provider value={fakeApi()}>
      <section data-pane-index="0">
        <ChatPane sessionId={id} agentId={null} />
      </section>
    </ApiContext.Provider>,
  );
}

async function shown(text: string) {
  await waitFor(() => expect(document.querySelector(".vlist")).not.toBeNull());
  act(() => {
    toggleTurn("repintado");
    toggleTurn("repintado");
  });
  await screen.findByText(text);
}

const article = (uuid: string) => document.querySelector<HTMLElement>(`[data-msg-uuid="${uuid}"]`);

beforeEach(() => {
  observers.clear();
  vi.stubGlobal("ResizeObserver", FiringResizeObserver);
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

describe("saltar a un mensaje suelta el anclaje abajo", () => {
  it("caso negativo: sin salto, el crecimiento del contenido lleva la vista al final", async () => {
    mount("anc1");
    await shown("Última respuesta");
    const writes = trackScroll();
    grow();
    expect(writes).toContain(SCROLL_HEIGHT);
    expect(screen.queryByRole("button", { name: /Ir al final/ })).toBeNull();
  });

  it("Ctrl+F: tras saltar a la coincidencia, crecer no devuelve la vista al final", async () => {
    mount("anc2");
    await shown("Última respuesta");
    const writes = trackScroll();
    act(() => requestThreadSearch("anc2", null));
    const field = await screen.findByRole("textbox", { name: "Buscar en el hilo" });
    fireEvent.change(field, { target: { value: "faro" } });
    await waitFor(() => expect(article("u1")).toHaveAttribute("data-search-hit"));

    writes.length = 0;
    grow();
    expect(writes).not.toContain(SCROLL_HEIGHT);
    expect(await screen.findByRole("button", { name: /Ir al final/ })).toBeInTheDocument();
  });

  it("marcador: tras saltar al mensaje, crecer no devuelve la vista al final", async () => {
    mount("anc3");
    await shown("Última respuesta");
    const writes = trackScroll();
    act(() => {
      requestJump("anc3", "u1");
    });
    await waitFor(() => expect(article("u1")).toHaveAttribute("data-flash"));

    writes.length = 0;
    grow();
    expect(writes).not.toContain(SCROLL_HEIGHT);
    expect(await screen.findByRole("button", { name: /Ir al final/ })).toBeInTheDocument();
  });
});
