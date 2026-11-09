import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../engine";
import { effectiveSettings, freeFloorSpans, isInteractive, parkX, quietSettings, strollX } from "../gameMode";
import { DEFAULT_GAMES, gameExeError, normalizeGames, type GameEntry } from "../settings";

describe("silencio de juego: ajustes", () => {
  it("quietSettings apaga paseos, saltos y travesuras sin mutar la entrada", () => {
    const s = { ...DEFAULT_SETTINGS, wander: true, jump: true, cursor_pranks: true };
    const before = JSON.stringify(s);
    const q = quietSettings(s);
    expect(q).not.toBe(s);
    expect(JSON.stringify(s)).toBe(before);
    expect([q.wander, q.jump, q.cursor_pranks]).toEqual([false, false, false]);
    expect(q.climb_windows).toBe(s.climb_windows);
  });

  it("sin silencio, los ajustes del usuario tal cual", () => {
    const s = { ...DEFAULT_SETTINGS };
    expect(effectiveSettings(s, false)).toBe(s);
    expect(effectiveSettings(s, true).wander).toBe(false);
  });

  it("en silencio nunca recibe el ratón", () => {
    expect(isInteractive(true, true)).toBe(false);
    expect(isInteractive(false, true)).toBe(true);
    expect(isInteractive(false, false)).toBe(false);
  });
});

describe("suelo libre alrededor de un juego en ventana", () => {
  const W = 1600;
  const halfW = 32;

  it("juego en el centro: dos tramos, uno a cada lado", () => {
    const spans = freeFloorSpans(W, { left: 500, right: 1100 }, halfW);
    expect(spans).toEqual([
      [32, 468],
      [1132, 1568],
    ]);
  });

  it("juego a lo ancho: no queda sitio", () => {
    expect(freeFloorSpans(W, { left: 20, right: 1590 }, halfW)).toEqual([]);
    expect(parkX(800, [])).toBeNull();
  });

  it("sin juego en este monitor, vale todo el suelo", () => {
    expect(freeFloorSpans(W, null, halfW)).toEqual([[32, 1568]]);
  });

  it("parkX elige el punto libre más cercano", () => {
    const spans = freeFloorSpans(W, { left: 500, right: 1100 }, halfW);
    expect(parkX(600, spans)).toBe(468);
    expect(parkX(1000, spans)).toBe(1132);
    expect(parkX(200, spans)).toBe(200);
  });

  it("el paseo corto no sale de su tramo", () => {
    const spans: [number, number][] = [
      [32, 468],
      [1132, 1568],
    ];
    expect(strollX(450, spans, () => 1)).toBe(468);
    expect(strollX(1140, spans, () => 0)).toBe(1132);
    expect(strollX(800, spans, () => 0.5)).toBeNull();
  });
});

describe("tabla de juegos (mismo criterio que games.rs)", () => {
  it("la tabla por defecto trae los tres juegos con su disfraz", () => {
    expect(DEFAULT_SETTINGS.games.map((g) => [g.exe, g.outfit])).toEqual([
      ["rocketleague.exe", "car"],
      ["sotgame.exe", "pirate"],
      ["cs2.exe", "tactical"],
    ]);
    expect(DEFAULT_SETTINGS.games).not.toBe(DEFAULT_GAMES);
  });

  it("rechaza rutas, nombres sin .exe y vacíos", () => {
    expect(gameExeError("RocketLeague.exe")).toBeNull();
    expect(gameExeError("C:\\Games\\x.exe")).not.toBeNull();
    expect(gameExeError("bin/x.exe")).not.toBeNull();
    expect(gameExeError("juego")).not.toBeNull();
    expect(gameExeError("  ")).not.toBeNull();
  });

  it("normaliza: minúsculas, sin duplicados y disfraz desconocido a none", () => {
    const raw = [
      { exe: " Foo.EXE ", name: " Foo ", outfit: "astronauta" },
      { exe: "foo.exe", name: "otra vez", outfit: "car" },
      { exe: "x", name: "mal", outfit: "car" },
    ] as unknown as GameEntry[];
    expect(normalizeGames(raw)).toEqual([{ exe: "foo.exe", name: "Foo", outfit: "none" }]);
  });
});

describe("guarda: Pupus no hace ruido", () => {
  it("ningún módulo de la mascota crea audio", () => {
    const sources = import.meta.glob("../*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<
      string,
      string
    >;
    const names = Object.keys(sources);
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((f) => /new Audio\(|AudioContext/.test(sources[f]))).toEqual([]);
  });
});
