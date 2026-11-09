// F4 de la paridad: el HUD de una sesión de motor enseña su modelo y el modo de
// permisos traducido al motor; sin effort, contexto, cuota ni coste de Claude Code.
// Elegir un modo llama a setPermissionMode; un rechazo del motor se cuenta tal cual
// (sin «Reiniciar en…», que es del ciclo de Shift+Tab de Claude) y no hay «Rotar modo».

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { PermSeg } from "../components/hud/SegmentsSession";
import { StatusLine } from "../components/hud/StatusLine";
import { ApiContext } from "../context";
import { store } from "../store";
import type { SessionInfo } from "../types";

const ENGINE = {
  id: "m1", projectId: "p", projectName: "p", cwd: "C:/p", title: "Codex · p", claudeSessionId: null, status: "idle", model: "gpt-6.1-sol",
  startedAt: "", bridgeConnected: false, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "unknown",
  permissionMode: "acceptEdits", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 0, engine: "codex",
} as SessionInfo;

const NO_GIT = { branch: null, dirty: 0, ahead: 0, behind: 0, loading: false, error: null, reload: () => undefined } as never;

function api(over: Record<string, unknown>): SesionesApi {
  return new Proxy({ isMock: true, ...over }, {
    get(t, k: string) {
      if (k in t) return (t as Record<string, unknown>)[k];
      if (k === "then") return undefined;
      return vi.fn(async () => {
        throw new Error(`${k}: no debería llamarse en una sesión de motor`);
      });
    },
  }) as unknown as SesionesApi;
}

afterEach(() => {
  cleanup();
  act(() => store.dispatch({ type: "sessions", sessions: [] }));
});

describe("HUD de una sesión de motor", () => {
  it("enseña modelo y permisos, sin segmentos de Claude Code y sin pedir sus ajustes", () => {
    const settings = vi.fn();
    act(() => store.dispatch({ type: "sessions", sessions: [ENGINE] }));
    render(<ApiContext.Provider value={api({ settings })}><StatusLine info={ENGINE} pending={[]} git={NO_GIT} /></ApiContext.Provider>);
    expect(screen.getByTestId("hud-engine-model").textContent).toContain("gpt-6.1-sol");
    expect(screen.getByTestId("hud-perm").textContent).toBeTruthy();
    expect(screen.queryByTestId("hud-model")).toBeNull();
    expect(screen.queryByTestId("hud-effort")).toBeNull();
    expect(settings).not.toHaveBeenCalled();
  });

  it("elegir un modo llama a setPermissionMode y un rechazo se cuenta sin ofrecer reinicio", async () => {
    const setPermissionMode = vi.fn(async () => ({ ok: false, error: "Gemini no tiene un modo equivalente a «plan»" }));
    render(<ApiContext.Provider value={api({ setPermissionMode })}><PermSeg info={ENGINE} mode="acceptEdits" /></ApiContext.Provider>);
    fireEvent.click(screen.getByTestId("hud-perm"));
    expect(screen.queryByRole("button", { name: "Rotar modo" })).toBeNull();
    expect(screen.getByText(/Se traduce a la política de Codex/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("option", { name: /Planificar|plan/i })));
    expect(setPermissionMode).toHaveBeenCalledWith({ id: "m1", mode: "plan" });
    expect(screen.queryByTestId("hud-perm-restart")).toBeNull();
  });

  it("caso negativo: una sesión de Claude conserva «Rotar modo»", () => {
    const claude = { ...ENGINE, id: "s1", engine: undefined, claudeSessionId: "c" } as SessionInfo;
    render(<ApiContext.Provider value={api({})}><PermSeg info={claude} mode="acceptEdits" /></ApiContext.Provider>);
    fireEvent.click(screen.getByTestId("hud-perm"));
    expect(screen.getByRole("button", { name: "Rotar modo" })).toBeTruthy();
  });
});
