// `sesiones://focus-session` (clic en Pupus con un aviso): la sesión pasa al
// panel con foco; una que esta ventana no conoce no toca nada.

import { afterEach, describe, expect, it } from "vitest";
import { focusSession } from "../bootstrap";
import { store } from "../store";
import type { SessionInfo } from "../types";
import { emptyWorkspace, updateWorkspace, workspaceStore } from "../workspace";

const session = (id: string): SessionInfo => ({
  id, projectId: "p", projectName: "p", cwd: "C:/p", title: id, claudeSessionId: "c", status: "waiting", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: null, launchPermissionMode: "default", exitCode: null, bridgeProtocol: 2,
});

const focusedId = () => {
  const ws = workspaceStore.getState();
  return ws.panes[ws.focused]?.sessionId ?? null;
};

describe("focusSession", () => {
  afterEach(() => {
    store.dispatch({ type: "sessions", sessions: [] });
    updateWorkspace(() => emptyWorkspace);
  });

  it("pone la sesión pedida en el panel con foco", () => {
    store.dispatch({ type: "sessions", sessions: [session("a"), session("b")] });
    focusSession("a");
    expect(focusedId()).toBe("a");
    focusSession("b");
    expect(focusedId()).toBe("b");
  });

  it("un id desconocido no toca el espacio de trabajo (negativo)", () => {
    store.dispatch({ type: "sessions", sessions: [session("a")] });
    focusSession("a");
    const before = workspaceStore.getState();
    focusSession("fantasma");
    expect(workspaceStore.getState()).toBe(before);
    expect(focusedId()).toBe("a");
  });
});
