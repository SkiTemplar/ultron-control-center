// turnOffFormat.test.ts — cuenta atrás y validación de horas de Turn Off.

import { describe, expect, it } from "vitest";
import { formatCountdown, secondsUntil, validateHours } from "./turnOffFormat";

describe("formatCountdown", () => {
  it("formatea horas, minutos y segundos con dos dígitos", () => {
    expect(formatCountdown(3661)).toBe("01:01:01");
  });

  it("formatea cero como 00:00:00", () => {
    expect(formatCountdown(0)).toBe("00:00:00");
  });

  it("no desborda el formato con más de 24 horas", () => {
    // 25h 00m 00s
    expect(formatCountdown(25 * 3600)).toBe("25:00:00");
  });

  it("trunca segundos fraccionarios en vez de redondear al alza", () => {
    expect(formatCountdown(59.9)).toBe("00:00:59");
  });

  it("clava a 00:00:00 los valores negativos (plazo vencido)", () => {
    expect(formatCountdown(-42)).toBe("00:00:00");
  });

  it("clava a 00:00:00 los valores no finitos", () => {
    expect(formatCountdown(NaN)).toBe("00:00:00");
    expect(formatCountdown(Infinity)).toBe("00:00:00");
  });
});

describe("secondsUntil", () => {
  it("calcula los segundos restantes hasta el deadline", () => {
    expect(secondsUntil(1_000, 400)).toBe(600);
  });

  it("nunca devuelve negativos cuando el deadline ya pasó", () => {
    expect(secondsUntil(1_000, 1_500)).toBe(0);
  });
});

describe("validateHours", () => {
  it("acepta el rango válido, incluidos los límites", () => {
    expect(validateHours(0.1)).toBeNull();
    expect(validateHours(1.5)).toBeNull();
    expect(validateHours(24)).toBeNull();
  });

  it("rechaza por debajo del mínimo", () => {
    expect(validateHours(0.05)).not.toBeNull();
  });

  it("rechaza por encima del máximo", () => {
    expect(validateHours(24.1)).not.toBeNull();
  });

  it("rechaza valores no finitos", () => {
    expect(validateHours(NaN)).not.toBeNull();
  });
});
