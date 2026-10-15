import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MascotEngine, type MascotSettings } from "../engine";
import { coveredAbove, subtractInterval, visiblePlatforms, type WinRect } from "../world";
import { BASE_POSE, spriteRects } from "../sprite";

const W = 1600;
const H = 860;

function engine(patch: Partial<MascotSettings> = {}, rand = () => 0.5) {
  const e = new MascotEngine(W, H, { ...DEFAULT_SETTINGS, wander: false, ...patch }, rand);
  return e;
}

function run(e: MascotEngine, seconds: number, cursor: { x: number; y: number } | null = null) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) e.update({ dt, cursor, hovered: false, chat: "none" });
}

/** Lanza desde (x, y) con velocidad (vx, vy) simulando un arrastre. */
function throwFrom(e: MascotEngine, x: number, y: number, vx: number, vy: number, ctrl = false) {
  // Agarrarla por los pies justo en (x, y): la mascota va donde va el puntero.
  e.x = x;
  e.y = y;
  e.startDrag(x, y, 0);
  e.dragTo(x + vx * 0.05, y + vy * 0.05, 0.05);
  e.endDrag(ctrl);
}

describe("geometría de ventanas", () => {
  it("resta intervalos", () => {
    expect(subtractInterval([[0, 100]], 20, 40)).toEqual([
      [0, 20],
      [40, 100],
    ]);
    expect(subtractInterval([[0, 100]], -10, 200)).toEqual([]);
    expect(subtractInterval([[0, 100]], 200, 300)).toEqual([[0, 100]]);
  });

  it("una ventana encima tapa el borde de la de abajo", () => {
    const wins: WinRect[] = [
      { id: 1, left: 300, top: 100, right: 700, bottom: 600 }, // arriba en Z
      { id: 2, left: 100, top: 300, right: 900, bottom: 800 },
    ];
    const plats = visiblePlatforms(wins, W);
    const top2 = plats.filter((p) => p.id === 2).map((p) => [p.left, p.right]);
    expect(top2).toEqual([
      [100, 300],
      [700, 900],
    ]);
    expect(coveredAbove(wins, 1, 500, 300)).toBe(true);
    expect(coveredAbove(wins, 1, 150, 300)).toBe(false);
  });

  it("ignora ventanas maximizadas (borde pegado al techo)", () => {
    expect(visiblePlatforms([{ id: 1, left: 0, top: 0, right: W, bottom: H }], W)).toEqual([]);
  });
});

describe("física", () => {
  it("cae y se posa en la barra de tareas", () => {
    const e = engine();
    e.summon();
    run(e, 3);
    expect(e.y).toBe(H);
    expect(e.isGrounded()).toBe(true);
  });

  it("al lanzarla fuerte contra la pared se espachurra y luego se marea", () => {
    const e = engine();
    throwFrom(e, 800, 400, -3500, 0);
    let splatted = false;
    for (let i = 0; i < 120 && !splatted; i++) {
      e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
      splatted = e.mode === "splat";
    }
    expect(splatted).toBe(true);
    expect(e.x - e.halfW).toBeCloseTo(0, 5);
    run(e, 4);
    expect(e.isGrounded()).toBe(true);
  });

  it("sin «espachurrarse» rebota en vez de quedarse pegada", () => {
    const e = engine({ splat: false });
    throwFrom(e, 800, 400, -3500, 0);
    const seen = new Set<string>();
    for (let i = 0; i < 240; i++) {
      e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
      seen.add(e.mode);
    }
    expect(seen.has("splat")).toBe(false);
  });

  it("se posa en el borde superior de una ventana y va montada si la mueves", () => {
    const e = engine();
    e.setWindows([{ id: 7, left: 600, top: 500, right: 1100, bottom: 800 }]);
    throwFrom(e, 850, 300, 0, 0);
    run(e, 2);
    expect(e.y).toBe(500);
    expect(e.standingOn()?.id).toBe(7);
    const x0 = e.x;
    e.setWindows([{ id: 7, left: 650, top: 450, right: 1150, bottom: 750 }]);
    run(e, 0.1);
    expect(e.y).toBe(450);
    expect(e.x).toBeCloseTo(x0 + 50, 5);
    // Cerrar la ventana: se cae al suelo.
    e.setWindows([]);
    run(e, 2);
    expect(e.y).toBe(H);
  });

  it("con «subirse a ventanas» apagado las atraviesa", () => {
    const e = engine({ climb_windows: false });
    e.setWindows([{ id: 7, left: 600, top: 500, right: 1100, bottom: 800 }]);
    throwFrom(e, 850, 300, 0, 0);
    run(e, 2);
    expect(e.y).toBe(H);
  });

  it("con ventanas sólidas choca con su lateral; sin ellas lo atraviesa", () => {
    const win = { id: 3, left: 1000, top: 200, right: 1400, bottom: 860 };
    const solid = engine({ collide_windows: true, splat: false, climb_windows: false });
    solid.setWindows([win]);
    throwFrom(solid, 700, 500, 1500, -100);
    let maxX = 0;
    for (let i = 0; i < 90; i++) {
      solid.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
      maxX = Math.max(maxX, solid.x);
    }
    expect(maxX).toBeLessThanOrEqual(win.left - solid.halfW + 1e-6);

    const ghost = engine({ collide_windows: false, climb_windows: false });
    ghost.setWindows([win]);
    throwFrom(ghost, 700, 500, 1500, -100);
    let gx = 0;
    for (let i = 0; i < 90; i++) {
      ghost.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
      gx = Math.max(gx, ghost.x);
    }
    expect(gx).toBeGreaterThan(win.left);
  });

  it("Ctrl al soltar la deja colgada; un clic la suelta", () => {
    const e = engine();
    throwFrom(e, 500, 300, 0, 0, true);
    run(e, 2);
    expect(e.mode).toBe("hang");
    expect(e.y).toBeLessThan(H);
    e.poke();
    run(e, 3);
    expect(e.y).toBe(H);
  });

  it("el salto planificado cae en la ventana objetivo", () => {
    const e = engine();
    run(e, 0.5);
    const target = { id: 9, left: 1000, top: 620, right: 1300, bottom: 860 };
    e.setWindows([target]);
    const j = e.planJump(1150, target.top);
    expect(j).not.toBeNull();
    e.vx = j!.vx;
    e.vy = j!.vy;
    e.ground = null;
    e.mode = "air";
    run(e, 3);
    expect(e.standingOn()?.id).toBe(9);
  });

  it("no planifica saltos imposibles", () => {
    const e = engine();
    expect(e.planJump(e.x - 5000, 100)).toBeNull();
  });

  it("modo conducción: sigue al cursor y al terminar cae", () => {
    const e = engine();
    e.driveStart();
    run(e, 1, { x: 400, y: 200 });
    expect(Math.abs(e.x - (400 + 5 * e.S))).toBeLessThan(2);
    e.driveAction("click", { x: 400, y: 200 });
    expect(e.effects.some((f) => f.kind === "ring")).toBe(true);
    e.driveEnd();
    run(e, 3);
    expect(e.y).toBe(H);
  });

  it("se duerme tras el tiempo configurado y despierta al pasar el ratón", () => {
    const e = engine({ sleep_after_min: 1 });
    run(e, 61);
    expect(e.mode).toBe("sleep");
    e.update({ dt: 1 / 60, cursor: { x: e.x, y: e.y - 10 }, hovered: true, chat: "none" });
    expect(e.mode).toBe("wave");
  });

  it("paseando sola nunca sale de la pantalla", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const e = new MascotEngine(W, H, { ...DEFAULT_SETTINGS, sleep_after_min: 0 }, rand);
    e.setWindows([
      { id: 1, left: 200, top: 400, right: 700, bottom: 860 },
      { id: 2, left: 900, top: 550, right: 1500, bottom: 860 },
    ]);
    for (let i = 0; i < 60 * 120; i++) {
      e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
      expect(e.x).toBeGreaterThanOrEqual(e.halfW - 1e-6);
      expect(e.x).toBeLessThanOrEqual(W - e.halfW + 1e-6);
      expect(e.y).toBeLessThanOrEqual(H + 1e-6);
    }
  });
});

describe("sprite", () => {
  it("la pose base es Clawd: 16×10 (cuerpo 12 + brazos), ojos en las columnas 2 y 9", () => {
    const r = spriteRects(BASE_POSE);
    expect(r.bbox.w).toBe(16);
    expect(r.bbox.h).toBe(10);
    expect(r.eye.map(([x]) => x + 6)).toEqual([2, 9]);
    expect(r.bbox.y + r.bbox.h).toBe(0);
    expect(r.eye.length).toBe(2);
  });

  it("espachurrada contra el suelo es más ancha y más baja", () => {
    const flat = spriteRects({ ...BASE_POSE, sx: 1.5, sy: 0.35, legs: "none" });
    const base = spriteRects(BASE_POSE);
    expect(flat.bbox.h).toBeLessThan(base.bbox.h);
    expect(flat.bbox.w).toBeGreaterThan(base.bbox.w);
  });
});
