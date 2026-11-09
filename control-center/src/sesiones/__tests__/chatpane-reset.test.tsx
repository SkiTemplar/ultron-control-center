// Panel de subagente abierto durante un reset (/clear): el reset vacía
// `agentMessages`, así que el panel tiene que volver a pedir su hilo en vez de
// quedarse en el esqueleto de carga para siempre.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { ChatPane } from "../components/chat/ChatPane";
import { ApiContext } from "../context";
import { store } from "../store";
import type { SessionInfo } from "../types";

const info: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

function fakeApi() {
  const history = vi.fn(async (_req: { id: string; agentId?: string }) => ({ messages: [], hasMore: false }));
  const api = { isMock: true, history, agents: async () => [] } as unknown as SesionesApi;
  return { api, history };
}

afterEach(() => cleanup());

describe("ChatPane de subagente tras un reset", () => {
  it("vuelve a cargar el hilo del subagente y no se queda en el esqueleto", async () => {
    store.dispatch({ type: "sessions", sessions: [info] });
    const { api, history } = fakeApi();
    const { container } = render(
      <ApiContext.Provider value={api}>
        <ChatPane sessionId="s1" agentId="ag1" />
      </ApiContext.Provider>,
    );
    await screen.findByText("Sin transcript todavía");
    const callsBefore = history.mock.calls.filter(([req]) => req.agentId === "ag1").length;
    act(() => store.dispatch({ type: "reset", id: "s1" }));
    await waitFor(() => expect(container.querySelector("[aria-busy=true]")).toBeNull());
    expect(history.mock.calls.filter(([req]) => req.agentId === "ag1").length).toBe(callsBefore + 1);
  });

  it("caso negativo: un cambio de la sesión que no es un reset no vuelve a pedir el hilo", async () => {
    store.dispatch({ type: "sessions", sessions: [info] });
    const { api, history } = fakeApi();
    render(
      <ApiContext.Provider value={api}>
        <ChatPane sessionId="s1" agentId="ag2" />
      </ApiContext.Provider>,
    );
    await screen.findAllByText("Sin transcript todavía");
    act(() => store.dispatch({ type: "note", id: "s1", note: { id: "n1", at: "2026-10-13T10:00:00Z", level: "info", text: "aviso" } }));
    await new Promise((r) => window.setTimeout(r, 30));
    expect(history.mock.calls.filter(([req]) => req.agentId === "ag2")).toHaveLength(1);
  });
});
