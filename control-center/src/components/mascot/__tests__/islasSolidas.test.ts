import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MascotEngine, type MascotSettings } from "../engine";
import { floorGaps, type WinRect } from "../world";
import { floorSurface, nextHop, surfacesOf, wallRunUp } from "../travel";

// Medidas reales del 2026-10-27 (2560×1600, barra abajo) a escala 2: px CSS.
const W = 1280;
const H = 800;
const center: WinRect = { id: -1, left: 364, top: 766.5, right: 916, bottom: 796.5, isTaskbarIsland: true };
const tray: WinRect = { id: -2, left: 1058, top: 767.5, right: 1271, bottom: 795, isTaskbarIsland: true };
const ISLANDS = [center, tray];

function engine(patch: Partial<MascotSettings> = {}) {
  return new MascotEngine(W, H, { ...DEFAULT_SETTINGS, wander: false, collide_windows: true, ...patch }, () => 0.5);
}

/** En el suelo, ¿el cuerpo asoma delante de alguna isla? */
function inFrontOfIsland(e: MascotEngine, islands: WinRect[]): boolean {
  if (e.ground?.kind !== "floor") return false;
  const hw = e.halfW;
  return islands.some((w) => e.x + hw > w.left + 1 && e.x - hw < w.right - 1);
}

/** Fotogramas de `seconds`; devuelve si en alguno estuvo delante de una isla. */
function run(e: MascotEngine, seconds: number, islands: WinRect[] = ISLANDS): boolean {
  const dt = 1 / 60;
  let seen = false;
  for (let t = 0; t < seconds; t += dt) {
    e.update({ dt, cursor: null, hovered: false, chat: "none" });
    seen ||= inFrontOfIsland(e, islands);
  }
  return seen;
}

/** En el suelo en x, con las islas puestas y la animación de entrada acabada. */
function onFloorAt(x: number, wins: WinRect[] = ISLANDS, patch: Partial<MascotSettings> = {}) {
  const e = engine(patch);
  e.x = x;
  run(e, 2, []);
  e.setWindows(wins);
  return e;
}

describe("islas de la barra: sólidas a ras de suelo", () => {
  it("parten el suelo en tramos", () => {
    expect(floorGaps(ISLANDS, W)).toEqual([
      [0, 364],
      [916, 1058],
      [1271, 1280],
    ]);
    // Caso negativo: una ventana normal no parte el suelo.
    expect(floorGaps([{ ...center, isTaskbarIsland: undefined }], W)).toEqual([[0, W]]);
  });

  it("andando hacia una isla no pasa por delante: salta y se queda encima", () => {
    const e = onFloorAt(200);
    e.strollTo(640);
    const seen = run(e, 6);
    expect(seen).toBe(false);
    expect(e.ground).toMatchObject({ kind: "win", id: -1 });
    expect(e.y).toBeCloseTo(center.top, 0);
  });

  it("caso negativo: sin la marca de isla, una ventana igual se cruza por delante", () => {
    const plain = { ...center, isTaskbarIsland: undefined };
    const e = onFloorAt(200, [plain, { ...tray, isTaskbarIsland: undefined }]);
    e.strollTo(640);
    expect(run(e, 6, [plain])).toBe(true);
    expect(e.ground?.kind).toBe("floor");
  });

  it("sin saltar se para en el borde de la isla", () => {
    const e = onFloorAt(200, ISLANDS, { jump: false });
    e.strollTo(640);
    expect(run(e, 6)).toBe(false);
    expect(e.ground?.kind).toBe("floor");
    expect(e.x + e.halfW).toBeLessThanOrEqual(center.left + 0.5);
  });

  it("soltado delante de una isla, se sube encima", () => {
    const e = onFloorAt(200);
    e.x = 640;
    run(e, 0.1);
    expect(e.ground).toMatchObject({ kind: "win", id: -1 });
    expect(e.y).toBeCloseTo(center.top, 0);
  });

  it("Ctrl+Alt+clic al otro lado de una isla: pasa por encima, no por delante", () => {
    const e = onFloorAt(150);
    e.goTo(990, H - 5);
    const seen = run(e, 10);
    expect(seen).toBe(false);
    expect(e.takeArrival()).toBe(true);
    expect(e.ground?.kind).toBe("floor");
    expect(Math.abs(e.x - 990)).toBeLessThan(2);
  });
});

describe("travel: suelo partido", () => {
  const lim = { hw: 20, maxRise: 70, maxReach: 300 };

  it("de un tramo de suelo a otro se pasa por la isla, no por encima en un salto", () => {
    const gaps = floorGaps(ISLANDS, W);
    const plats = ISLANDS.map((w) => ({ id: w.id, left: w.left, right: w.right, top: w.top, winLeft: w.left }));
    const surfaces = surfacesOf(plats, W, H, gaps);
    const [left, middle] = surfaces;
    const hop = nextHop(middle, left, surfaces, lim);
    expect(hop?.to.id).toBe(-1);
    // Sin islas, el suelo es una sola superficie.
    expect(surfacesOf([], W, H)).toEqual([floorSurface(W, H)]);
  });

  it("la carrerilla crece con la subida y es 0 sin subida", () => {
    expect(wallRunUp(0, 8, 60)).toBe(0);
    const low = wallRunUp(20, 8, 60);
    const high = wallRunUp(40, 8, 60);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
  });
});
