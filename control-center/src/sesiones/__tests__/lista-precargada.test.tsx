// Un hilo que ya está en el almacén al montar el panel (reinicio con sesiones
// restauradas, recarga de la página o cambio de panel) se pinta sin esperar a
// otro cambio. Antes, la lista virtual montaba sin ver su contenedor (la ref del
// padre se asigna después de los efectos del hijo) y, memoizada, no volvía a
// pintarse: el chat quedaba en blanco con «Inicio de la conversación».

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { ChatPane } from "../components/chat/ChatPane";
import { ApiContext } from "../context";
import { store } from "../store";
import type { ChatMessage, SessionInfo } from "../types";

const info = (id: string): SessionInfo => ({
  id, projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: `conv-${id}`, status: "idle", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
});

const msg = (uuid: string, role: ChatMessage["role"], text: string, at: string): ChatMessage => ({
  uuid, role, timestamp: at, blocks: [{ kind: "text", text }], agentId: null,
});

const THREAD: ChatMessage[] = [
  msg("u1", "user", "Pregunta ya cargada", "2026-10-15T00:21:48.000Z"),
  msg("a1", "assistant", "Respuesta ya cargada", "2026-10-15T00:21:50.000Z"),
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

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const SIZE_PROPS = ["offsetHeight", "offsetWidth"] as const;
const originalSizes = SIZE_PROPS.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  for (const p of SIZE_PROPS) Object.defineProperty(HTMLElement.prototype, p, { configurable: true, get: () => 600 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  SIZE_PROPS.forEach((p, i) => {
    const d = originalSizes[i];
    if (d) Object.defineProperty(HTMLElement.prototype, p, d);
  });
});

describe("lista con el hilo ya cargado al montar", () => {
  it("pinta los mensajes sin necesitar otro cambio del hilo", async () => {
    store.dispatch({ type: "sessions", sessions: [info("pre1")] });
    store.dispatch({ type: "history", id: "pre1", agentId: null, messages: THREAD, hasMore: false, generation: store.getState().bySession.pre1?.generation ?? 0 });
    render(
      <ApiContext.Provider value={fakeApi()}>
        <ChatPane sessionId="pre1" agentId={null} />
      </ApiContext.Provider>,
    );
    expect(await screen.findByText("Respuesta ya cargada")).toBeTruthy();
    expect(screen.getByText("Pregunta ya cargada")).toBeTruthy();
  });
});
