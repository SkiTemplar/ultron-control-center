// Paquete panel-uso (hallazgos 1-10): la pestaña Uso y el HUD leen el mismo
// ritmo y se refrescan con el intervalo; la caché dice de cuándo es y por qué;
// los tokens de la sesión incluyen la escritura de caché; useLoad no enseña el
// dato de otra clave; git se comparte por directorio; los subagentes se
// valoran con su modelo y el tope de turnos no es un 100 fijo.

import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { UsageSeg } from "../components/hud/SegmentsSession";
import { Agentes } from "../components/inspector/Agentes";
import { Uso } from "../components/inspector/Uso";
import { limitLine } from "../components/inspector/uso-format";
import { refreshPlan, resetPlanState, type PlanPace } from "../components/inspector/uso-state";
import { ApiContext } from "../context";
import { resetGitStore, useGit } from "../hooks/useGit";
import { useLoad, useReloadOnTurnEnd } from "../hooks/useLoad";
import { SESSIONS } from "../mock/data";
import { costOf } from "../pricing";
import { store } from "../store";
import { statsOfTurn } from "../timeline";
import type { AgentNode, ChatMessage, GitRepoSnapshot, SessionStatus, TurnPayload, UsoWindow } from "../types";

function fakeApi(overrides: Partial<Record<keyof SesionesApi, unknown>>): SesionesApi {
  return new Proxy({ isMock: true } as unknown as SesionesApi, {
    get(target, key: string) {
      if (key in overrides) return overrides[key as keyof SesionesApi];
      if (key in target) return (target as unknown as Record<string, unknown>)[key];
      return () => Promise.reject(new Error(`${key}: no implementado en el test`));
    },
  });
}

const withApi = (api: SesionesApi, node: ReactNode) => <ApiContext.Provider value={api}>{node}</ApiContext.Provider>;

const win = (kind: string, used: number, extra: Partial<UsoWindow> = {}): UsoWindow => ({
  kind, used, elapsedPct: 50, linearElapsedPct: 50, projectedPct: used * 2, isScheduled: false, isAlert: false,
  resetsAtMs: Date.now() + 90 * 60000, runsOutLabel: null, ...extra,
});

const pace = (five: number, week: number, extra: Partial<PlanPace> = {}): PlanPace => ({
  windows: [win("five_hour", five, { runsOutLabel: five >= 30 ? "hoy 18:30" : null }), win("seven_day", week, { projectedPct: 55.5 })],
  weekInFiveHourPct: null,
  ...extra,
});

const USAGE = { fiveHour: { percent: 2, resetsAt: null }, weekly: { percent: 42, resetsAt: null }, stale: false };

afterEach(() => resetPlanState());

describe("Uso y HUD con el mismo ritmo (hallazgos 1 y 2)", () => {
  it("el refresco periódico actualiza la pestaña abierta (sin él se queda con la primera cifra)", async () => {
    let five = 2;
    const usagePace = vi.fn(async () => pace(five, 42));
    const api = fakeApi({ usage: async () => USAGE, usagePace });
    render(withApi(api, <Uso sessionId={null} />));
    await waitFor(() => expect(screen.getByTestId("uso-five_hour").textContent).toContain("2 %"));
    five = 30;
    await act(() => refreshPlan(api));
    expect(usagePace).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("uso-five_hour").textContent).toContain("30 %");
  });

  it("el HUD marca en rojo la ventana de 5 h que llega al límite antes del reset y da el ritmo de Uso", async () => {
    const p = pace(30, 42);
    const api = fakeApi({ usage: async () => USAGE, usagePace: async () => p });
    await act(() => refreshPlan(api));
    render(withApi(api, <UsageSeg />));
    const trigger = screen.getByTestId("hud-usage");
    const five = within(trigger).getByText("30 %");
    expect(five.className).toContain("err");
    const week = p.windows[1] as UsoWindow;
    expect(limitLine(week)).toContain("56 %");
    expect(within(trigger).getByText("56 %")).toBeTruthy();
    expect(trigger.textContent).not.toContain("×");
  });

  it("si el ritmo deja de refrescarse, el HUD pinta el uso vigente y dice por qué", async () => {
    let paceFails = false;
    let usage = USAGE;
    const api = fakeApi({
      usage: async () => usage,
      usagePace: async () => {
        if (paceFails) throw new Error("uso.cjs no responde");
        return pace(30, 42);
      },
    });
    await act(() => refreshPlan(api));
    render(withApi(api, <UsageSeg />));
    expect(within(screen.getByTestId("hud-usage")).getByText("30 %")).toBeTruthy();
    paceFails = true;
    usage = { fiveHour: { percent: 71, resetsAt: null }, weekly: { percent: 80, resetsAt: null }, stale: false };
    await act(() => refreshPlan(api));
    const trigger = screen.getByTestId("hud-usage");
    expect(within(trigger).getByText("71 %")).toBeTruthy();
    expect(within(trigger).queryByText("30 %")).toBeNull();
    fireEvent.click(trigger);
    expect((await screen.findByTestId("hud-pace-error")).textContent).toContain("uso.cjs no responde");
  });
});

describe("Uso: fuente, estados vacíos y tokens (hallazgos 3, 5 y 10)", () => {
  it("con la caché dice desde cuándo y el motivo del fallo", async () => {
    const stale = pace(2, 42, { stale: true, fetchedAtMs: Date.now() - 12 * 60000, lastError: "token OAuth rechazado (401/403)", source: "oauth" });
    render(withApi(fakeApi({ usage: async () => ({ ...USAGE, stale: true }), usagePace: async () => stale }), <Uso sessionId={null} />));
    expect(await screen.findByText(/Datos en caché desde hace 12 min: token OAuth rechazado/)).toBeTruthy();
  });

  it("sin ventanas lo explica, y un mismo fallo sale una sola vez", async () => {
    const { unmount } = render(withApi(fakeApi({ usage: async () => USAGE, usagePace: async () => ({ windows: [], weekInFiveHourPct: null }) }), <Uso sessionId={null} />));
    expect(await screen.findByText(/no trae ninguna ventana/)).toBeTruthy();
    unmount();
    resetPlanState();
    const fail = () => Promise.reject("sin red");
    render(withApi(fakeApi({ usage: fail, usagePace: fail }), <Uso sessionId={null} />));
    expect(await screen.findByText(/No se pudo leer el uso del plan: sin red/)).toBeTruthy();
    expect(screen.queryByText(/No se pudo calcular el ritmo/)).toBeNull();
  });

  it("suma la escritura de caché y avisa si solo cuenta los mensajes cargados", async () => {
    const id = "uso-tokens";
    const m: ChatMessage = {
      uuid: "a1", role: "assistant", agentId: null, timestamp: "2026-10-13T10:00:00Z", blocks: [],
      usage: { input: 1000, output: 2000, cacheRead: 3000, cacheWrite: 45000 },
    };
    act(() => store.dispatch({ type: "history", id, agentId: null, messages: [m], hasMore: true }));
    render(withApi(fakeApi({ usage: async () => USAGE, usagePace: async () => pace(2, 42) }), <Uso sessionId={id} />));
    expect(await screen.findByText("Escrito en caché")).toBeTruthy();
    expect(screen.getByText("Mensajes cargados")).toBeTruthy();
    expect(screen.queryByText("Esta sesión")).toBeNull();
  });
});

describe("Actualizar fuerza el dato en vivo (hallazgo 4)", () => {
  it("con el refresco del intervalo en vuelo no se une a él: pide de nuevo con force", async () => {
    let release: () => void = () => undefined;
    let gated = false;
    const usage = vi.fn(async (_req?: { force?: boolean }) => {
      if (gated) await new Promise<void>((r) => (release = r));
      return USAGE;
    });
    const usagePace = vi.fn(async (_req?: { force?: boolean }) => pace(2, 42));
    const api = fakeApi({ usage, usagePace });
    render(withApi(api, <Uso sessionId={null} />));
    const button = await screen.findByRole("button", { name: "Actualizar" });
    gated = true;
    let interval: Promise<void> = Promise.resolve();
    act(() => {
      interval = refreshPlan(api);
    });
    gated = false;
    fireEvent.click(button);
    await act(async () => {
      release();
      await interval;
    });
    await waitFor(() => expect(usagePace).toHaveBeenCalledTimes(3));
    expect(usage.mock.calls).toEqual([[], [], [{ force: true }]]);
    expect(usagePace.mock.calls).toEqual([[], [], [{ force: true }]]);
    await screen.findByRole("button", { name: "Actualizar" });
  });

  it("el intervalo sigue compartiendo la petición en vuelo y sin force", async () => {
    const usage = vi.fn(async (_req?: { force?: boolean }) => USAGE);
    const usagePace = vi.fn(async (_req?: { force?: boolean }) => pace(2, 42));
    const api = fakeApi({ usage, usagePace });
    await act(() => Promise.all([refreshPlan(api), refreshPlan(api)]).then(() => undefined));
    expect(usage.mock.calls).toEqual([[]]);
    expect(usagePace.mock.calls).toEqual([[]]);
  });
});

describe("useLoad (hallazgo 7)", () => {
  it("al cambiar de clave no conserva el dato de la anterior aunque la nueva falle", async () => {
    const load = (key: string) => (key === "A" ? Promise.resolve("tablero A") : Promise.reject(new Error("sin kanban")));
    const { result, rerender } = renderHook(({ k }) => useLoad(() => load(k), k), { initialProps: { k: "A" } });
    await waitFor(() => expect(result.current.data).toBe("tablero A"));
    rerender({ k: "B" });
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.error).toBe("sin kanban"));
    expect(result.current.data).toBeNull();
  });

  it("recarga al cerrar el turno, no mientras trabaja", () => {
    const reload = vi.fn();
    const { rerender } = renderHook(({ s }: { s: SessionStatus }) => useReloadOnTurnEnd(s, reload), { initialProps: { s: "idle" as SessionStatus } });
    rerender({ s: "working" });
    expect(reload).not.toHaveBeenCalled();
    rerender({ s: "idle" });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("useGit compartido (hallazgo 8)", () => {
  beforeEach(() => resetGitStore());

  it("una petición por directorio y la recarga llega a todos los que lo miran", async () => {
    let n = 0;
    const gitSnapshot = vi.fn(async () => ({ state: { is_repo: true, dirty_count: ++n } }) as unknown as GitRepoSnapshot);
    const api = fakeApi({ gitSnapshot });
    const wrapper = ({ children }: { children: ReactNode }) => withApi(api, children);
    const { result } = renderHook(() => ({ a: useGit("/p"), b: useGit("/p") }), { wrapper });
    await waitFor(() => expect(result.current.b.snapshot).not.toBeNull());
    expect(gitSnapshot).toHaveBeenCalledTimes(1);
    act(() => result.current.a.reload());
    await waitFor(() => expect(result.current.b.snapshot?.state.dirty_count).toBe(2));
  });
});

describe("subagentes (hallazgos 6 y 9)", () => {
  it("valora el subagente con su modelo y con el de la sesión solo si falta", () => {
    const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    const turn = (model?: string): TurnPayload => ({
      id: "s", turnId: "t", startedAt: "", endedAt: "", durationMs: 0, reason: "answer",
      subagentUsage: [{ ...u, ...(model ? { model } : {}) }],
    });
    const sonnet = statsOfTurn(turn("claude-sonnet-5-5"), "claude-opus-5-5");
    expect(sonnet?.subagents).toBeCloseTo(costOf("claude-sonnet-5-5", u) ?? -1, 6);
    const fallback = statsOfTurn(turn(), "claude-opus-5-5");
    expect(fallback?.subagents).toBeCloseTo(costOf("claude-opus-5-5", u) ?? -1, 6);
  });

  it("sin maxTurns no inventa un denominador de 100; con él lo usa", () => {
    const session = SESSIONS[0];
    const node = (agentId: string, turns: number, maxTurns?: number): AgentNode => ({
      agentId, parentAgentId: null, type: "debugger", description: agentId, status: "running", startedAt: "", turns, tokens: 0,
      ...(maxTurns ? { maxTurns } : {}),
    }) as AgentNode;
    act(() => store.dispatch({ type: "agents", id: session.id, agents: [node("sin-tope", 150), node("con-tope", 150, 200)] }));
    render(withApi(fakeApi({}), <Agentes session={session} currentAgent={null} />));
    expect(screen.getByText("150 turnos")).toBeTruthy();
    expect(screen.getByText("150/200")).toBeTruthy();
    expect(screen.queryByText("150/100")).toBeNull();
  });
});
