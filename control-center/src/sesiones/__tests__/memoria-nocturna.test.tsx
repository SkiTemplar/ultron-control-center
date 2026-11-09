// Auditoría de estabilidad nocturna, hallazgo 1: memoria del webview acotada en
// bytes (capturas en base64), recorte dentro de un turno en curso larguísimo y
// LRU de hilos de subagente, con recarga paginada al abrir uno ya soltado.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { loadHistory } from "../bootstrap";
import { ChatPane } from "../components/chat/ChatPane";
import { ApiContext } from "../context";
import { openAgentsOf, wireOpenAgents } from "../open-agents";
import { LIVE_CAP, LIVE_KEEP } from "../paging";
import { initialState, reducer, type State } from "../reducer";
import { pagingOf } from "../session-state";
import { createStore, store } from "../store";
import { AGENT_THREADS_KEEP, BYTE_CAP, BYTE_KEEP, capBytes, messageWeight, threadWeight } from "../thread-memory";
import type { ChatMessage, SessionInfo } from "../types";
import { makePane, type Workspace } from "../workspace";
import { answer, prompt } from "./fixtures/long-thread";

const MB = 1024 * 1024;
/** Captura de 1 M de caracteres (2 MB en UTF-16), compartida para no gastar memoria en el test. */
const BIG_DATA_URL = `data:image/png;base64,${"A".repeat(MB)}`;

function shot(uuid: string, i: number, agentId: string | null = null): ChatMessage {
  return {
    uuid, role: "user", timestamp: new Date(Date.UTC(2026, 9, 15, 0, 0, i)).toISOString(), agentId,
    blocks: [{ kind: "toolResult", toolUseId: `t-${uuid}`, isError: false, text: "captura", images: [BIG_DATA_URL] }],
  };
}

function agentMsg(agentId: string, uuid: string, i: number): ChatMessage {
  return { ...answer(uuid, i), agentId };
}

const loaded = (): State => reducer(initialState, { type: "history", id: "s1", agentId: null, messages: [prompt("p0", 0)], hasMore: false, generation: 0 });

describe("peso estimado de un mensaje", () => {
  it("cuenta las imágenes en data: de los resultados y de los bloques image", () => {
    expect(messageWeight(shot("x", 1))).toBeGreaterThan(2 * MB);
    const img: ChatMessage = { ...answer("i", 1), blocks: [{ kind: "image", mediaType: "image/png", dataUrl: BIG_DATA_URL }] };
    expect(messageWeight(img)).toBeGreaterThan(2 * MB);
    expect(messageWeight(answer("a", 1))).toBeLessThan(4096);
  });

  it("capBytes conserva siempre el último mensaje aunque solo él pase del presupuesto", () => {
    const list = [shot("a", 1), shot("b", 2)];
    expect(capBytes(list, 10).map((m) => m.uuid)).toEqual(["b"]);
  });
});

describe("tope en bytes por sesión", () => {
  it(`${BYTE_CAP / MB} MB de capturas en vivo: suelta las más antiguas hasta ${BYTE_KEEP / MB} MB y marca hasMore`, () => {
    let s = loaded();
    // 40 capturas de ~2 MB = ~80 MB, de una en una como llegan por `sesiones://messages`.
    for (let i = 1; i <= 40; i += 1) s = reducer(s, { type: "messages", id: "s1", messages: [shot(`c${i}`, i)] });
    const list = s.bySession.s1.messages;
    expect(threadWeight(list)).toBeLessThanOrEqual(BYTE_CAP);
    expect(list[list.length - 1].uuid).toBe("c40");
    expect(list.some((m) => m.uuid === "c1")).toBe(false);
    expect(pagingOf(s.bySession.s1, null).hasMore).toBe(true);
  });

  it("por debajo del tope no recorta nada (caso negativo)", () => {
    let s = loaded();
    for (let i = 1; i <= 20; i += 1) s = reducer(s, { type: "messages", id: "s1", messages: [shot(`c${i}`, i)] });
    expect(s.bySession.s1.messages).toHaveLength(21);
    expect(pagingOf(s.bySession.s1, null).hasMore).toBe(false);
  });

  it("con el tope superado suelta antes los hilos de subagente cerrados que el hilo principal", () => {
    let s = loaded();
    for (let i = 1; i <= 15; i += 1) s = reducer(s, { type: "messages", id: "s1", messages: [shot(`g${i}`, i, "gordo")] });
    for (let i = 1; i <= 20; i += 1) s = reducer(s, { type: "messages", id: "s1", messages: [shot(`c${i}`, 100 + i)] });
    expect(s.bySession.s1.agentMessages.gordo).toBeUndefined();
    expect(s.bySession.s1.messages).toHaveLength(21);
  });
});

describe("cota dentro del turno en curso", () => {
  it(`un turno de un solo prompt y ${LIVE_CAP * 2} mensajes se queda entre ${LIVE_KEEP} y ${LIVE_CAP}`, () => {
    let s = loaded();
    const turn = Array.from({ length: LIVE_CAP * 2 }, (_, i) => answer(`r${i}`, i + 1));
    for (let i = 0; i < turn.length; i += 100) s = reducer(s, { type: "messages", id: "s1", messages: turn.slice(i, i + 100) });
    const list = s.bySession.s1.messages;
    // Sin el recorte dentro del turno, el hilo entero (3001) seguía en memoria hasta HARD_CAP.
    expect(list.length).toBeGreaterThanOrEqual(LIVE_KEEP);
    expect(list.length).toBeLessThanOrEqual(LIVE_CAP);
    expect(list.some((m) => m.uuid === "p0")).toBe(false);
    expect(list[list.length - 1].uuid).toBe(`r${LIVE_CAP * 2 - 1}`);
    expect(pagingOf(s.bySession.s1, null).hasMore).toBe(true);
  });
});

describe(`hilos de subagente: abiertos + LRU de ${AGENT_THREADS_KEEP}`, () => {
  const flood = (s: State, prefix: string, n: number, from = 0): State => {
    let next = s;
    for (let i = 0; i < n; i += 1) next = reducer(next, { type: "messages", id: "s1", messages: [agentMsg(`${prefix}${i}`, `${prefix}${i}-m`, from + i)] });
    return next;
  };

  it(`con ${AGENT_THREADS_KEEP + 4} subagentes solo quedan los ${AGENT_THREADS_KEEP} más recientes`, () => {
    const s = flood(loaded(), "a", AGENT_THREADS_KEEP + 4);
    const kept = Object.keys(s.bySession.s1.agentMessages);
    expect(kept).toHaveLength(AGENT_THREADS_KEEP);
    expect(kept).not.toContain("a0");
    expect(kept).toContain(`a${AGENT_THREADS_KEEP + 3}`);
  });

  it("un hilo abierto en un panel no se suelta aunque lleguen muchos más", () => {
    let s = flood(loaded(), "a", 1);
    s = reducer(s, { type: "openAgents", open: { s1: ["a0"] } });
    s = flood(s, "b", AGENT_THREADS_KEEP * 3, 10);
    expect(s.bySession.s1.agentMessages.a0).toHaveLength(1);
    expect(Object.keys(s.bySession.s1.agentMessages)).toHaveLength(AGENT_THREADS_KEEP + 1);
  });

  it("al cerrar su panel pasa al LRU y sale si ya hay otros más recientes", () => {
    let s = flood(loaded(), "a", 1);
    s = reducer(s, { type: "openAgents", open: { s1: ["a0"] } });
    s = flood(s, "b", AGENT_THREADS_KEEP, 10);
    expect(s.bySession.s1.agentMessages.a0).toBeDefined();
    s = reducer(s, { type: "openAgents", open: {} });
    expect(s.bySession.s1.agentMessages.a0).toBeUndefined();
  });

  it("el espacio de trabajo publica los hilos abiertos de cada panel", () => {
    const ws: Workspace = { tabs: [], panes: [makePane("s1", "a0"), makePane("s1", null), makePane("s2", "x"), makePane("s1", "a0")], focused: 0, split: "h" };
    expect(openAgentsOf(ws)).toEqual({ s1: ["a0"], s2: ["x"] });
    const wsStore = createStore<Workspace, Workspace>((_, next) => next, ws);
    const dispatch = vi.fn();
    const off = wireOpenAgents(wsStore, dispatch);
    wsStore.dispatch({ ...ws, panes: [makePane("s1", null)] });
    off();
    expect(dispatch.mock.calls.map(([a]) => a.open)).toEqual([{ s1: ["a0"], s2: ["x"] }, {}]);
  });
});

describe("abrir un hilo soltado lo recarga paginado", () => {
  const info = (id: string): SessionInfo => ({
    id, projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: null,
    startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
    permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
  });
  const page = [agentMsg("old", "old-1", 1), agentMsg("old", "old-2", 2), agentMsg("old", "old-3", 3)];

  function fakeApi() {
    const history = vi.fn(async (req: { id: string; agentId?: string }) => ({ messages: req.agentId === "old" ? page : [], hasMore: false }));
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

  function pruneOld(id: string): void {
    store.dispatch({ type: "sessions", sessions: [info(id)] });
    store.dispatch({ type: "messages", id, messages: [agentMsg("old", "old-3", 3)] });
    for (let i = 0; i < AGENT_THREADS_KEEP; i += 1) store.dispatch({ type: "messages", id, messages: [agentMsg(`n${i}`, `n${i}-m`, 10 + i)] });
    expect(store.getState().bySession[id].agentMessages.old).toBeUndefined();
  }

  /** jsdom no trae ResizeObserver; la lista del chat lo usa para seguir el final. */
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  beforeEach(() => vi.stubGlobal("ResizeObserver", NoopResizeObserver));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    store.dispatch({ type: "openAgents", open: {} });
  });

  it("loadHistory del hilo soltado lo repone entero", async () => {
    pruneOld("lru1");
    const { api } = fakeApi();
    await loadHistory(api, "lru1", "old");
    expect(store.getState().bySession.lru1.agentMessages.old.map((m) => m.uuid)).toEqual(["old-1", "old-2", "old-3"]);
  });

  it("montar su panel pide la página y el hilo no se queda vacío aunque sigan llegando subagentes", async () => {
    pruneOld("lru2");
    const { api, history } = fakeApi();
    store.dispatch({ type: "openAgents", open: { lru2: ["old"] } });
    render(
      <ApiContext.Provider value={api}>
        <ChatPane sessionId="lru2" agentId="old" />
      </ApiContext.Provider>,
    );
    await waitFor(() => expect(store.getState().bySession.lru2.agentMessages.old).toHaveLength(3));
    expect(history.mock.calls.some(([r]) => r.id === "lru2" && r.agentId === "old")).toBe(true);
    for (let i = 0; i < AGENT_THREADS_KEEP * 2; i += 1) store.dispatch({ type: "messages", id: "lru2", messages: [agentMsg(`z${i}`, `z${i}-m`, 50 + i)] });
    expect(store.getState().bySession.lru2.agentMessages.old).toHaveLength(3);
  });
});
