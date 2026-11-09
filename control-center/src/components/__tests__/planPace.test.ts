import { describe, expect, test } from "vitest";
import { planPace } from "../usage/planPace";

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const H = 3_600_000;
const D = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("planPace", () => {
  test("la ventana de 5 h avisa por encima del ritmo", () => {
    const p = planPace("five_hour", 22, iso(NOW + 4 * H), NOW)!;
    expect(p.over).toBe(true);
    expect(p.alert).toBe(true);
  });

  test("la ventana de 5 h al 30 % yendo al ritmo no avisa: ya no hay techo absoluto", () => {
    const p = planPace("five_hour", 30, iso(NOW + 1 * H), NOW)!;
    expect(p.over).toBe(false);
    expect(p.alert).toBe(false);
    expect("capPct" in p).toBe(false);
  });

  test("la ventana de 5 h con 50 % a la primera hora proyecta un 250 %", () => {
    const p = planPace("five_hour", 50, iso(NOW + 4 * H), NOW)!;
    expect(Math.round(p.elapsedPct)).toBe(20);
    expect(Math.round(p.projectedPct)).toBe(250);
    expect(p.alert).toBe(true);
  });

  test("marca REDUCIR USO con 50 % semanal un día después del reset", () => {
    expect(planPace("seven_day", 50, iso(NOW + 6 * D), NOW)!.alert).toBe(true);
  });

  test("no avisa cuando el consumo va por detrás del tiempo transcurrido", () => {
    expect(planPace("seven_day", 40, iso(NOW + 3.5 * D), NOW)!.over).toBe(false);
  });

  test("no avisa por debajo del suelo de uso al empezar la ventana", () => {
    expect(planPace("five_hour", 10, iso(NOW + 5 * H - 60_000), NOW)!.over).toBe(false);
  });

  test("no avisa con la cuota ya agotada", () => {
    expect(planPace("five_hour", 100, iso(NOW + 4 * H), NOW)!.over).toBe(false);
  });

  test("devuelve null sin fecha de reset o con fecha inválida", () => {
    expect(planPace("five_hour", 50, null, NOW)).toBeNull();
    expect(planPace("five_hour", 50, "no-fecha", NOW)).toBeNull();
  });
});
