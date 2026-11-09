// Hallazgos 13 y 36: volver a montar el chat de una sesión cuyo hilo ya está en
// el store (y al día por los eventos `messages`) no vuelve a pedir la página.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { ChatPane } from "../components/chat/ChatPane";
import { PaneView } from "../components/Pane";
import { ApiContext } from "../context";
import { store } from "../store";
import type { SessionInfo } from "../types";

const info = (id: string): SessionInfo => ({
  id, projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
});

function fakeApi() {
  const history = vi.fn(async (_req: { id: string; agentId?: string }) => ({ messages: [], hasMore: false }));
  const known: Record<string, unknown> = { isMock: true, history, gitSnapshot: async () => { throw new Error("sin git en el test"); } };
  const api = new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === "then") return undefined;
      if (prop === "on") return async () => () => undefined;
      return async () => [];
    },
  }) as unknown as SesionesApi;
  return { api, history };
}

function mount(api: SesionesApi, id: string) {
  return render(
    <ApiContext.Provider value={api}>
      <ChatPane sessionId={id} agentId={null} />
    </ApiContext.Provider>,
  );
}

const mainCalls = (h: ReturnType<typeof fakeApi>["history"], id: string) => h.mock.calls.filter(([r]) => r.id === id && !r.agentId).length;

afterEach(() => cleanup());

describe("ChatPane no repide el historial al remontar", () => {
  it("desmontar y volver a montar con la misma generación pide la página una sola vez", async () => {
    store.dispatch({ type: "sessions", sessions: [info("r1")] });
    const { api, history } = fakeApi();
    const first = mount(api, "r1");
    await waitFor(() => expect(store.getState().bySession.r1?.historyLoaded).toBe(true));
    first.unmount();
    mount(api, "r1");
    await new Promise((r) => window.setTimeout(r, 30));
    expect(mainCalls(history, "r1")).toBe(1);
  });

  it("caso negativo: una sesión cuyo hilo aún no se cargó sí pide la página", async () => {
    store.dispatch({ type: "sessions", sessions: [info("r2")] });
    const { api, history } = fakeApi();
    mount(api, "r2");
    await waitFor(() => expect(mainCalls(history, "r2")).toBe(1));
  });
});

describe("cambiar de sesión en un panel", () => {
  const view = (api: SesionesApi, id: string) => (
    <ApiContext.Provider value={api}>
      <PaneView pane={{ key: "k", sessionId: id, agentId: null }} index={0} focused count={1} />
    </ApiContext.Provider>
  );

  it("remonta el chat: el contenedor del hilo anterior (scroll y anclaje) no se reutiliza", async () => {
    store.dispatch({ type: "sessions", sessions: [info("v1"), info("v2")] });
    const { api } = fakeApi();
    const r = render(view(api, "v1"));
    await waitFor(() => expect(r.container.querySelector('[data-session="v1"]')).not.toBeNull());
    const before = r.container.querySelector(".chat");
    r.rerender(view(api, "v2"));
    await waitFor(() => expect(r.container.querySelector('[data-session="v2"]')).not.toBeNull());
    expect(r.container.querySelector(".chat")).not.toBe(before);
  });

  it("caso negativo: repintar el mismo panel con la misma sesión conserva el chat", async () => {
    store.dispatch({ type: "sessions", sessions: [info("v3")] });
    const { api } = fakeApi();
    const r = render(view(api, "v3"));
    await waitFor(() => expect(r.container.querySelector('[data-session="v3"]')).not.toBeNull());
    const before = r.container.querySelector(".chat");
    r.rerender(view(api, "v3"));
    expect(r.container.querySelector(".chat")).toBe(before);
  });
});
