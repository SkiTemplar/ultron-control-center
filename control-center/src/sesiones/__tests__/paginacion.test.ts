import { describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { normalizePage } from "../api-tauri";
import { HISTORY_CURSOR_GONE, loadHistory, loadOlder } from "../bootstrap";
import { pageOf } from "../mock/history";
import { HARD_CAP, LIVE_CAP, LIVE_KEEP, capThread } from "../paging";
import { initialState, reducer, type State } from "../reducer";
import { pagingOf } from "../session-state";
import { store } from "../store";
import type { ChatMessage, HistoryPage } from "../types";
import { answer, longThread, prompt } from "./fixtures/long-thread";

const uuids = (list: readonly ChatMessage[]) => list.map((m) => m.uuid);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function historyApi(history: SesionesApi["history"]): SesionesApi {
  return { history } as unknown as SesionesApi;
}

describe("página del historial (§7, regla compartida con el backend)", () => {
  const all = longThread(1000);

  it("sin cursor da los últimos y retrocede hasta el prompt; con cursor, los anteriores", () => {
    const last = pageOf(all, undefined, 95);
    expect(last.messages[0].kind).toBe("prompt");
    expect(last.messages[last.messages.length - 1].uuid).toBe(all[999].uuid);
    expect(last.hasMore).toBe(true);
    const older = pageOf(all, last.messages[0].uuid, 95);
    expect(older.messages[older.messages.length - 1].uuid).toBe(all[all.indexOf(last.messages[0]) - 1].uuid);
  });

  it("la primera página dice que no hay más; un cursor desconocido rechaza con history_cursor_gone", () => {
    expect(pageOf(all, all[5].uuid, 400)).toMatchObject({ hasMore: false });
    expect(() => pageOf(all, "no-existe")).toThrow(HISTORY_CURSOR_GONE);
  });

  it("el adaptador Tauri normaliza la página (y la lista entera de un backend anterior)", () => {
    expect(normalizePage({ messages: all.slice(0, 2), hasMore: true })).toEqual({ messages: all.slice(0, 2), hasMore: true });
    expect(normalizePage(all.slice(0, 2))).toEqual({ messages: all.slice(0, 2), hasMore: false });
  });
});

describe("reducer: página anterior sin duplicados", () => {
  it("antepone la página y no repite los uuid que ya estaban", () => {
    const all = longThread(60);
    let s: State = reducer(initialState, { type: "history", id: "s1", agentId: null, messages: all.slice(30), hasMore: true, generation: 0 });
    expect(pagingOf(s.bySession.s1, null).hasMore).toBe(true);
    // La página trae solapados los dos primeros del hilo: no deben repetirse.
    s = reducer(s, { type: "historyOlder", id: "s1", agentId: null, messages: all.slice(10, 32), hasMore: false, generation: 0 });
    expect(uuids(s.bySession.s1.messages)).toEqual(uuids(all.slice(10)));
    expect(new Set(uuids(s.bySession.s1.messages)).size).toBe(50);
    expect(pagingOf(s.bySession.s1, null)).toMatchObject({ hasMore: false, loading: false });
  });

  it("una página de otra generación (llega tras el reset) se descarta (caso negativo)", () => {
    let s: State = reducer(initialState, { type: "history", id: "s1", agentId: null, messages: longThread(20), generation: 0 });
    s = reducer(s, { type: "reset", id: "s1" });
    const stale = reducer(s, { type: "history", id: "s1", agentId: null, messages: longThread(20, "viejo"), generation: 0 });
    expect(stale).toBe(s);
    const older = reducer(s, { type: "historyOlder", id: "s1", agentId: null, messages: longThread(5, "viejo"), hasMore: true, generation: 0 });
    expect(older).toBe(s);
    const fresh = reducer(s, { type: "history", id: "s1", agentId: null, messages: [prompt("nuevo", 1)], generation: 1 });
    expect(uuids(fresh.bySession.s1.messages)).toEqual(["nuevo"]);
  });

  it("recargar la última página no reordena las páginas anteriores ya cargadas", () => {
    const all = longThread(100);
    let s: State = reducer(initialState, { type: "history", id: "s1", agentId: null, messages: all.slice(60), hasMore: true, generation: 0 });
    s = reducer(s, { type: "historyOlder", id: "s1", agentId: null, messages: all.slice(20, 60), hasMore: true, generation: 0 });
    s = reducer(s, { type: "history", id: "s1", agentId: null, messages: all.slice(70), hasMore: true, generation: 0 });
    expect(uuids(s.bySession.s1.messages)).toEqual(uuids(all.slice(20)));
  });
});

describe("cota en vivo (1500 → 1200)", () => {
  it(`con ${LIVE_CAP + 1} mensajes suelta los más antiguos hasta ${LIVE_KEEP} y marca hasMore`, () => {
    const all = longThread(LIVE_CAP + 1);
    let s: State = reducer(initialState, { type: "history", id: "s1", agentId: null, messages: all.slice(0, LIVE_CAP), hasMore: false, generation: 0 });
    expect(s.bySession.s1.messages).toHaveLength(LIVE_CAP);
    s = reducer(s, { type: "messages", id: "s1", messages: [all[LIVE_CAP]] });
    expect(uuids(s.bySession.s1.messages)).toEqual(uuids(all.slice(all.length - LIVE_KEEP)));
    expect(pagingOf(s.bySession.s1, null).hasMore).toBe(true);
  });

  it(`con ${LIVE_CAP} no recorta nada (caso negativo)`, () => {
    const all = longThread(LIVE_CAP);
    let s: State = reducer(initialState, { type: "history", id: "s1", agentId: null, messages: all.slice(0, LIVE_CAP - 1), hasMore: false, generation: 0 });
    s = reducer(s, { type: "messages", id: "s1", messages: [all[LIVE_CAP - 1]] });
    expect(s.bySession.s1.messages).toHaveLength(LIVE_CAP);
    expect(pagingOf(s.bySession.s1, null).hasMore).toBe(false);
  });

  it(`no toca el turno en curso aunque pase de ${LIVE_KEEP} mensajes mientras quepa en ${LIVE_CAP} (caso negativo)`, () => {
    const before = longThread(300, "a");
    const turn = [prompt("turno", 9000), ...Array.from({ length: LIVE_CAP - 1 }, (_, i) => answer(`r${i}`, 9001 + i))];
    const out = capThread([...before, ...turn]);
    expect(out[0].uuid).toBe("turno");
    expect(out).toHaveLength(turn.length);
  });

  it("anclado arriba solo recorta por encima de la cota dura", () => {
    const all = longThread(LIVE_CAP + 50);
    expect(capThread(all, true)).toBe(all);
    expect(capThread(longThread(HARD_CAP + 1), true)).toHaveLength(LIVE_KEEP);
  });
});

describe("bootstrap: carrera de /clear y cursor perdido", () => {
  it("un loadHistory que responde después del reset no mete el hilo viejo", async () => {
    const id = "carrera";
    const old = deferred<HistoryPage>();
    const api = historyApi(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({ messages: [prompt("nuevo", 1)], hasMore: false }));
    const first = loadHistory(api, id, null);
    store.dispatch({ type: "reset", id });
    await loadHistory(api, id, null);
    old.resolve({ messages: longThread(30, "viejo"), hasMore: true });
    await first;
    expect(uuids(store.getState().bySession[id].messages)).toEqual(["nuevo"]);
    expect(pagingOf(store.getState().bySession[id], null).hasMore).toBe(false);
  });

  it("sin reset de por medio la misma respuesta sí se aplica (caso negativo)", async () => {
    const id = "sin-carrera";
    const page = deferred<HistoryPage>();
    const pending = loadHistory(historyApi(vi.fn().mockReturnValue(page.promise)), id, null);
    page.resolve({ messages: longThread(30, "viejo"), hasMore: true });
    await pending;
    expect(store.getState().bySession[id].messages).toHaveLength(30);
  });

  it("history_cursor_gone recarga desde el final y lo avisa", async () => {
    const id = "cursor";
    const all = longThread(120, "c");
    store.dispatch({ type: "history", id, agentId: null, messages: all.slice(60), hasMore: true, generation: 0 });
    const history = vi.fn()
      .mockRejectedValueOnce(HISTORY_CURSOR_GONE)
      .mockResolvedValueOnce({ messages: all.slice(80), hasMore: true });
    await loadOlder(historyApi(history), id, null);
    expect(history.mock.calls[0][0]).toMatchObject({ id, beforeUuid: all[60].uuid });
    expect(history.mock.calls[1][0]).toEqual({ id, agentId: undefined });
    const s = store.getState().bySession[id];
    expect(uuids(s.messages)).toEqual(uuids(all.slice(80)));
    expect(s.notes[s.notes.length - 1].text).toMatch(/recargado desde el final/);
    expect(pagingOf(s, null).loading).toBe(false);
  });

  it("otro error al cargar anteriores no recarga ni toca el hilo (caso negativo)", async () => {
    const id = "cursor-ko";
    const all = longThread(40, "k");
    store.dispatch({ type: "history", id, agentId: null, messages: all.slice(20), hasMore: true, generation: 0 });
    const history = vi.fn().mockRejectedValue(new Error("sin red"));
    await loadOlder(historyApi(history), id, null);
    expect(history).toHaveBeenCalledTimes(1);
    expect(store.getState().error).toMatch(/sin red/);
    expect(uuids(store.getState().bySession[id].messages)).toEqual(uuids(all.slice(20)));
    expect(pagingOf(store.getState().bySession[id], null)).toMatchObject({ hasMore: true, loading: false });
  });

  it("loadOlder contra la regla de página llega al inicio sin duplicados", async () => {
    const id = "hasta-el-inicio";
    const all = longThread(1000, "h");
    const history: SesionesApi["history"] = async ({ beforeUuid }) => pageOf(all, beforeUuid, 150);
    await loadHistory(historyApi(history), id, null);
    for (let i = 0; i < 20 && pagingOf(store.getState().bySession[id], null).hasMore; i += 1) {
      await loadOlder(historyApi(history), id, null);
    }
    expect(uuids(store.getState().bySession[id].messages)).toEqual(uuids(all));
  });
});
