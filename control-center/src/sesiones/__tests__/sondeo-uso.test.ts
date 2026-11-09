// Auditoría de estabilidad nocturna, hallazgo 3: el sondeo de uso del plan no
// corre con la ventana oculta, en reposo va cada 10 min y a 60 s solo con
// turnos activos; al volver a estar visible, una actualización inmediata.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_ACTIVE_MS, PLAN_IDLE_MS, PLAN_MIN_MS, planInterval, startPlanPolling } from "../plan-poll";

let visibility: DocumentVisibilityState = "visible";

function setVisibility(v: DocumentVisibilityState): void {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

function harness(initialWorking = false) {
  let working = initialWorking;
  const listeners = new Set<() => void>();
  const refresh = vi.fn();
  const stop = startPlanPolling({
    refresh,
    isWorking: () => working,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  });
  const setWorking = (w: boolean) => {
    working = w;
    listeners.forEach((l) => l());
  };
  return { refresh, stop, setWorking };
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("intervalo del sondeo de uso", () => {
  it("oculta: en pausa; visible: 60 s con turnos y 10 min en reposo", () => {
    expect(planInterval(true, true)).toBeNull();
    expect(planInterval(false, true)).toBe(PLAN_ACTIVE_MS);
    expect(planInterval(false, false)).toBe(PLAN_IDLE_MS);
  });

  it("en reposo no sondea cada minuto (caso negativo del setInterval de 60 s)", () => {
    const h = harness(false);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PLAN_IDLE_MS - 1000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(h.refresh).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("con una sesión en working sondea cada 60 s y vuelve a 10 min al terminar", () => {
    const h = harness(false);
    h.setWorking(true);
    vi.advanceTimersByTime(PLAN_ACTIVE_MS);
    expect(h.refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PLAN_ACTIVE_MS);
    expect(h.refresh).toHaveBeenCalledTimes(3);
    h.setWorking(false);
    vi.advanceTimersByTime(PLAN_ACTIVE_MS * 5);
    expect(h.refresh).toHaveBeenCalledTimes(3);
    h.stop();
  });

  it("con la ventana oculta no sondea nada y al volver actualiza en el acto", () => {
    const h = harness(true);
    setVisibility("hidden");
    vi.advanceTimersByTime(8 * 60 * 60 * 1000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    expect(h.refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PLAN_ACTIVE_MS);
    expect(h.refresh).toHaveBeenCalledTimes(3);
    h.stop();
  });

  it("caso negativo: ocultar y volver enseguida no repite la actualización", () => {
    const h = harness(true);
    setVisibility("hidden");
    setVisibility("visible");
    setVisibility("hidden");
    setVisibility("visible");
    expect(h.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PLAN_ACTIVE_MS);
    expect(h.refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PLAN_MIN_MS);
    setVisibility("hidden");
    setVisibility("visible");
    expect(h.refresh).toHaveBeenCalledTimes(3);
    h.stop();
  });

  it("parar el sondeo suelta el temporizador y el oyente de visibilidad", () => {
    const h = harness(true);
    h.stop();
    vi.advanceTimersByTime(PLAN_IDLE_MS * 2);
    setVisibility("visible");
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
