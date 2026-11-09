// Aviso de Sessions en Pupus (useSessionsWatch.ts): un permiso o la
// confianza se piden en su propio chat y no se va a Sessions; el resto de
// esperas señalan el botón de Sessions en la barra de tareas.

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MascotEngine } from "../engine";
import type { WatchedSession } from "../sessionsWatch";
import type { WaitKind } from "../../../sesiones/types";
import { asksInChat, useSessionsWatch } from "../useSessionsWatch";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function session(patch: Partial<WatchedSession>): WatchedSession {
  return {
    id: "s1", projectId: "p", projectName: "Proyecto", title: "tarea", status: "working",
    waiting: null, stalled: null, workingSince: new Date(Date.now() - 5000).toISOString(), exitCode: null, ...patch,
  };
}

function setup() {
  let list: WatchedSession[] = [session({})];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => (cmd === "sesiones_list" ? list : null));
  const eng = { mode: "idle", S: 4, height: 40, halfW: 24, poke: vi.fn(), showIcon: vi.fn(), feel: vi.fn(), isGrounded: () => true, play: vi.fn() };
  const pointAt = vi.fn().mockResolvedValue("ok");
  const hit = document.createElement("div");
  const { unmount } = renderHook(() =>
    useSessionsWatch(true, { current: eng as unknown as MascotEngine }, { current: hit }, {
      quietRef: { current: false },
      fgRef: { current: null },
      pointAt,
    }),
  );
  const wait = (kind: WaitKind) =>
    void (list = [session({ status: "waiting", waiting: { kind, label: "¿Seguro?", since: new Date().toISOString() } })]);
  return { hit, unmount, pointAt, wait };
}

describe("useSessionsWatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("un permiso se pide en el chat: avisa, pero no va a señalar Sessions", async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(100);
    t.wait("permission");
    await vi.advanceTimersByTimeAsync(6000);
    expect(t.hit.title).toContain("«tarea»");
    expect(t.pointAt).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("mascot_sessions_target", expect.anything());
    t.unmount();
  });

  it("una pregunta sí señala el botón de Sessions en la barra (negativo del anterior)", async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(100);
    t.wait("question");
    await vi.advanceTimersByTimeAsync(6000);
    expect(t.pointAt).toHaveBeenCalledWith({ appId: "ULTRON.Sessions" });
    t.unmount();
  });

  it("solo el permiso y la confianza se piden en el chat", () => {
    const target = { id: "s1", projectId: "p", title: "tarea" };
    const waiting = (waitKind: WaitKind) => ({ kind: "waiting" as const, session: target, waitKind });
    expect(asksInChat(waiting("permission"))).toBe(true);
    expect(asksInChat(waiting("trust"))).toBe(true);
    expect(asksInChat(waiting("question"))).toBe(false);
    expect(asksInChat(null)).toBe(false);
  });
});
