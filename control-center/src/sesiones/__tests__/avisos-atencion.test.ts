// Avisos de atención (attention.ts): parpadeo en la barra de tareas y toast de
// Windows al terminar un turno o pedir respuesta, solo sin foco, una vez por
// transición y nunca por lo que llega al arrancar (historial, preguntas
// recuperadas o eventos fechados antes de armarse).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { SESSIONS } from "../mock/data";
import { DEFAULT_PREFS, setPrefs } from "../prefs";
import { store } from "../store";
import type { AskEvent, QueueItem, SessionInfo, TurnPayload } from "../types";

const win = vi.hoisted(() => {
  const make = (label: string) => ({ label, isFocused: vi.fn(async () => false), requestUserAttention: vi.fn<(t: number | null) => Promise<void>>(async () => undefined) });
  const state = { current: make("sesiones"), all: [] as ReturnType<typeof make>[], make };
  state.all = [state.current];
  return state;
});
const invoke = vi.hoisted(() => vi.fn<(cmd: string, args?: unknown) => Promise<void>>(async () => undefined));

vi.mock("@tauri-apps/api/window", () => ({
  UserAttentionType: { Critical: 1, Informational: 2 },
  getCurrentWindow: () => win.current,
  getAllWindows: async () => win.all,
}));
vi.mock("@tauri-apps/api/core", async (orig) => ({ ...(await orig<typeof import("@tauri-apps/api/core")>()), invoke }));

const session: SessionInfo = { ...SESSIONS[0], id: "s-aviso", title: "Refactor del gestor", projectName: "ultron", status: "working" };
const handlers: Record<string, (p: unknown) => void> = {};
let releaseList: (s: SessionInfo[]) => void = () => undefined;
const restoredAsk: AskEvent = { askId: "restaurada", id: session.id, kind: "question", questions: [], createdAt: new Date().toISOString() };

const fake = new Proxy({ isMock: false }, {
  get(target, prop: string) {
    if (prop in target) return (target as Record<string, unknown>)[prop];
    if (prop === "then") return undefined;
    if (prop === "on") return async (name: string, cb: (p: unknown) => void) => ((handlers[name] = cb), () => undefined);
    if (prop === "list") return () => new Promise<SessionInfo[]>((r) => (releaseList = r));
    if (prop === "pendingAsks") return async () => [restoredAsk];
    if (prop === "engineList" || prop === "queueList") return async () => [];
    if (prop === "history") return async () => ({ messages: [], hasMore: false });
    return () => new Promise<never>(() => undefined);
  },
}) as unknown as SesionesApi;

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), loadApi: async () => fake, getApi: () => fake }));

const flush = () => new Promise((r) => window.setTimeout(r, 10));
let turnSeq = 0;
const turn = (patch: Partial<TurnPayload> = {}): TurnPayload => {
  turnSeq += 1;
  const now = new Date().toISOString();
  return { id: session.id, turnId: `t${turnSeq}`, startedAt: now, endedAt: now, durationMs: 1000, reason: "answer", ...patch };
};
const ask = (kind: "question" | "permission", askId: string): AskEvent =>
  kind === "permission"
    ? { askId, id: session.id, kind, tool: "Bash", input: {}, summary: "rm -rf build", agentId: null, createdAt: new Date().toISOString() }
    : { askId, id: session.id, kind, questions: [], createdAt: new Date().toISOString() };

const emit = async (name: string, payload: unknown) => {
  handlers[name](payload);
  await flush();
};
const notifyCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === "plugin:notification|notify");
const flashes = () => win.current.requestUserAttention.mock.calls.map(([t]) => t);
let hasFocus = vi.spyOn(document, "hasFocus");

beforeAll(async () => {
  hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const { bootstrap } = await import("../bootstrap");
  const booting = bootstrap();
  await flush();
  // Antes de armar (arranque en curso): un fin de turno restaurado no avisa.
  await emit("sesiones://turn", turn());
  releaseList([session]);
  await booting;
  await flush();
});

beforeEach(() => {
  hasFocus.mockReturnValue(false);
  win.all = [win.current];
  win.current.isFocused.mockResolvedValue(false);
  window.dispatchEvent(new Event("focus")); // cancela el parpadeo que dejara el test anterior
  win.current.requestUserAttention.mockClear();
  invoke.mockClear();
  setPrefs({ attentionToast: DEFAULT_PREFS.attentionToast, attentionFlash: DEFAULT_PREFS.attentionFlash });
});

afterEach(() => store.dispatch({ type: "queue", id: session.id, items: [] }));

describe("avisos de atención", () => {
  it("el arranque (fin de turno antes de armar y preguntas recuperadas) no avisa", () => {
    expect(store.getState().asks.some((a) => a.askId === "restaurada")).toBe(true);
    expect(flashes()).toEqual([]);
    expect(notifyCalls()).toEqual([]);
  });

  it("sin foco: un fin de turno parpadea (Informational) y saca el toast con título y proyecto", async () => {
    await emit("sesiones://turn", turn());
    expect(flashes()).toEqual([2]);
    expect(notifyCalls()).toEqual([["plugin:notification|notify", { options: { title: "Refactor del gestor", body: "Turno terminado · ultron" } }]]);
  });

  it("pregunta y permiso parpadean como Critical con su línea", async () => {
    await emit("sesiones://ask", ask("question", "q1"));
    await emit("sesiones://ask", ask("permission", "p1"));
    expect(flashes()).toEqual([1, 1]);
    expect(notifyCalls().map(([, a]) => (a as { options: { body: string } }).options.body)).toEqual([
      "Pregunta pendiente · ultron",
      "Permiso pendiente · ultron",
    ]);
  });

  it("caso negativo: con el documento enfocado no avisa", async () => {
    hasFocus.mockReturnValue(true);
    await emit("sesiones://turn", turn());
    await emit("sesiones://ask", ask("permission", "p-foco"));
    expect(flashes()).toEqual([]);
    expect(notifyCalls()).toEqual([]);
  });

  it("caso negativo: con otra ventana de Sessions enfocada no avisa", async () => {
    const other = win.make("sesiones-ab12cd34");
    other.isFocused.mockResolvedValue(true);
    win.all = [win.current, other];
    await emit("sesiones://turn", turn());
    expect(flashes()).toEqual([]);
    expect(notifyCalls()).toEqual([]);
  });

  it("con varias ventanas sin foco avisa solo la principal", async () => {
    win.all = [win.make("sesiones-ab12cd34"), win.current];
    await emit("sesiones://turn", turn());
    expect(flashes()).toHaveLength(1);
    expect(notifyCalls()).toHaveLength(1);
  });

  it("una sola vez por transición: el mismo turno o la misma pregunta repetidos no vuelven a avisar", async () => {
    const t = turn();
    await emit("sesiones://turn", t);
    await emit("sesiones://turn", t);
    const q = ask("question", "q-repe");
    await emit("sesiones://ask", q);
    await emit("sesiones://ask", q);
    expect(flashes()).toHaveLength(2);
    expect(notifyCalls()).toHaveLength(2);
  });

  it("no avisa de un turno fechado antes del arranque (restaurado), interrumpido ni con la cola pendiente", async () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    await emit("sesiones://turn", turn({ startedAt: old, endedAt: old }));
    await emit("sesiones://turn", turn({ reason: "aborted" }));
    const queued: QueueItem = { clientId: "c1", text: "sigue", attachments: [], delegate: false, kind: "prompt", origin: "ultron", state: "queued", createdAt: old };
    store.dispatch({ type: "queue", id: session.id, items: [queued] });
    await emit("sesiones://turn", turn());
    expect(flashes()).toEqual([]);
    expect(notifyCalls()).toEqual([]);
  });

  it("respeta los interruptores por separado", async () => {
    setPrefs({ attentionToast: false });
    await emit("sesiones://turn", turn());
    expect(flashes()).toHaveLength(1);
    expect(notifyCalls()).toHaveLength(0);

    setPrefs({ attentionToast: true, attentionFlash: false });
    await emit("sesiones://turn", turn());
    expect(flashes()).toHaveLength(1);
    expect(notifyCalls()).toHaveLength(1);

    setPrefs({ attentionToast: false, attentionFlash: false });
    await emit("sesiones://ask", ask("permission", "p-off"));
    expect(flashes()).toHaveLength(1);
    expect(notifyCalls()).toHaveLength(1);
  });

  it("al enfocar la ventana se cancela el parpadeo, y solo si había uno", async () => {
    window.dispatchEvent(new Event("focus"));
    expect(flashes()).toEqual([]);
    await emit("sesiones://turn", turn());
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(flashes()).toEqual([2, null]);
  });
});
