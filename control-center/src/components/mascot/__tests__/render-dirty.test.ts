import { describe, expect, it } from "vitest";
import { BASE_POSE, drawPet, type Box, type Pose } from "../sprite";
import { DEFAULT_SETTINGS, MascotEngine } from "../engine";
import { CanvasPainter, renderFrame, type Decor } from "../render";
import { CAL_W, drawCalendar } from "../calendarProp";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Contexto 2D falso que apunta cada rectángulo pintado. */
function fakeCtx(width = 4000, height = 3000) {
  const painted: Rect[] = [];
  const cleared: Rect[] = [];
  const ctx = {
    canvas: { width, height },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    fillRect: (x: number, y: number, w: number, h: number) => painted.push({ x, y, w, h }),
    clearRect: (x: number, y: number, w: number, h: number) => cleared.push({ x, y, w, h }),
    beginPath: () => {},
    ellipse: (x: number, y: number, rx: number, ry: number) => painted.push({ x: x - rx, y: y - ry, w: 2 * rx, h: 2 * ry }),
    arc: (x: number, y: number, r: number) => painted.push({ x: x - r, y: y - r, w: 2 * r, h: 2 * r }),
    fill: () => {},
    stroke: () => {},
    moveTo: () => {},
    lineTo: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, painted, cleared };
}

const within = (r: Rect, b: Box, pad = 0) =>
  r.x >= b.x - pad && r.y >= b.y - pad && r.x + r.w <= b.x + b.w + pad && r.y + r.h <= b.y + b.h + pad;

describe("drawPet devuelve una caja que cubre todo lo que pinta", () => {
  const lifts = [-0.35, -0.2, 0, 0.4, 3];
  const breaths = [-0.9, -0.3, 0, 0.5, 0.9];
  for (const lift of lifts) {
    it(`lift ${lift}, S de 4 a 16, mirando a los dos lados`, () => {
      for (let S = 4; S <= 16; S++) {
        for (const breath of breaths) {
          for (const facing of [1, -1] as const) {
            const { ctx, painted } = fakeCtx();
            const pose: Pose = { ...BASE_POSE, lift, breath };
            const box = drawPet(ctx, pose, 500, 800, S, facing);
            const out = painted.filter((r) => !within(r, box));
            expect(out, `S=${S} breath=${breath} facing=${facing}`).toEqual([]);
          }
        }
      }
    });
  }
});

describe("renderFrame y el borrado", () => {
  it("todo lo pintado en un fotograma cae dentro de la zona sucia (+2 px)", () => {
    const e = new MascotEngine(1600, 860, { ...DEFAULT_SETTINGS, wander: false });
    for (let i = 0; i < 120; i++) e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
    for (const dpr of [1, 1.5, 2, 3]) {
      const { ctx, painted } = fakeCtx();
      const d = renderFrame(ctx, e, "none", dpr, null);
      const box = { x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 };
      expect(painted.filter((r) => !within(r, box, 2))).toEqual([]);
    }
  });

  it("si un fotograma revienta, el siguiente borra el lienzo entero", () => {
    const e = new MascotEngine(1600, 860, { ...DEFAULT_SETTINGS, wander: false });
    const { ctx, cleared } = fakeCtx(1000, 700);
    const painter = new CanvasPainter();
    painter.paint(ctx, e, "none", 1);
    const frame = e.frame.bind(e);
    e.frame = () => {
      throw new Error("fallo de dibujo");
    };
    expect(() => painter.paint(ctx, e, "none", 1)).toThrow("fallo de dibujo");
    e.frame = frame;
    cleared.length = 0;
    painter.paint(ctx, e, "none", 1);
    expect(cleared[0]).toEqual({ x: 0, y: 0, w: 1000, h: 700 });
  });

  it("sin fallos borra solo la zona sucia y, de vez en cuando, todo", () => {
    const e = new MascotEngine(1600, 860, { ...DEFAULT_SETTINGS, wander: false });
    const { ctx, cleared } = fakeCtx(1000, 700);
    const painter = new CanvasPainter(10);
    for (let i = 0; i < 20; i++) painter.paint(ctx, e, "none", 1);
    const full = cleared.filter((r) => r.w === 1000 && r.h === 700);
    // El primero (lienzo de estado desconocido) y los fotogramas 10 y 20.
    expect(full.length).toBe(3);
    expect(cleared.length).toBeGreaterThan(full.length);
  });
});

describe("disfraces de juego y flecha", () => {
  const settledEngine = () => {
    const e = new MascotEngine(1600, 860, { ...DEFAULT_SETTINGS, wander: false }, () => 0.5);
    for (let i = 0; i < 120; i++) e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
    return e;
  };

  for (const outfit of ["car", "eyepatch", "vest"] as const) {
    it(`con «${outfit}» todo lo pintado cae en la zona sucia`, () => {
      const e = settledEngine();
      for (const dpr of [1, 1.5, 2]) {
        const { ctx, painted } = fakeCtx();
        const decor: Decor = { outfit, pointer: { x: 400, until: performance.now() + 60_000 } };
        const d = renderFrame(ctx, e, "none", dpr, null, decor);
        const box = { x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 };
        expect(painted.filter((r) => !within(r, box, 2))).toEqual([]);
      }
    });
  }

  it("el coche no pasa del suelo y sus ruedas entran en la caja", () => {
    const e = settledEngine();
    const { ctx, painted } = fakeCtx();
    const d = renderFrame(ctx, e, "none", 1, null, { outfit: "car", pointer: null });
    const fy = Math.round(e.y);
    const S = e.S;
    const wheels = painted.filter((r) => r.w === 3 * S && r.h === 3 * S);
    expect(wheels.length).toBe(2);
    for (const w of wheels) expect(w.y + w.h).toBeLessThanOrEqual(fy);
    expect(Math.max(...wheels.map((w) => w.y + w.h))).toBeLessThanOrEqual(d.y1);
  });

  it("sin gorros activados no hay disfraz (negativo)", () => {
    const e = new MascotEngine(1600, 860, { ...DEFAULT_SETTINGS, wander: false, hats: false }, () => 0.5);
    for (let i = 0; i < 120; i++) e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
    const { ctx, painted } = fakeCtx();
    renderFrame(ctx, e, "none", 1, null, { outfit: "car", pointer: null });
    expect(painted.filter((r) => r.w === 3 * e.S && r.h === 3 * e.S)).toEqual([]);
  });
});

describe("calendario en la mano", () => {
  const settledEngine = () => {
    const e = new MascotEngine(1600, 860, { ...DEFAULT_SETTINGS, wander: false }, () => 0.5);
    for (let i = 0; i < 120; i++) e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
    return e;
  };

  for (const when of ["today", "tomorrow"] as const) {
    it(`«${when}»: cabe en 10S x 9S y la zona sucia lo cubre`, () => {
      const e = settledEngine();
      for (const dpr of [1, 1.5, 2]) {
        const S = Math.max(1, Math.round(e.S * dpr));
        const { ctx: probe, painted: own } = fakeCtx();
        const box = drawCalendar(probe, 500, 800, S, 1, when);
        expect(box.w).toBeLessThanOrEqual(10 * S);
        expect(box.h).toBeLessThanOrEqual(9 * S);
        expect(own.filter((r) => !within(r, box))).toEqual([]);
        const { ctx, painted } = fakeCtx();
        const d = renderFrame(ctx, e, "none", dpr, null, { outfit: null, pointer: null, calendar: { when } });
        const dirty = { x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 };
        expect(painted.filter((r) => !within(r, dirty, 2))).toEqual([]);
      }
    });
  }

  it("con un fichero en brazos no se pinta el calendario (negativo)", () => {
    const e = settledEngine();
    const S = e.S;
    const header = (p: { w: number; h: number }[]) => p.filter((r) => r.w === CAL_W * S && r.h === S);
    const { ctx: a, painted: withCal } = fakeCtx();
    renderFrame(a, e, "none", 1, null, { outfit: null, pointer: null, calendar: { when: "today" } });
    expect(header(withCal).length).toBe(1);
    e.carrying = "informe.pdf";
    const { ctx: b, painted: withFile } = fakeCtx();
    renderFrame(b, e, "none", 1, null, { outfit: null, pointer: null, calendar: { when: "today" } });
    expect(header(withFile)).toEqual([]);
  });
});
