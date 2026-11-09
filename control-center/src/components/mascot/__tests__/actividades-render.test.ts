// Pintado de las actividades: la voltereta gira por cuartos sin salirse de
// su caja, y todo lo que pinta una actividad (accesorios, sedal, objetos
// del mundo, coche) cae dentro de la zona sucia que se borra después.

import { describe, expect, it } from "vitest";
import { BASE_POSE, drawPet, rotateRect, type Box, type Pose, type R } from "../sprite";
import { DEFAULT_SETTINGS, MascotEngine } from "../engine";
import { renderFrame, type Decor } from "../render";
import { Vitality } from "../vitality";
import type { ActivityId, WorldItemKind } from "../activities/types";
import type { Body } from "../outfits";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function fakeCtx() {
  const painted: Rect[] = [];
  const ctx = {
    canvas: { width: 4000, height: 3000 },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    fillRect: (x: number, y: number, w: number, h: number) => painted.push({ x, y, w, h }),
    clearRect: () => {},
    beginPath: () => {},
    ellipse: (x: number, y: number, rx: number, ry: number) => painted.push({ x: x - rx, y: y - ry, w: 2 * rx, h: 2 * ry }),
    arc: (x: number, y: number, r: number) => painted.push({ x: x - r, y: y - r, w: 2 * r, h: 2 * r }),
    fill: () => {},
    stroke: () => {},
    moveTo: () => {},
    lineTo: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, painted };
}

const within = (r: Rect, b: Box, pad = 0) =>
  r.x >= b.x - pad && r.y >= b.y - pad && r.x + r.w <= b.x + b.w + pad && r.y + r.h <= b.y + b.h + pad;

describe("giro por cuartos (voltereta)", () => {
  it("cuatro cuartos vuelven al rectángulo de partida y uno cambia ancho por alto", () => {
    const r: R = [-6, -10, 12, 8];
    expect(rotateRect(r, 4)).toEqual(r);
    expect(rotateRect(rotateRect(r, 2), 2)).toEqual(r);
    const q = rotateRect(r, 1);
    expect([q[2], q[3]]).toEqual([8, 12]);
    expect(rotateRect(r, 1)).not.toEqual(r);
  });

  it("drawPet girado devuelve una caja que cubre todo lo que pinta", () => {
    for (const rot of [1, 2, 3] as const) {
      for (const S of [4, 6, 8]) {
        for (const facing of [1, -1] as const) {
          const { ctx, painted } = fakeCtx();
          const pose: Pose = { ...BASE_POSE, rot, lift: 3, legs: "tuck", armL: "down", armR: "down" };
          const box = drawPet(ctx, pose, 500, 800, S, facing);
          expect(painted.filter((p) => !within(p, box)), `rot=${rot} S=${S} f=${facing}`).toEqual([]);
        }
      }
    }
  });
});

const NOON = new Date(2026, 9, 16, 12, 0, 0);
const NIGHT = new Date(2026, 9, 16, 3, 0, 0);

function engineFor(id: ActivityId): { e: MascotEngine; outfit: Body | null } {
  const when = id === "estrellas" ? NIGHT : NOON;
  const e = new MascotEngine(1600, 860, { ...DEFAULT_SETTINGS, wander: false }, () => 0.5);
  e.now = () => when;
  e.life = new Vitality(() => 0.5, () => when.getTime());
  for (let i = 0; i < 90; i++) e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
  const outfit: Body | null = id === "conducir" ? "car" : id === "catalejo" ? "eyepatch" : id === "arrastrarse" ? "vest" : null;
  e.acts.outfit = outfit;
  if (id === "pescar") {
    e.setWindows([{ id: 7, left: 300, top: 400, right: 700, bottom: 700 }]);
    e.ground = { kind: "win", id: 7, winLeft: 300 };
    e.x = 640;
    e.y = 400;
    e.facing = 1;
  }
  return { e, outfit };
}

const ACTS: ActivityId[] = [
  "leer",
  "estrellas",
  "malabares",
  "pompas",
  "voltereta",
  "gimnasia",
  "barrer",
  "avion",
  "pescar",
  "mariposa",
  "catalejo",
  "arrastrarse",
  "conducir",
];

describe("zona sucia de cada actividad", () => {
  for (const id of ACTS) {
    it(`${id}: todo lo pintado cae dentro de la zona sucia`, () => {
      const { e, outfit } = engineFor(id);
      expect(e.doActivity(id)).toBe(true);
      const decor: Decor = { outfit, pointer: null, calendar: null };
      for (let k = 0; k < 24 && e.mode === "act"; k++) {
        for (let i = 0; i < 20; i++) e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
        for (const dpr of [1, 1.5]) {
          const { ctx, painted } = fakeCtx();
          const d = renderFrame(ctx, e, "none", dpr, null, decor);
          const box = { x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 };
          expect(painted.filter((r) => !within(r, box, 2)), `${id} t=${e.t.toFixed(2)} dpr=${dpr} box=${JSON.stringify(box)}`).toEqual([]);
        }
      }
    });
  }

  it("los objetos sueltos (de todo tipo) también ensucian su zona", () => {
    const { e } = engineFor("leer");
    const kinds: WorldItemKind[] = ["plane", "bubble", "ball", "butterfly", "star"];
    kinds.forEach((kind, i) =>
      e.acts.kit.spawn({ kind, x: 200 + i * 150, y: 500, vx: 30, vy: -10, life: 30, stage: 4, seed: 0.4, r: 10 }),
    );
    const { ctx, painted } = fakeCtx();
    const d = renderFrame(ctx, e, "none", 1.25, null);
    const box = { x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 };
    expect(painted.length).toBeGreaterThan(20);
    expect(painted.filter((r) => !within(r, box, 2))).toEqual([]);
  });
});
