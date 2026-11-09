// La vida de Pupus dentro del motor: sucesos que cambian su estado y su
// conducta, sin etiquetas ni iconos nuevos. Reloj inyectado: nada depende de
// la hora a la que se pasen los tests.

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MascotEngine, type MascotSettings } from "../engine";
import { Vitality } from "../vitality";

const W = 1600;
const H = 860;
const NOON = new Date(2026, 9, 14, 12, 0, 0).getTime();
const NIGHT = new Date(2026, 9, 14, 3, 0, 0).getTime();

interface Sim {
  e: MascotEngine;
  step: (seconds: number, cursor?: { x: number; y: number } | ((t: number) => { x: number; y: number }) | null, hovered?: boolean) => void;
}

function sim(startMs = NOON, patch: Partial<MascotSettings> = {}, rand = () => 0.5): Sim {
  const e = new MascotEngine(W, H, { ...DEFAULT_SETTINGS, wander: false, ...patch }, rand);
  let now = startMs;
  e.life = new Vitality(rand, () => now);
  const step: Sim["step"] = (seconds, cursor = null, hovered = false) => {
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
      now += dt * 1000;
      const c = typeof cursor === "function" ? cursor(t) : cursor;
      e.update({ dt, cursor: c, hovered, petHover: hovered, chat: "none" });
    }
  };
  step(3);
  return { e, step };
}

function throwFrom(e: MascotEngine, x: number, y: number, vx: number, vy: number) {
  e.x = x;
  e.y = y;
  e.startDrag(x, y, 0);
  e.dragTo(x + vx * 0.05, y + vy * 0.05, 0.05);
  e.endDrag(false);
}

/** Cursor que llega deprisa desde la derecha hasta pegarse a Pupus. */
const rush = (e: MascotEngine) => {
  const x0 = e.x;
  const y = e.y - e.height / 2;
  return (t: number) => ({ x: x0 + Math.max(60, 500 - t * 1100), y });
};

describe("miedo y recelo", () => {
  it("tres lanzamientos en un minuto lo asustan y luego se aparta del cursor rápido", () => {
    const { e, step } = sim();
    for (let i = 0; i < 3; i++) {
      throwFrom(e, 800, 500, 800, -200);
      step(i < 2 ? 18 : 0.1);
    }
    expect(e.life.state).toBe("asustado");
    step(4);
    expect(["idle", "emote"]).toContain(e.mode);
    const x0 = e.x;
    step(0.6, rush(e));
    expect(e.mode).toBe("walk");
    step(0.5);
    expect(e.x).toBeLessThan(x0);
  });

  it("caso negativo: sin lanzamientos, el mismo cursor no lo espanta", () => {
    const { e, step } = sim();
    step(0.6, rush(e));
    expect(e.mode).not.toBe("walk");
    expect(e.life.state).not.toBe("asustado");
  });
});

describe("sucesos de fuera", () => {
  it("unos tests arreglados le ponen orgulloso en menos de 2 s", () => {
    const { e, step } = sim();
    e.feel("testsArreglados");
    expect(e.emote).toBe("joy");
    step(2);
    expect(e.life.state).toBe("orgulloso");
  });

  it("caso negativo: unos tests en rojo no", () => {
    const { e, step } = sim();
    e.feel("testsRojos", false);
    step(2);
    expect(e.life.state).not.toBe("orgulloso");
    expect(e.emote).toBeNull();
  });

  it("dos fallos seguidos lo ponen gruñón: da la espalda al cursor y sin icono", () => {
    const { e, step } = sim();
    e.feel("testsRojos", false);
    e.feel("testsRojos", false);
    step(2.5);
    expect(e.life.state).toBe("grunon");
    e.facing = -1;
    const cursor = { x: e.x - 30, y: e.y - e.height / 2 };
    step(0.2, cursor, true);
    expect(e.facing).toBe(1);
    expect(e.frame("none").icon).toBeNull();
    expect(e.mode).not.toBe("wave");
  });

  it("caso negativo: contento saluda al pasar el cursor", () => {
    const { e, step } = sim();
    step(0.2, { x: e.x, y: e.y - e.height / 2 }, true);
    expect(e.mode).toBe("wave");
  });
});

describe("hora y contexto", () => {
  it("de noche y con energía a medias, somnoliento", () => {
    const { e, step } = sim(NIGHT);
    e.mood = { ...e.mood, energy: 0.5 };
    step(3);
    expect(e.life.state).toBe("somnoliento");
  });

  it("caso negativo: a mediodía con la misma energía, no", () => {
    const { e, step } = sim(NOON);
    e.mood = { ...e.mood, energy: 0.5 };
    step(3);
    expect(e.life.state).not.toBe("somnoliento");
  });

  function prankAfterCooldown(call: boolean): { x: number; y: number } | null {
    const { e, step } = sim(NOON, {}, () => 0);
    if (call) e.life.setAmbient({ atMs: NOON, activity: "llamada", idleMs: 1000 });
    const near = { x: e.x + 100, y: e.y - 40 };
    step(5, near);
    e.takePrank();
    e.t = 700;
    step(5, near);
    return e.takePrank();
  }

  it("durante una llamada no hay travesuras con el cursor", () => {
    expect(prankAfterCooldown(true)).toBeNull();
  });

  it("caso negativo: sin llamada, la travesura sí llega", () => {
    expect(prankAfterCooldown(false)).not.toBeNull();
  });

  it("volver tras más de 30 min: saludo efusivo (y le despierta)", () => {
    const { e } = sim(NOON, { activities: false });
    e.feel("teVas");
    const later = new Vitality(() => 0.5, () => NOON + 40 * 60_000);
    later.restore(e.life.serialize());
    e.life = later;
    e.mode = "sleep";
    e.feel("vuelves");
    expect(e.emote).toBe("joy");
  });
});

describe("gorro caído", () => {
  it("contra una pared se le cae el gorro y, ya de pie, se lo vuelve a poner", () => {
    const { e, step } = sim();
    e.setHat("santa");
    throwFrom(e, 200, 400, -3200, 0);
    step(0.1);
    expect(e.mode).toBe("splat");
    let f = e.frame("none");
    expect(f.hat).toBeNull();
    expect(f.hatDrop?.hat).toBe("santa");
    step(6);
    f = e.frame("none");
    expect(e.mode).toBe("idle");
    expect(f.hatDrop).toBeNull();
    expect(f.hat).toBe("santa");
  });

  it("caso negativo: espachurrado contra el suelo conserva el gorro", () => {
    const { e, step } = sim();
    e.setHat("santa");
    throwFrom(e, 800, 200, 0, 2500);
    step(0.3);
    expect(e.mode).toBe("splat");
    const f = e.frame("none");
    expect(f.hat).toBe("santa");
    expect(f.hatDrop).toBeNull();
  });
});

describe("memoria guardada", () => {
  it("serializa y recupera sentimientos y sucesos", () => {
    const { e } = sim();
    e.feel("turnoTerminado", false);
    const raw = e.life.serialize();
    expect(raw).not.toMatch(/title|titulo|path|ruta/i);
    const v = new Vitality(() => 0.5, () => NOON + 1000);
    expect(v.restore(raw)).toBe(true);
    expect(v.episodes.map((x) => x.k)).toEqual(["turnoTerminado"]);
    expect(v.feelings.pride).toBeGreaterThan(0.3);
  });

  it("caso negativo: basura o versión desconocida no se cargan", () => {
    const v = new Vitality(() => 0.5, () => NOON);
    expect(v.restore("no json")).toBe(false);
    expect(v.restore(JSON.stringify({ v: 2, feelings: {}, episodes: [] }))).toBe(false);
    expect(v.restore(null)).toBe(false);
    expect(v.episodes).toEqual([]);
  });
});
