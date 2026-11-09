import { describe, expect, it } from "vitest";
import { STATUS_LABEL, sessionMeta } from "../components/Sidebar";
import type { SessionInfo } from "../types";

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "home", cwd: "/p", title: "t", claudeSessionId: "c", status: "starting", model: null,
  startedAt: new Date().toISOString(), bridgeConnected: false, waiting: null, stalled: null, workingSince: null, lastActivityAt: new Date().toISOString(), turnId: null,
  screen: "unknown", permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

describe("meta de la fila de sesión en la barra lateral", () => {
  it("starting sin bloqueo → «arrancando…» sin aviso", () => {
    expect(sessionMeta(base)).toEqual({ text: "home · arrancando…", warn: false });
  });

  it("starting con startupTimeout → «no arranca» con aviso, no «arrancando…» para siempre", () => {
    const stalled = { reason: "startupTimeout" as const, since: new Date().toISOString(), detail: "Claude no ha llegado al prompt en 30 s" };
    expect(sessionMeta({ ...base, stalled })).toEqual({ text: "home · no arranca", warn: true });
  });

  it("libre → última actividad, no la hora de arranque; trabajando lo dice", () => {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 2 * 60_000).toISOString();
    const idle = sessionMeta({ ...base, status: "idle", startedAt: old, lastActivityAt: recent });
    expect(idle.text).toBe(sessionMeta({ ...base, status: "idle", startedAt: recent, lastActivityAt: recent }).text);
    expect(idle.text).not.toBe(sessionMeta({ ...base, status: "idle", startedAt: old, lastActivityAt: old }).text);
    expect(sessionMeta({ ...base, status: "working" })).toEqual({ text: "home · trabajando", warn: false });
  });

  it("caso negativo: el estado en castellano cubre todos los estados", () => {
    for (const st of ["starting", "idle", "background", "working", "waiting", "exited"] as const) expect(STATUS_LABEL[st]).toMatch(/^[a-záéíóúñ ]+$/);
  });
});
