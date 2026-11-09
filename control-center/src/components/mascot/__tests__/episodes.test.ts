import { describe, expect, it } from "vitest";
import {
  EPISODE_TTL_MS,
  MAX_EPISODES,
  absenceMs,
  countSince,
  deskEpisode,
  isGrumpyStreak,
  isWary,
  memoryBias,
  parseEpisodes,
  remember,
  sessionEpisode,
  streak,
  type Episode,
} from "../episodes";

const MIN = 60_000;
const T0 = 1_792_000_000_000;

describe("memoria de sucesos", () => {
  it("remember no muta la lista original", () => {
    const list: Episode[] = [{ k: "caricia", at: T0 }];
    const next = remember(list, { k: "lanzado", at: T0 + 1 });
    expect(list).toHaveLength(1);
    expect(next).toHaveLength(2);
  });

  it("recorta por número y por antigüedad", () => {
    let list: Episode[] = [];
    for (let i = 0; i < MAX_EPISODES + 10; i++) list = remember(list, { k: "pinchado", at: T0 + i });
    expect(list).toHaveLength(MAX_EPISODES);
    expect(list[0].at).toBe(T0 + 10);
    const later = remember(list, { k: "caricia", at: T0 + EPISODE_TTL_MS + 100 });
    expect(later).toEqual([{ k: "caricia", at: T0 + EPISODE_TTL_MS + 100 }]);
  });

  it("parseEpisodes descarta basura", () => {
    const raw = [{ k: "caricia", at: T0 }, { k: "inventado", at: T0 }, { k: "lanzado" }, null, "x", { k: "vuelves", at: T0, titulo: "secreto" }];
    expect(parseEpisodes(raw)).toEqual([
      { k: "caricia", at: T0 },
      { k: "vuelves", at: T0 },
    ]);
    expect(parseEpisodes({ k: "caricia" })).toEqual([]);
  });

  it("cuenta, rachas y ausencias", () => {
    const list: Episode[] = [
      { k: "testsRojos", at: T0 },
      { k: "pinchado", at: T0 + 1 },
      { k: "testsRojos", at: T0 + 2 },
    ];
    expect(countSince(list, "testsRojos", T0 + 2, 1)).toBe(1);
    expect(streak(list, "testsRojos", ["testsArreglados"])).toBe(2);
    expect(isGrumpyStreak(list)).toBe(true);
    // Caso negativo: un arreglo en medio rompe la racha.
    const fixed = remember(list, { k: "testsArreglados", at: T0 + 3 });
    expect(isGrumpyStreak(remember(fixed, { k: "testsRojos", at: T0 + 4 }))).toBe(false);
    const away: Episode[] = [{ k: "teVas", at: T0 }];
    expect(absenceMs(away, T0 + 40 * MIN)).toBe(40 * MIN);
    expect(absenceMs(remember(away, { k: "vuelves", at: T0 + MIN }), T0 + 40 * MIN)).toBe(0);
  });

  it("tres lanzamientos en 10 min lo dejan receloso; una caricia después lo arregla", () => {
    const throws: Episode[] = [0, 1, 2].map((i) => ({ k: "lanzado", at: T0 + i * MIN }));
    expect(isWary(throws, T0 + 3 * MIN)).toBe(true);
    expect(memoryBias(throws, T0 + 3 * MIN).fear).toBe(0.2);
    expect(isWary(remember(throws, { k: "caricia", at: T0 + 4 * MIN }), T0 + 4 * MIN)).toBe(false);
    // Caso negativo: dos no bastan, ni tres repartidos en una hora.
    expect(isWary(throws.slice(0, 2), T0 + 3 * MIN)).toBe(false);
    expect(isWary(throws, T0 + 60 * MIN)).toBe(false);
  });

  it("acabar una partida larga despierta la curiosidad; una corta no", () => {
    const long: Episode[] = [
      { k: "juegoEmpieza", at: T0 },
      { k: "juegoTermina", at: T0 + 90 * MIN },
    ];
    expect(memoryBias(long, T0 + 91 * MIN).curiosity).toBeGreaterThan(0.3);
    const short: Episode[] = [
      { k: "juegoEmpieza", at: T0 },
      { k: "juegoTermina", at: T0 + 20 * MIN },
    ];
    expect(memoryBias(short, T0 + 21 * MIN).curiosity).toBeUndefined();
  });

  it("traduce los avisos de Sessions y de builds", () => {
    expect(sessionEpisode("turnDone")).toBe("turnoTerminado");
    expect(sessionEpisode("failed")).toBe("sesionFallida");
    expect(sessionEpisode("waiting")).toBe("sesionEspera");
    expect(sessionEpisode("gone")).toBeNull();
    expect(deskEpisode("failed")).toBe("testsRojos");
    expect(deskEpisode("cleared")).toBe("testsArreglados");
  });
});
