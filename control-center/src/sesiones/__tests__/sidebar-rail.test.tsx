// La columna informa al backend de sus filas una vez por cambio de layout,
// no en cada render (rail-rects.ts → sesiones_rail_report).

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Sidebar } from "../components/Sidebar";
import { ApiContext } from "../context";
import { store } from "../store";
import type { SessionInfo } from "../types";

const base: SessionInfo = {
  id: "r1", projectId: "p", projectName: "p", cwd: "C:/p", title: "tarea", claudeSessionId: "c", status: "waiting", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: null, launchPermissionMode: "default", exitCode: null, bridgeProtocol: 2,
};

let box = { left: 0, top: 0, width: 280, height: 600 };
const original = HTMLElement.prototype.getBoundingClientRect;
const settle = () => act(() => new Promise((r) => setTimeout(r, 300)));

function ui(api: SesionesApi) {
  return (
    <ApiContext.Provider value={api}>
      <Sidebar onPicked={() => undefined} />
    </ApiContext.Provider>
  );
}

describe("informe de la columna para la mascota", () => {
  beforeEach(() => {
    box = { left: 0, top: 0, width: 280, height: 600 };
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box } as DOMRect;
    };
    act(() => store.dispatch({ type: "sessions", sessions: [base] }));
  });
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = original;
    act(() => store.dispatch({ type: "sessions", sessions: [] }));
  });

  it("se envía una vez tras el render y no otra si nada cambia", async () => {
    const reportRail = vi.fn().mockResolvedValue(undefined);
    const api = { isMock: true, reportRail } as unknown as SesionesApi;
    const { rerender } = render(ui(api));
    await settle();
    expect(reportRail).toHaveBeenCalledTimes(1);
    const sent = reportRail.mock.calls[0][0];
    expect(sent.rail).toEqual({ x: 0, y: 0, w: 280, h: 600 });
    expect(sent.items.map((i: { id: string }) => i.id)).toEqual(["r1"]);

    rerender(ui(api));
    act(() => void window.dispatchEvent(new Event("resize")));
    await settle();
    expect(reportRail).toHaveBeenCalledTimes(1);

    box = { ...box, height: 500 };
    act(() => void window.dispatchEvent(new Event("resize")));
    await settle();
    expect(reportRail).toHaveBeenCalledTimes(2);
  });

  it("un fallo se avisa una sola vez y se reintenta en el siguiente cambio", async () => {
    const reportRail = vi.fn().mockRejectedValue(new Error("sin backend"));
    const api = { isMock: true, reportRail } as unknown as SesionesApi;
    render(ui(api));
    await settle();
    const calls = reportRail.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(store.getState().error).toBe("sin backend");
    act(() => store.dispatch({ type: "error", message: null }));
    act(() => void window.dispatchEvent(new Event("resize")));
    await settle();
    expect(reportRail.mock.calls.length).toBeGreaterThan(calls);
    expect(store.getState().error).toBeNull();
  });
});
