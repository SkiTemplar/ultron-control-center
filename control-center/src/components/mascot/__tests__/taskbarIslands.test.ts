import { describe, expect, it } from "vitest";
import { floorTarget, islandOf, islandRects, type TaskbarBar, type TaskbarButton, type TaskbarSnapshot } from "../taskbar";
import { islandWins } from "../useDesktopWindows";

// Medidas reales del 2026-10-27 (px físicos): 2560×1600, barra abajo en y 1528..1600.
const main: TaskbarBar = {
  hwnd: 1,
  primary: true,
  rect: [0, 1528, 2560, 1600],
  monitor: [0, 0, 2560, 1600],
  edge: "bottom",
  auto_hidden: false,
};
const center: [number, number, number, number] = [728, 1533, 1832, 1593];
const tray: [number, number, number, number] = [2116, 1535, 2542, 1590];
const chrome: TaskbarButton = {
  app_id: "Chrome",
  label: "Google Chrome",
  windows: 1,
  pinned: true,
  rect: [1284, 1535, 1350, 1590],
  bar: 1,
};
const snap: TaskbarSnapshot = {
  version: 1,
  taken_ms: 40,
  bars: [main],
  buttons: [chrome],
  islands: [
    { bar: 1, rect: center },
    { bar: 1, rect: tray },
  ],
};

describe("islas de la barra transparente", () => {
  it("solo cuentan las de una barra abajo y visible", () => {
    expect(islandRects(snap)).toEqual([center, tray]);
    // Casos negativos: barra autoocultable o arriba, sin islas y backend antiguo.
    expect(islandRects({ ...snap, bars: [{ ...main, auto_hidden: true }] })).toEqual([]);
    expect(islandRects({ ...snap, bars: [{ ...main, edge: "top" }] })).toEqual([]);
    expect(islandRects({ ...snap, islands: undefined })).toEqual([]);
    expect(islandRects(null)).toEqual([]);
  });

  it("señala de pie sobre la isla, encima del botón y sin flecha", () => {
    const island = islandOf(snap, chrome);
    expect(island).toEqual(center);
    expect(floorTarget(chrome, main, island)).toEqual({ ok: true, x: 1317, y: 1532, arrowX: null });
    // Sin isla, como antes: desde el borde superior de la barra con flecha.
    expect(floorTarget(chrome, main, null)).toEqual({ ok: true, x: 1317, y: 1527, arrowX: 1317 });
    // Un botón fuera de toda isla no tiene isla.
    expect(islandOf(snap, { ...chrome, rect: [300, 1535, 340, 1590] })).toBeNull();
  });

  it("las islas entran como ventanas en px CSS con id negativo", () => {
    const toCss = (x: number, y: number) => ({ x: x / 2, y: y / 2 });
    expect(islandWins(snap, toCss)).toEqual([
      { id: -1, left: 364, top: 766.5, right: 916, bottom: 796.5, isTaskbarIsland: true },
      { id: -2, left: 1058, top: 767.5, right: 1271, bottom: 795, isTaskbarIsland: true },
    ]);
  });
});
