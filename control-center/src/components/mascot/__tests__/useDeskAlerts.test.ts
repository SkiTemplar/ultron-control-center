// Sondeo de avisos y calendario (useDeskAlerts.ts): los destinos y las
// entregas anunciadas no crecen sin límite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type MascotEngine } from "../engine";
import type { DeskAlert, DueSoon } from "../deskAlerts";
import { dueKey } from "../deskAlerts";
import type { Navigator } from "../navigator";
import { emptyDecor } from "../render";
import { newState, pollAlerts, pollCalendar, showAgenda, takeAgendaClick, type Ctx } from "../useDeskAlerts";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const failed = (seq: number, state: DeskAlert["state"] = "failed"): DeskAlert => ({
  seq, source: "build", state, what: "tsc", detail: "", cwd: "C:\\demo\\A", projectHint: "A",
  claudeSessionId: null, at: new Date().toISOString(),
});

const entrega = (subject: string, when: DueSoon["when"]): DueSoon => ({
  subject, title: "Práctica", due: new Date(Date.now() + 3_600_000).toISOString(), allDay: false, when,
});

function ctx(): Ctx {
  const eng = { showIcon: vi.fn(), feel: vi.fn() };
  return {
    ready: true,
    engineRef: { current: eng as unknown as MascotEngine },
    navRef: { current: { walkTo: vi.fn() } as unknown as Navigator },
    decor: emptyDecor(),
    quietRef: { current: false },
    settingsRef: { current: { ...DEFAULT_SETTINGS, build_alerts: true, calendar: true } },
    sessionsBusy: () => true,
    st: newState(),
    show: () => true,
  };
}

/** Respuestas del backend por comando; `batch` y `days` cambian entre sondeos. */
function backend(state: { batch: { alerts: DeskAlert[]; lastSeq: number }; days: DueSoon[] }) {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "mascot_desk_alerts") return state.batch;
    if (cmd === "mascot_calendar_today") return state.days;
    if (cmd === "sesiones_list") return [];
    return null;
  });
}

describe("useDeskAlerts: poda del estado", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("un aviso arreglado suelta su destino; uno pendiente lo conserva (negativo)", async () => {
    const c = ctx();
    const state = { batch: { alerts: [failed(1)], lastSeq: 1 }, days: [] };
    backend(state);
    await pollAlerts(c);
    await vi.advanceTimersByTimeAsync(0);
    expect([...c.st.targets.keys()]).toEqual([1]);
    state.batch = { alerts: [], lastSeq: 1 };
    await pollAlerts(c);
    expect([...c.st.targets.keys()]).toEqual([1]); // sigue pendiente: se queda
    state.batch = { alerts: [failed(2, "cleared")], lastSeq: 2 };
    await pollAlerts(c);
    expect(c.st.pending).toEqual([]);
    expect(c.st.targets.size).toBe(0);
  });

  it("las entregas anunciadas se quedan en las de hoy y mañana", async () => {
    const c = ctx();
    const vieja = entrega("OLD1", "tomorrow");
    const state = { batch: { alerts: [], lastSeq: 0 }, days: [vieja] };
    backend(state);
    await pollCalendar(c);
    expect([...c.st.announced]).toEqual([dueKey(vieja)]);
    const hoy = { ...vieja, when: "today" as const };
    state.days = [hoy];
    await pollCalendar(c);
    expect([...c.st.announced]).toEqual([dueKey(hoy)]);
    state.days = [];
    await pollCalendar(c);
    expect(c.st.announced.size).toBe(0);
  });
});

describe("useDeskAlerts: agenda y «visto»", () => {
  beforeEach(() => localStorage.clear());

  function withShow() {
    const c = ctx();
    const calls: { text: string; tag?: string; hint?: string }[] = [];
    let shown: string | undefined;
    c.show = (_k, text, opts) => {
      calls.push({ text, tag: opts?.tag, hint: opts?.hint });
      shown = opts?.tag;
      return true;
    };
    c.showing = (tag) => shown === tag;
    return { c, calls };
  }

  it("clic con el calendario: agenda; otro clic: visto y suelta el calendario", async () => {
    const { c, calls } = withShow();
    const a = entrega("AAA1", "today");
    const b = entrega("BBB2", "tomorrow");
    const state = { batch: { alerts: [], lastSeq: 0 }, days: [a, b] };
    backend(state);
    await pollCalendar(c);
    expect(c.decor.calendar).toEqual({ when: "today" });
    expect(takeAgendaClick(c)).toBe(true);
    const agenda = calls[calls.length - 1];
    expect(agenda.tag).toBe("agenda");
    expect(agenda.text).toContain("AAA1");
    expect(agenda.text).toContain("BBB2");
    expect(agenda.hint).toBeTruthy();
    expect(takeAgendaClick(c)).toBe(true);
    expect(c.decor.calendar).toBeNull();
    expect(JSON.parse(localStorage.getItem("mascot.calendar.dismissed") ?? "[]")).toHaveLength(2);
    // Un sondeo con las mismas entregas no vuelve a sacar el calendario ni el aviso.
    const before = calls.length;
    await pollCalendar(c);
    expect(c.decor.calendar).toBeNull();
    expect(calls.length).toBe(before);
    // Sin nada a la vista, el clic ya no es suyo (saltito normal).
    expect(takeAgendaClick(c)).toBe(false);
  });

  it("una entrega nueva tras el visto vuelve a sacar el calendario (negativo)", async () => {
    const { c } = withShow();
    const a = entrega("AAA1", "tomorrow");
    const state = { batch: { alerts: [], lastSeq: 0 }, days: [a] };
    backend(state);
    await pollCalendar(c);
    takeAgendaClick(c);
    takeAgendaClick(c);
    expect(c.decor.calendar).toBeNull();
    // Llega el día: la de mañana pasa a hoy y es otra clave.
    state.days = [{ ...a, when: "today" }];
    await pollCalendar(c);
    expect(c.decor.calendar).toEqual({ when: "today" });
    expect(c.st.dismissed.size).toBe(0);
  });

  it("«¿Qué tengo pendiente?» sin entregas lo dice, aunque se hayan visto", () => {
    const { c, calls } = withShow();
    showAgenda(c);
    expect(calls[0].text).toMatch(/Nada que entregar/);
    expect(calls[0].hint).toBeUndefined();
  });
});
