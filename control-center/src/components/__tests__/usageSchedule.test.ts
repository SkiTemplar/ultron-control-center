// Horario de uso (usageSchedule.ts) y su efecto en planPace.
//
// Covers:
//   (a) Validacion: los mismos casos inválidos que el selftest de Node devuelven null.
//   (b) Pesado: peso 1 = lineal, extremos 0/100, monotonía y el cálculo a mano de una franja baja.
//   (c) planPace: el aviso semanal cambia con el horario; la ventana de 5 h nunca se pondera.
//   (d) Paridad: el port reproduce los valores de referencia de hooks/scripts/lib/usage-schedule.js.

import { describe, expect, it } from "vitest";
import { planPace } from "../usage/planPace";
import parity from "../usage/usage-schedule-parity.json";
import { normalizeSchedule, weightedElapsedPct, type UsageSchedule } from "../usage/usageSchedule";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

// Semana de prueba: viernes 2026-09-25 03:00 -> viernes 2026-10-02 03:00.
const START = at(2026, 9, 25, 3);
const RESET = at(2026, 10, 2, 3);
const WEEK = 7 * 86_400_000;

// Horario sintetico (el repo es publico: nada de horarios reales).
const SAMPLE_SHAPE = {
  lowWeight: 0.15,
  baseWeight: { sat: 0.8, sun: 0.8 },
  low: {
    mon: [["00:00", "08:00"], ["13:00", "14:00"]],
    tue: [["00:00", "14:00"]],
    wed: [["00:00", "08:00"], ["13:00", "14:00"]],
    thu: [["00:00", "16:00"], ["21:00", "23:00"]],
    fri: [["00:00", "08:00"]],
  },
};

function schedule(raw: unknown): UsageSchedule {
  const s = normalizeSchedule(raw);
  if (!s) throw new Error("horario de prueba invalido");
  return s;
}

describe("normalizeSchedule", () => {
  it("acepta un horario válido e ignora las claves con guion bajo", () => {
    const s = normalizeSchedule({ _comment: "x", ...SAMPLE_SHAPE, baseWeight: { _c: "y", sat: 0.8 } });
    expect(s).not.toBeNull();
    expect(s?.lowWeight).toBe(0.15);
    expect(s?.baseWeight.sat).toBe(0.8);
    expect(s?.low.tue).toEqual([[0, 14]]);
  });

  it.each([
    ["no es un objeto", null],
    ["array", []],
    ["lowWeight 0", { lowWeight: 0, low: {} }],
    ["lowWeight > 1", { lowWeight: 2, low: {} }],
    ["día desconocido", { lowWeight: 0.2, low: { lunes: [["01:00", "02:00"]] } }],
    ["franja invertida", { lowWeight: 0.2, low: { mon: [["10:00", "03:00"]] } }],
    ["hora mal escrita", { lowWeight: 0.2, low: { mon: [["3", "10:00"]] } }],
    ["baseWeight fuera de rango", { lowWeight: 0.2, baseWeight: { sat: 5 }, low: {} }],
    ["franjas no son lista", { lowWeight: 0.2, low: { mon: "01:00-07:00" } }],
  ])("rechaza: %s", (_name, raw) => {
    expect(normalizeSchedule(raw)).toBeNull();
  });
});

describe("weightedElapsedPct", () => {
  it("con peso 1 coincide con el tiempo lineal", () => {
    const flat = schedule({ lowWeight: 1, low: { mon: [["01:00", "07:00"]], thu: [["01:00", "17:00"]] } });
    const now = at(2026, 9, 28, 22, 47);
    expect(weightedElapsedPct(START, now, RESET, flat)).toBeCloseTo(((now - START) / WEEK) * 100, 6);
  });

  it("0 % al inicio, 100 % al reset y nunca baja", () => {
    const s = schedule(SAMPLE_SHAPE);
    expect(weightedElapsedPct(START, START, RESET, s)).toBeCloseTo(0, 9);
    expect(weightedElapsedPct(START, RESET, RESET, s)).toBeCloseTo(100, 9);
    let last = -1;
    for (let i = 0; i <= 50; i++) {
      const v = weightedElapsedPct(START, START + (WEEK * i) / 50, RESET, s) as number;
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it("una franja baja avanza menos que el reloj (cálculo a mano: 16,7 % a las 13:00)", () => {
    const s = schedule({ lowWeight: 0.1, low: { tue: [["01:00", "13:00"]] } });
    const start = at(2026, 9, 29, 0);
    const v = weightedElapsedPct(start, at(2026, 9, 29, 13), at(2026, 9, 30, 0), s) as number;
    expect(v).toBeLessThan(54.2 - 30);
    expect(v).toBeCloseTo(((1 + 12 * 0.1) / (24 - 12 + 1.2)) * 100, 6);
  });
});

describe("planPace con horario", () => {
  const threeQuietDays = schedule({
    lowWeight: 0.1,
    low: { tue: [["00:00", "24:00"]], wed: [["00:00", "24:00"]], thu: [["00:00", "24:00"]] },
  });
  const now = at(2026, 9, 28, 22);
  const resetIso = new Date(RESET).toISOString();

  it("60 % usado el lunes por la noche avisa en lineal y no con tres días flojos por delante", () => {
    const linear = planPace("seven_day", 60, resetIso, now);
    const weighted = planPace("seven_day", 60, resetIso, now, threeQuietDays);
    expect(linear?.alert).toBe(true);
    expect(linear?.scheduled).toBe(false);
    expect(weighted?.scheduled).toBe(true);
    expect(weighted?.alert).toBe(false);
    expect(weighted!.elapsedPct).toBeGreaterThan(80);
    expect(weighted!.linearElapsedPct).toBeLessThan(weighted!.elapsedPct);
    expect(weighted!.projectedPct).toBeLessThan(linear!.projectedPct);
  });

  it("la ventana de 5 h nunca se pondera", () => {
    const five = planPace("five_hour", 30, new Date(now + 2.5 * 3_600_000).toISOString(), now, threeQuietDays);
    expect(five?.scheduled).toBe(false);
    expect(five?.elapsedPct).toBeCloseTo(five!.linearElapsedPct, 9);
  });

  it("sin horario el resultado es el lineal de siempre", () => {
    const p = planPace("seven_day", 30, resetIso, now, null);
    expect(p?.scheduled).toBe(false);
    expect(p?.elapsedPct).toBeCloseTo(p!.linearElapsedPct, 9);
  });
});

describe("paridad con hooks/scripts/lib/usage-schedule.js", () => {
  // Valores de referencia generados con la libreria de Node; su selftest lee el mismo
  // fichero (usage-schedule-parity.json), asi que si una de las dos se desvia falla su prueba.
  it("el port reproduce los valores de referencia de la librería de Node", () => {
    const s = schedule(parity.schedule);
    const p = (a: number[]) => at(a[0], a[1], a[2], a[3], a[4]);
    expect(parity.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of parity.cases) {
      expect(weightedElapsedPct(p(parity.start), p(c.now), p(parity.reset), s)).toBeCloseTo(c.pct, 9);
    }
  });
});
