// Req. 11: la línea de estado de la sesión cambia en el mismo tick en que llega
// `sesiones://sessions`, sin esperas artificiales (ni temporizadores ni fotogramas).

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { ChatStatus } from "../components/chat/ChatStatus";
import { ApiContext } from "../context";
import { useSessionInfo } from "../store";
import type { SesionesEvents, SessionInfo } from "../types";

type Listener = (payload: never) => void;
const listeners = new Map<string, Listener>();

const DEFAULTS: Record<string, unknown> = { list: [], engineList: [], engines: [], pendingAsks: [], queueList: [], relayList: [] };

const fake = new Proxy({ isMock: true }, {
  get(target, prop: string) {
    if (prop in target) return (target as Record<string, unknown>)[prop];
    if (prop === "then") return undefined;
    if (prop === "on") {
      return async (event: string, cb: Listener) => {
        listeners.set(event, cb);
        return () => listeners.delete(event);
      };
    }
    if (prop === "usage") return async () => ({ fiveHour: null, weekly: null, stale: false });
    return async () => DEFAULTS[prop];
  },
}) as unknown as SesionesApi;

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), loadApi: async () => fake, getApi: () => fake }));

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

function emit<K extends keyof SesionesEvents>(event: K, payload: SesionesEvents[K]): void {
  const cb = listeners.get(event);
  if (!cb) throw new Error(`sin suscripción a ${event}`);
  (cb as (p: SesionesEvents[K]) => void)(payload);
}

function Probe() {
  const info = useSessionInfo("s1");
  return info ? <ChatStatus info={info} /> : <p>sin sesión</p>;
}

const text = () => screen.getByTestId("chat-status").querySelector(".cs-text")?.textContent;

beforeAll(async () => {
  const { bootstrap } = await import("../bootstrap");
  await bootstrap();
});

afterEach(() => vi.useRealTimers());

describe("línea de estado en el mismo tick que sesiones://sessions (req. 11)", () => {
  it("pasa a «Trabajando» y vuelve a «Listo» sin avanzar temporizadores ni fotogramas", () => {
    render(<ApiContext.Provider value={fake}><Probe /></ApiContext.Provider>);
    act(() => emit("sesiones://sessions", [base]));
    expect(text()).toBe("Listo");
    vi.useFakeTimers();
    act(() => emit("sesiones://sessions", [{ ...base, status: "working", workingSince: new Date().toISOString() }]));
    // Sin vi.advanceTimersByTime ni await: la DOM ya refleja el evento.
    expect(text()).toMatch(/^Trabajando/);
    act(() => emit("sesiones://sessions", [{ ...base, status: "idle" }]));
    expect(text()).toBe("Listo");
  });

  it("un evento de otra sesión no toca su línea (caso negativo)", () => {
    render(<ApiContext.Provider value={fake}><Probe /></ApiContext.Provider>);
    act(() => emit("sesiones://sessions", [base]));
    vi.useFakeTimers();
    act(() => emit("sesiones://sessions", [base, { ...base, id: "s2", status: "working", workingSince: new Date().toISOString() }]));
    expect(text()).toBe("Listo");
  });
});
