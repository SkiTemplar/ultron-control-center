// Lámina de revisión visual de las actividades. Sin PUPUS_LAMINA solo
// comprueba que se genera; con PUPUS_LAMINA=1 la escribe en
// control-center/tmp/pupus-lamina.svg (se abre con `start`).

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MascotEngine } from "../engine";
import { renderFrame } from "../render";
import { Vitality } from "../vitality";
import { RecordingCtx, sheetSvg, type Cell } from "../activities/sheet";
import { CATCH_KINDS } from "../activities/catches";
import { FISH } from "../activities/outdoors";
import type { ActivityId, WorldItemKind } from "../activities/types";
import type { Body } from "../outfits";

// El proyecto no carga los tipos de Node: lo justo para escribir la lámina.
declare const process: { env: Record<string, string | undefined> };
interface NodeFs {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
}

const NOON = new Date(2026, 9, 16, 12, 0, 0);
const NIGHT = new Date(2026, 9, 16, 3, 0, 0);
const SCALE = 6;

function fresh(when: Date): MascotEngine {
  const e = new MascotEngine(1600, 860, { ...DEFAULT_SETTINGS, wander: false, scale: SCALE }, () => 0.5);
  e.now = () => when;
  e.life = new Vitality(() => 0.5, () => when.getTime());
  for (let i = 0; i < 90; i++) e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
  return e;
}

function snap(e: MascotEngine, title: string, outfit: Body | null = null): Cell {
  const ctx = new RecordingCtx();
  renderFrame(ctx as unknown as CanvasRenderingContext2D, e, "none", 1, null, { outfit, pointer: null, calendar: null });
  return { title, shapes: ctx.shapes };
}

const OUTFIT: Partial<Record<ActivityId, Body>> = { conducir: "car", catalejo: "eyepatch", arrastrarse: "vest" };

function activityCells(id: ActivityId, at: number[]): Cell[] {
  const e = fresh(id === "estrellas" ? NIGHT : NOON);
  const outfit = OUTFIT[id] ?? null;
  e.acts.outfit = outfit;
  if (id === "pescar") {
    e.setWindows([{ id: 7, left: 300, top: 400, right: 700, bottom: 700 }]);
    e.ground = { kind: "win", id: 7, winLeft: 300 };
    e.x = 640;
    e.y = 400;
    e.facing = 1;
  }
  e.doActivity(id);
  const t0 = e.t;
  return at.map((tt) => {
    while (e.t - t0 < tt && e.mode === "act") e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
    return snap(e, `${id} ${tt}s`, outfit);
  });
}

function catchCells(): Cell[] {
  return CATCH_KINDS.map((kind, i) => {
    const e = fresh(NOON);
    e.doActivity("pescar");
    const r = e.acts.run!;
    r.data.phase = FISH.show;
    r.data.catch = i;
    r.data.showT = e.t - e.acts.run!.t0;
    return snap(e, `captura: ${kind}`);
  });
}

function itemCells(): Cell[] {
  const kinds: WorldItemKind[] = ["plane", "bubble", "ball", "butterfly", "star"];
  return kinds.map((kind) => {
    const e = fresh(NOON);
    e.x = 1500;
    e.acts.kit.spawn({ kind, x: 400, y: 600, vx: 40, vy: 0, life: 30, stage: 0, seed: 0.3, r: 3 * SCALE });
    const ctx = new RecordingCtx();
    renderFrame(ctx as unknown as CanvasRenderingContext2D, e, "none", 1, null);
    // Solo lo que cae cerca del objeto (fuera queda Pupus).
    return { title: kind, shapes: ctx.shapes.filter((s) => s.x < 900) };
  });
}

function buildSheet(): string {
  const cells: Cell[] = [
    ...activityCells("leer", [1, 2.6]),
    ...activityCells("estrellas", [1, 3.6]),
    ...activityCells("malabares", [0.5, 1.2, 5.6]),
    ...activityCells("pompas", [1.2, 3]),
    ...activityCells("voltereta", [0.1, 0.25, 0.4, 0.55, 0.9]),
    ...activityCells("gimnasia", [0.2, 0.5, 4.3]),
    ...activityCells("barrer", [0.5, 2]),
    ...activityCells("avion", [0.3, 0.8, 1.3, 1.7]),
    ...activityCells("pescar", [0.5, 2.2, 4]),
    ...catchCells(),
    ...activityCells("mariposa", [1, 3]),
    ...activityCells("catalejo", [0.1, 1.5]),
    ...activityCells("arrastrarse", [1, 5.5]),
    ...activityCells("conducir", [0.5, 3]),
    ...itemCells(),
  ];
  return sheetSvg(cells);
}

describe("lámina de revisión", () => {
  it("genera un SVG con todas las escenas", async () => {
    const svg = buildSheet();
    expect(svg.startsWith("<svg")).toBe(true);
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThan(500);
    if (process.env.PUPUS_LAMINA === "1") {
      const mod = "node:fs";
      const fs = (await import(/* @vite-ignore */ mod)) as NodeFs;
      fs.mkdirSync("tmp", { recursive: true });
      fs.writeFileSync("tmp/pupus-lamina.svg", svg);
    }
  });
});
