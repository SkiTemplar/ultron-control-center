import { describe, expect, it } from "vitest";
import { acrossEdge, exitsFor, insideEnv, screenAt, shouldHopWithCursor, type Env, type ScreenInfo } from "../screens";

// Disposición real medida el 2026-10-15 (px físicos): portátil a la
// izquierda (150 %), principal en el centro (125 %), otro a la derecha (100 %).
const screen = (x: number, y: number, w: number, h: number, scale: number, current = false): ScreenInfo => ({
  x,
  y,
  width: w,
  height: h,
  work_x: x,
  work_y: y,
  work_width: w,
  work_height: h - 72,
  scale,
  current,
});
const laptop = screen(-2560, 436, 2560, 1600, 1.5);
const main = screen(0, 0, 2560, 1440, 1.25, true);
const right = screen(2560, 162, 1920, 1080, 1);
const env: Env = { origin_x: 0, origin_y: 0, width: 2560, height: 1380, scale_factor: 1.25, supported: true };

describe("exitsFor", () => {
  it("abre los dos bordes laterales solo donde hay monitor al lado (en px CSS)", () => {
    const ex = exitsFor(env, [laptop, main, right]);
    expect(ex.left).toEqual([[436 / 1.25, 1380 / 1.25]]);
    expect(ex.right).toEqual([[162 / 1.25, (162 + 1080) / 1.25]]);
  });

  it("con un solo monitor todos los bordes son pared", () => {
    expect(exitsFor(env, [main])).toEqual({ left: [], right: [] });
  });

  it("un monitor que no está pegado no abre paso", () => {
    const far = screen(3000, 0, 1920, 1080, 1);
    expect(exitsFor(env, [main, far]).right).toEqual([]);
  });
});

describe("puntos y monitores", () => {
  it("el punto al otro lado del borde cae en el monitor vecino", () => {
    const p = acrossEdge(env, "right", 400);
    expect(screenAt([laptop, main, right], p.x, p.y)).toBe(right);
    const q = acrossEdge(env, "left", 600);
    expect(screenAt([laptop, main, right], q.x, q.y)).toBe(laptop);
  });

  it("insideEnv distingue la ventana actual", () => {
    expect(insideEnv(env, 100, 100)).toBe(true);
    expect(insideEnv(env, -1, 100)).toBe(false);
    expect(insideEnv(env, 2560, 100)).toBe(false);
  });
});

describe("shouldHopWithCursor", () => {
  const all = [laptop, main, right];
  const onLaptop: Env = { origin_x: -2560, origin_y: 436, width: 2560, height: 1528, scale_factor: 1.5, supported: true };

  it("conducido por el MCP y con el cursor en otro monitor: se muda con él", () => {
    expect(shouldHopWithCursor("drive", onLaptop, { x: 800, y: 400 }, all)).toBe(true);
    expect(shouldHopWithCursor("drag", onLaptop, { x: 800, y: 400 }, all)).toBe(true);
  });

  it("caso negativo: sin conducir ni arrastrar no se muda aunque el cursor salga", () => {
    expect(shouldHopWithCursor("idle", onLaptop, { x: 800, y: 400 }, all)).toBe(false);
    expect(shouldHopWithCursor("walk", onLaptop, { x: 800, y: 400 }, all)).toBe(false);
  });

  it("caso negativo: cursor dentro de su monitor o fuera de todos, se queda", () => {
    expect(shouldHopWithCursor("drive", env, { x: 800, y: 400 }, all)).toBe(false);
    expect(shouldHopWithCursor("drive", env, { x: 9000, y: 9000 }, all)).toBe(false);
    expect(shouldHopWithCursor("drive", env, null, all)).toBe(false);
  });
});
