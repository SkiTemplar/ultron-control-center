// Objetos que dejan las actividades: física pura, sin mutar la entrada.

import { describe, expect, it } from "vitest";
import { stepItems, POP_MARGIN, PLANE_REST_S, type ItemsEnv } from "../activities/worldItems";
import type { WorldItem } from "../activities/types";
import type { Platform } from "../world";

const W = 1600;
const H = 860;

function item(p: Partial<WorldItem>): WorldItem {
  return { id: 1, kind: "plane", x: 100, y: 300, vx: 0, vy: 0, age: 0, life: 40, stage: 0, seed: 0.3, r: 0, x0: 100, landed: false, ...p };
}

function env(p: Partial<ItemsEnv> = {}): ItemsEnv {
  return { cursor: null, plats: [], W, H, ...p };
}

/** Avanza `seconds` y acumula los sucesos. */
function sim(items: WorldItem[], seconds: number, e: ItemsEnv) {
  let cur = items;
  const events = [];
  for (let t = 0; t < seconds; t += 1 / 60) {
    const r = stepItems(cur, 1 / 60, e);
    cur = r.items;
    events.push(...r.events);
  }
  return { items: cur, events };
}

describe("avión de papel", () => {
  it("planea y se posa sobre el borde de una ventana que encuentra debajo", () => {
    const plat: Platform = { id: 3, left: 300, right: 1500, top: 500, winLeft: 300 };
    const { items, events } = sim([item({ vx: 220, vy: -50 })], 8, env({ plats: [plat] }));
    const p = items[0];
    expect(p.landed).toBe(true);
    expect(p.y).toBe(500);
    expect(p.x).toBeGreaterThanOrEqual(300);
    expect(events.filter((e) => e.kind === "planeLanded")).toHaveLength(1);
  });

  it("sin ventanas llega al suelo, reposa y desaparece", () => {
    const { items, events } = sim([item({ vx: 220, vy: -50 })], 12, env());
    expect(items[0].y).toBe(H);
    const landed = events.find((e) => e.kind === "planeLanded");
    expect(landed && landed.kind === "planeLanded" && landed.dist).toBeGreaterThan(100);
    const later = sim(items, PLANE_REST_S + 1, env());
    expect(later.items).toEqual([]);
  });
});

describe("pompas", () => {
  const bubble = item({ kind: "bubble", x: 500, y: 400, r: 12, life: 10 });

  it("revientan si el cursor se acerca a menos de su radio más el margen", () => {
    const r = stepItems([bubble], 1 / 60, env({ cursor: { x: 500 + 12 + POP_MARGIN - 1, y: 400 } }));
    expect(r.items).toEqual([]);
    expect(r.events[0]?.kind).toBe("bubblePop");
  });

  it("caso negativo: con el cursor a radio + 20 no revientan", () => {
    const r = stepItems([bubble], 1 / 60, env({ cursor: { x: 500 + 12 + 20, y: 400 } }));
    expect(r.items).toHaveLength(1);
    expect(r.events).toEqual([]);
  });

  it("suben y se acaban por su cuenta al terminar su vida", () => {
    const { items } = sim([bubble], 11, env());
    expect(items).toEqual([]);
  });
});

describe("pelota y pureza", () => {
  it("la pelota bota y acaba quieta en el suelo", () => {
    const { items } = sim([item({ kind: "ball", vx: 60, vy: -150, life: 6 })], 4, env());
    expect(items[0].y).toBe(H);
    expect(items[0].landed).toBe(true);
  });

  it("stepItems no muta los objetos de entrada", () => {
    const input = Object.freeze([
      Object.freeze(item({ vx: 220 })),
      Object.freeze(item({ id: 2, kind: "bubble", r: 8 })),
      Object.freeze(item({ id: 3, kind: "butterfly" })),
      Object.freeze(item({ id: 4, kind: "star", vx: 400 })),
    ]) as readonly WorldItem[];
    const copy = JSON.stringify(input);
    expect(() => stepItems(input, 0.1, env())).not.toThrow();
    expect(JSON.stringify(input)).toBe(copy);
  });
});
