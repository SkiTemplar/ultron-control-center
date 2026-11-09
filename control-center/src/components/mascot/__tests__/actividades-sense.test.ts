import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";
import { wantsMusic } from "../useMediaSense";
import { NIGHT_SLEEP_FACTOR, sleepAfterS, yawnsOnWake } from "../nightRest";
import { danceMove } from "../activities/music";

describe("¿se pregunta por la música?", () => {
  it("solo con los dos ajustes encendidos y sin silencio de juego", () => {
    expect(wantsMusic(DEFAULT_SETTINGS, false)).toBe(true);
    expect(wantsMusic(DEFAULT_SETTINGS, true)).toBe(false);
    expect(wantsMusic({ ...DEFAULT_SETTINGS, music_dance: false }, false)).toBe(false);
    expect(wantsMusic({ ...DEFAULT_SETTINGS, activities: false }, false)).toBe(false);
  });

  it("la rutina de baile recorre sus cuatro pasos", () => {
    const moves = new Set<number>();
    for (let t = 0; t < 5; t += 0.05) moves.add(danceMove(t));
    expect([...moves].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("la noche de Pupus (01:00-07:00)", () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 16, h, m, 0);

  it("de noche duerme en la mitad del tiempo y bosteza al despertar", () => {
    expect(sleepAfterS(4, at(1))).toBe(4 * 60 * NIGHT_SLEEP_FACTOR);
    expect(sleepAfterS(4, at(6, 59))).toBe(120);
    expect(yawnsOnWake(at(3))).toBe(true);
  });

  it("caso negativo: a las 00:59 y a las 07:00 cuenta el tiempo entero y no bosteza", () => {
    expect(sleepAfterS(4, at(0, 59))).toBe(240);
    expect(sleepAfterS(4, at(7))).toBe(240);
    expect(yawnsOnWake(at(7))).toBe(false);
    expect(sleepAfterS(0, at(3))).toBe(0);
  });
});
